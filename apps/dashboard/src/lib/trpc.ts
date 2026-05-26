import { createTRPCReact } from "@trpc/react-query";
import type { AppRouter } from "@ai-gateway/admin/router";

export const trpc = createTRPCReact<AppRouter>();
