import type { inferRouterOutputs } from "@trpc/server";
import type {
  AppRouter,
  SnapshotPayload,
  SnapshotProviderView,
  SnapshotKeyView,
} from "@ai-gateway/admin/router";

export type RouterOutput = inferRouterOutputs<AppRouter>;

export type ProviderListItem = RouterOutput["providers"]["list"][number];
export type ProviderItem = RouterOutput["providers"]["get"];
export type ProviderKey = RouterOutput["providerKeys"]["list"][number];

// Re-export the explicit snapshot types so pages can annotate callbacks
// without relying on tRPC's full output inference (which bails to `{}` on
// the deep ConfigRuntime/Drizzle chain).
export type Snapshot = SnapshotPayload;
export type SnapshotProvider = SnapshotProviderView;
export type SnapshotKey = SnapshotKeyView;
