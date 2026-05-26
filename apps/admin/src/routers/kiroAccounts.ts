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
import { createHash } from "node:crypto";
import {
  startDeviceAuth,
  pollDeviceAuth,
  deviceResultToTokenFile,
} from "@ai-gateway/shared";
import type {
  DeviceAuthStart,
  DeviceAuthPoll,
  DeviceAuthPollDone,
} from "@ai-gateway/shared";
import { adminProcedure, memberProcedure, router } from "../trpc";

const ACCOUNTS_BASE_DIR =
  process.env.KIRO_ACCOUNTS_DIR ??
  (process.env.NODE_ENV === "production"
    ? "/var/kiro-accounts"
    : join(homedir(), ".kiro-accounts"));

function accountsDir(tenantSlug: string): string {
  const safe = tenantSlug.replace(/[^a-z0-9_-]/gi, "_");
  return join(ACCOUNTS_BASE_DIR, safe);
}

function ensureDir(tenantSlug: string): string {
  const dir = accountsDir(tenantSlug);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return dir;
}

interface TokenFile {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
  profileArn: string;
  authMethod?: string;
  provider?: string;
  addedAt?: string;
  label?: string;
  _chainDead?: boolean;
  _chainDeadAt?: string;
  _chainDeadReason?: string;
}

export interface AccountSummary {
  id: string;
  label?: string;
  provider?: string;
  profileArn: string;
  expiresAt: string;
  expired: boolean;
  addedAt?: string;
  chainDead?: boolean;
  chainDeadAt?: string;
  chainDeadReason?: string;
}

function hashId(profileArn: string, accessToken: string): string {
  return createHash("sha1")
    .update(profileArn + accessToken.slice(0, 32))
    .digest("hex")
    .slice(0, 12);
}

function readToken(path: string): TokenFile {
  return JSON.parse(readFileSync(path, "utf-8")) as TokenFile;
}

function summarize(file: string, tok: TokenFile): AccountSummary {
  const exp = Date.parse(tok.expiresAt);
  return {
    id: basename(file, ".json").replace(/^acc-/, ""),
    label: tok.label,
    provider: tok.provider,
    profileArn: tok.profileArn,
    expiresAt: tok.expiresAt,
    expired: !Number.isFinite(exp) || exp < Date.now(),
    addedAt: tok.addedAt,
    chainDead: tok._chainDead === true,
    chainDeadAt: tok._chainDeadAt,
    chainDeadReason: tok._chainDeadReason,
  };
}

function listAccounts(tenantSlug: string): AccountSummary[] {
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
    .filter((x): x is AccountSummary => x !== null)
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

// ---------------- in-memory device-flow session store ----------------
interface Session {
  start: DeviceAuthStart;
  loginProvider: "Google" | "Github" | "Cognito";
  label?: string;
  tenantSlug: string;
  startedByUserId: string;
  createdAt: number;
  completed?: DeviceAuthPollDone;
  failed?: string;
  abandonedAt?: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL_MS = 10 * 60 * 1000; // 10 minutes

function gcSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL_MS) sessions.delete(id);
  }
}

function saveAccount(
  tenantSlug: string,
  result: DeviceAuthPollDone,
  label?: string,
): AccountSummary {
  const dir = ensureDir(tenantSlug);
  const normalized = deviceResultToTokenFile(result);
  const id = hashId(normalized.profileArn, normalized.accessToken);
  const file: TokenFile = {
    ...normalized,
    label,
    addedAt: new Date().toISOString(),
  };
  const path = join(dir, `acc-${id}.json`);
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
  return summarize(path, file);
}

// ---------------- router ----------------

const ProviderEnum = z.enum(["Google", "Github", "Cognito"]);

export const kiroAccountsRouter = router({
  list: memberProcedure.query(({ ctx }) => {
    return { accounts: listAccounts(ctx.admin.tenantSlug), dir: accountsDir(ctx.admin.tenantSlug) };
  }),

  startDeviceAuth: adminProcedure
    .input(
      z.object({
        loginProvider: ProviderEnum.default("Google"),
        label: z.string().max(64).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      gcSessions();
      const start = await startDeviceAuth(input.loginProvider);
      const session: Session = {
        start,
        loginProvider: input.loginProvider,
        label: input.label,
        tenantSlug: ctx.admin.tenantSlug,
        startedByUserId: ctx.admin.user.id,
        createdAt: Date.now(),
      };
      sessions.set(start.clientId, session);
      return {
        sessionId: start.clientId,
        userCode: start.userCode,
        verificationUri: start.verificationUri,
        verificationUriComplete: start.verificationUriComplete,
        expiresInMs: start.expiresInMilliseconds,
        intervalMs: start.intervalInMilliseconds,
      };
    }),

  pollDeviceAuth: adminProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = sessions.get(input.sessionId);
      if (!session) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "session not found or expired",
        });
      }
      // Sessions are tenant-scoped AND caller-scoped — refuse cross-tenant /
      // cross-user polling.
      if (
        session.tenantSlug !== ctx.admin.tenantSlug ||
        session.startedByUserId !== ctx.admin.user.id
      ) {
        throw new TRPCError({ code: "NOT_FOUND", message: "session not found" });
      }
      // already completed → return cached + save once
      if (session.completed) {
        return { status: "authorized" as const };
      }
      if (session.failed) {
        return { status: session.failed };
      }
      const expiresAt = session.createdAt + session.start.expiresInMilliseconds;
      if (Date.now() > expiresAt) {
        session.failed = "expired_token";
        return { status: "expired_token" };
      }
      let poll: DeviceAuthPoll;
      try {
        poll = await pollDeviceAuth(session.start.clientId, session.start.deviceCode);
      } catch (e) {
        const msg = (e as Error).message;
        throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: msg });
      }
      if (poll.status === "authorized") {
        const done = poll as DeviceAuthPollDone;
        session.completed = done;
        const account = saveAccount(session.tenantSlug, done, session.label);
        sessions.delete(session.start.clientId);
        return { status: "authorized" as const, account };
      }
      if (
        poll.status !== "authorization_pending" &&
        poll.status !== "slow_down"
      ) {
        session.failed = poll.status;
      }
      return { status: poll.status };
    }),

  cancelDeviceAuth: adminProcedure
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
