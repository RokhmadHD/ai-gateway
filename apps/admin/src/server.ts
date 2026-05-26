import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { trpcServer } from "@hono/trpc-server";
import pino from "pino";
import { closeDb } from "@ai-gateway/db";
import { appRouter } from "./router";
import { createContext } from "./trpc";
import { closeBus } from "./notifier";
import { handleOAuthCallback } from "./routers/geminiAccounts";
import { auth } from "./auth";
import { startScraperSchedule, stopScraperSchedule } from "./services/scraperJob";

const log = pino({
  level: process.env.LOG_LEVEL ?? "info",
  transport: process.env.PRETTY_LOGS === "1"
    ? { target: "pino-pretty", options: { colorize: true } }
    : undefined,
});

const app = new Hono();
app.use("*", logger());

const corsOrigins = process.env.CORS_ORIGIN?.split(",").map((s) => s.trim()).filter(Boolean) ?? [
  "http://localhost:7790",
  "http://127.0.0.1:7790",
  "http://localhost:3000",
];

// Dev mode: allow all localhost origins for easier development
const isDev = process.env.NODE_ENV !== "production";
const corsConfig = isDev
  ? {
      origin: (origin: string) => origin, // Echo back the origin in dev (allow all)
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      credentials: true,
    }
  : {
      origin: corsOrigins,
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["authorization", "content-type"],
      credentials: true,
    };

// Auth + tRPC share CORS settings. Both need credentialed requests so cookies
// flow from the dashboard origin.
app.use("/api/auth/*", cors(corsConfig));
app.use("/trpc/*", cors(corsConfig));

app.get("/healthz", (c) => c.json({ status: "ok" }));

// Better-auth handler — mounts /api/auth/sign-in, /sign-up, /sign-out,
// /callback/<provider>, /get-session, /update-session, etc.
app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw));


// OAuth loopback callback for Gemini Code Assist login. Browser is redirected
// here by Google after consent. We finalize via handleOAuthCallback (exchange
// code, save token) and render a small HTML page telling the user to close
// the tab. The dashboard polls geminiAccounts.pollOAuth to learn the outcome.
app.get("/oauth/gemini/callback", async (c) => {
  const state = (c.req.query("state") ?? "").replace(/\s+/g, "");
  const code = c.req.query("code") ?? "";
  const errParam = c.req.query("error");
  if (errParam) {
    return c.html(
      htmlPage(
        "Login cancelled",
        `Google returned <code>${escapeHtml(errParam)}</code>. You can close this tab and try again from the dashboard.`,
      ),
      400,
    );
  }
  if (!state || !code) {
    return c.html(htmlPage("Missing parameters", "Expected state and code in callback."), 400);
  }
  const result = await handleOAuthCallback(state, code);
  if (!result.ok) {
    return c.html(htmlPage("Login failed", escapeHtml(result.error)), 400);
  }
  return c.html(
    htmlPage(
      "✓ Login complete",
      `Account <code>${escapeHtml(result.account.email ?? result.account.id)}</code> saved. You can close this tab.`,
    ),
  );
});

function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, sans-serif; max-width: 480px; margin: 80px auto; padding: 0 24px; color: #222; }
  h1 { font-size: 20px; margin-bottom: 8px; }
  code { background: #f3f3f3; padding: 1px 5px; border-radius: 3px; font-size: 13px; }
</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${body}</p></body></html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&"
      ? "&amp;"
      : c === "<"
        ? "&lt;"
        : c === ">"
          ? "&gt;"
          : c === '"'
            ? "&quot;"
            : "&#39;",
  );
}

app.use(
  "/trpc/*",
  trpcServer({
    router: appRouter,
    createContext: (opts) => createContext({ req: opts.req }),
  }),
);

const port = parseInt(process.env.PORT ?? "7780", 10);
const host = process.env.HOST ?? "0.0.0.0";

const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  log.info({ port: info.port, host }, "admin api listening");
});

if (process.env.PROXY_SCRAPER_DISABLED !== "1") {
  const intervalMs = process.env.PROXY_SCRAPER_INTERVAL_MS
    ? Number(process.env.PROXY_SCRAPER_INTERVAL_MS)
    : undefined;
  startScraperSchedule(log, intervalMs);
}

const shutdown = async (signal: string) => {
  log.info({ signal }, "shutting down");
  stopScraperSchedule();
  server.close(() => log.info("http server closed"));
  await closeBus();
  await closeDb();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
