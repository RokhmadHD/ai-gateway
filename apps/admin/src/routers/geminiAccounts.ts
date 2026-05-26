import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  readFileSync,
  writeFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { homedir } from "node:os";
import { resolve, join, basename } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { adminProcedure, memberProcedure, router } from "../trpc";

const ACCOUNTS_BASE_DIR =
  process.env.GEMINI_ACCOUNTS_DIR ??
  (process.env.NODE_ENV === "production"
    ? "/var/gemini-accounts"
    : join(homedir(), ".gemini-accounts"));

function accountsDir(tenantSlug: string): string {
  const safe = tenantSlug.replace(/[^a-z0-9_-]/gi, "_");
  return join(ACCOUNTS_BASE_DIR, safe);
}

// Mirror of GeminiProvider constants. Duplicated here to avoid pulling the
// proxy app as a workspace dep into admin.
export const GEMINI_OAUTH_CLIENT_ID =
  process.env.GEMINI_OAUTH_CLIENT_ID || "";
export const GEMINI_OAUTH_CLIENT_SECRET =
  process.env.GEMINI_OAUTH_CLIENT_SECRET || "";
export const GEMINI_OAUTH_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
];
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

function ensureDir(tenantSlug: string): string {
  const dir = accountsDir(tenantSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

interface TokenFile {
  access_token: string;
  refresh_token: string;
  expiry_date: number;
  scope?: string;
  token_type?: string;
  id_token?: string;
  cloudaicompanion_project?: string;
  label?: string;
  email?: string;
  added_at?: string;
  _chainDead?: boolean;
  _chainDeadAt?: string;
  _chainDeadReason?: string;
}

export interface GeminiAccountSummary {
  id: string;
  label?: string;
  email?: string;
  project?: string;
  expiresAt: string;
  expired: boolean;
  addedAt?: string;
  chainDead?: boolean;
  chainDeadAt?: string;
  chainDeadReason?: string;
}

function readToken(path: string): TokenFile {
  return JSON.parse(readFileSync(path, "utf-8")) as TokenFile;
}

function summarize(file: string, tok: TokenFile): GeminiAccountSummary {
  return {
    id: basename(file, ".json").replace(/^acc-/, ""),
    label: tok.label,
    email: tok.email,
    project: tok.cloudaicompanion_project,
    expiresAt: new Date(tok.expiry_date).toISOString(),
    expired: !Number.isFinite(tok.expiry_date) || tok.expiry_date < Date.now(),
    addedAt: tok.added_at,
    chainDead: tok._chainDead === true,
    chainDeadAt: tok._chainDeadAt,
    chainDeadReason: tok._chainDeadReason,
  };
}

function listAccounts(tenantSlug: string): GeminiAccountSummary[] {
  const dir = ensureDir(tenantSlug);
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => join(dir, f))
    .filter((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    })
    .map((p) => {
      try {
        return summarize(p, readToken(p));
      } catch {
        return null;
      }
    })
    .filter((x): x is GeminiAccountSummary => x !== null)
    .sort((a, b) => (a.addedAt ?? "").localeCompare(b.addedAt ?? ""));
}

function findAccountPath(tenantSlug: string, id: string): string {
  const dir = ensureDir(tenantSlug);
  const path = join(dir, `acc-${id}.json`);
  if (!existsSync(path)) {
    throw new TRPCError({ code: "NOT_FOUND", message: `account ${id} not found` });
  }
  return resolve(path);
}

// ---------------- OAuth loopback session store ----------------

interface Session {
  state: string;
  redirectUri: string;
  label?: string;
  tenantSlug: string;
  // Caller who initiated the OAuth — recorded for audit, also used to enforce
  // that pollOAuth comes from the same logged-in user. Callback itself can't
  // check auth (Google redirects unauthenticated), so binding is via the
  // opaque random `state` token.
  startedByUserId: string;
  createdAt: number;
  /** Set when the browser callback completes */
  completed?: GeminiAccountSummary;
  failed?: string;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 10 * 60 * 1000;

function gcSessions(): void {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

export function findSessionByState(state: string): Session | undefined {
  for (const s of sessions.values()) {
    if (s.state === state) return s;
  }
  return undefined;
}

function callbackBaseUrl(): string {
  // The redirect_uri Google sees. Must be a loopback IP (127.0.0.1) per OAuth
  // policy. Port matches the admin's published port; configurable so dashboard
  // can be served at a non-default port.
  return (
    process.env.GEMINI_OAUTH_CALLBACK_BASE ??
    `http://127.0.0.1:${process.env.PORT ?? "7780"}`
  );
}

function buildAuthUrl(redirectUri: string, state: string): string {
  // Google pre-validates query. Must use %20 (encodeURIComponent) for scope
  // separator, NOT + (URLSearchParams default). Mirror the official gemini-cli.
  const q = (k: string, v: string) => `${k}=${encodeURIComponent(v)}`;
  return (
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    [
      q("redirect_uri", redirectUri),
      q("access_type", "offline"),
      q("scope", GEMINI_OAUTH_SCOPES.join(" ")),
      q("state", state),
      q("response_type", "code"),
      q("client_id", GEMINI_OAUTH_CLIENT_ID),
    ].join("&")
  );
}

async function exchangeCode(code: string, redirectUri: string): Promise<{
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  id_token?: string;
}> {
  const body = new URLSearchParams({
    code,
    client_id: GEMINI_OAUTH_CLIENT_ID,
    client_secret: GEMINI_OAUTH_CLIENT_SECRET,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  const res = await fetch(OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}: ${await res.text()}`);
  return (await res.json()) as Awaited<ReturnType<typeof exchangeCode>>;
}

async function fetchUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const res = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return undefined;
    const j = (await res.json()) as { email?: string };
    return j.email;
  } catch {
    return undefined;
  }
}

function saveToken(tenantSlug: string, token: TokenFile): GeminiAccountSummary {
  const dir = ensureDir(tenantSlug);
  const id = createHash("sha1")
    .update(token.access_token.slice(0, 64))
    .digest("hex")
    .slice(0, 12);
  const path = join(dir, `acc-${id}.json`);
  writeFileSync(path, JSON.stringify(token, null, 2), { mode: 0o600 });
  return summarize(path, token);
}

/**
 * Called by the Hono HTTP handler at /oauth/gemini/callback. Performs the
 * code exchange, saves the token file, and marks the session as completed so
 * the dashboard's pollOAuth picks it up.
 */
export async function handleOAuthCallback(
  state: string,
  code: string,
): Promise<{ ok: true; account: GeminiAccountSummary } | { ok: false; error: string }> {
  const session = findSessionByState(state);
  if (!session) return { ok: false, error: "session not found or expired" };
  if (session.completed) return { ok: true, account: session.completed };
  try {
    const tok = await exchangeCode(code, session.redirectUri);
    const email = await fetchUserEmail(tok.access_token);
    const file: TokenFile = {
      access_token: tok.access_token,
      refresh_token: tok.refresh_token,
      scope: tok.scope,
      token_type: tok.token_type,
      id_token: tok.id_token,
      expiry_date: Date.now() + tok.expires_in * 1000,
      email,
      label: session.label,
      added_at: new Date().toISOString(),
    };
    const account = saveToken(session.tenantSlug, file);
    session.completed = account;
    return { ok: true, account };
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    session.failed = msg;
    return { ok: false, error: msg };
  }
}

// ---------------- router ----------------

export const geminiAccountsRouter = router({
  list: memberProcedure.query(({ ctx }) => {
    return {
      accounts: listAccounts(ctx.admin.tenantSlug),
      dir: accountsDir(ctx.admin.tenantSlug),
    };
  }),

  startOAuth: adminProcedure
    .input(z.object({ label: z.string().max(64).optional() }))
    .mutation(({ ctx, input }) => {
      gcSessions();
      const state = randomBytes(32).toString("hex");
      const redirectUri = `${callbackBaseUrl()}/oauth/gemini/callback`;
      sessions.set(state, {
        state,
        redirectUri,
        label: input.label,
        tenantSlug: ctx.admin.tenantSlug,
        startedByUserId: ctx.admin.user.id,
        createdAt: Date.now(),
      });
      return {
        sessionId: state,
        authUrl: buildAuthUrl(redirectUri, state),
        redirectUri,
        expiresInMs: SESSION_TTL_MS,
      };
    }),

  pollOAuth: adminProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ ctx, input }) => {
      const session = sessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "session not found or expired",
        });
      }
      // Tenant scope AND caller match — even a co-admin of the same tenant
      // can't poll someone else's OAuth flow.
      if (
        session.tenantSlug !== ctx.admin.tenantSlug ||
        session.startedByUserId !== ctx.admin.user.id
      ) {
        throw new TRPCError({ code: "NOT_FOUND", message: "session not found" });
      }
      if (session.completed) {
        sessions.delete(session.state);
        return { status: "authorized" as const, account: session.completed };
      }
      if (session.failed) {
        return { status: "failed" as const, error: session.failed };
      }
      if (Date.now() - session.createdAt > SESSION_TTL_MS) {
        sessions.delete(session.state);
        return { status: "expired" as const };
      }
      return { status: "pending" as const };
    }),

  cancelOAuth: adminProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(({ ctx, input }) => {
      const session = sessions.get(input.sessionId);
      if (session && session.tenantSlug === ctx.admin.tenantSlug) {
        sessions.delete(input.sessionId);
      }
      return { ok: true };
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => {
      const path = findAccountPath(ctx.admin.tenantSlug, input.id);
      unlinkSync(path);
      return { ok: true, id: input.id };
    }),

  rename: adminProcedure
    .input(z.object({ id: z.string(), label: z.string().max(64) }))
    .mutation(({ ctx, input }) => {
      const path = findAccountPath(ctx.admin.tenantSlug, input.id);
      const tok = readToken(path);
      tok.label = input.label;
      writeFileSync(path, JSON.stringify(tok, null, 2), { mode: 0o600 });
      return { ok: true, id: input.id, label: input.label };
    }),
});
