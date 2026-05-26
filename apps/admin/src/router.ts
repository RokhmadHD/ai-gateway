import { router } from "./trpc";
import { providersRouter } from "./routers/providers";
import { providerKeysRouter } from "./routers/providerKeys";
import { proxiesRouter } from "./routers/proxies";
import { apiKeysRouter } from "./routers/apiKeys";
import { metricsRouter } from "./routers/metrics";
import { metaRouter } from "./routers/meta";
import { kiroAccountsRouter } from "./routers/kiroAccounts";
import { geminiAccountsRouter } from "./routers/geminiAccounts";
import { logsRouter } from "./routers/logs";
import { invitationsRouter } from "./routers/invitations";
import { meRouter } from "./routers/me";

export type { SnapshotPayload, SnapshotProviderView, SnapshotKeyView } from "./routers/meta";

export const appRouter = router({
  providers: providersRouter,
  providerKeys: providerKeysRouter,
  proxies: proxiesRouter,
  apiKeys: apiKeysRouter,
  metrics: metricsRouter,
  meta: metaRouter,
  kiroAccounts: kiroAccountsRouter,
  geminiAccounts: geminiAccountsRouter,
  logs: logsRouter,
  invitations: invitationsRouter,
  me: meRouter,
});

export type AppRouter = typeof appRouter;
