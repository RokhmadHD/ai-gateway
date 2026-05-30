"use client";

import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { trpc } from "@/lib/trpc";
import { AuthProvider } from "./AuthContext";

function getAdminUrl(): string {
  if (typeof window !== "undefined") {
    const fromEnv = process.env.NEXT_PUBLIC_ADMIN_URL;
    if (fromEnv) return `${fromEnv}/trpc`;
    if (
      window.location.port === "" ||
      window.location.port === "80" ||
      window.location.port === "443" ||
      window.location.port === "7782"
    ) {
      return `${window.location.origin}/trpc`;
    }
    return `${window.location.protocol}//${window.location.hostname}:7780/trpc`;
  }
  return `${process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:7780"}/trpc`;
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { staleTime: 5_000, refetchOnWindowFocus: false } },
      }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      links: [
        httpBatchLink({
          url: getAdminUrl(),
          // Cookie-based auth: every tRPC request must send the better-auth
          // session cookie. The admin server's CORS config allows credentials
          // from CORS_ORIGIN; no bearer header anymore.
          fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
        }),
      ],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>{children}</AuthProvider>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
