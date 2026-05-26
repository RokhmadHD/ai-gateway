"use client";

import { createContext, useContext } from "react";
import { trpc } from "@/lib/trpc";
import { useSession } from "@/lib/auth";

type Membership = {
  id: string;
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  role: "owner" | "admin" | "member" | "viewer";
};

type ActiveTenant = {
  id: string;
  slug: string;
  role: Membership["role"];
};

type User = {
  id: string;
  email: string;
  name: string | null;
};

type AuthCtx = {
  isLoading: boolean;
  isAuthed: boolean;
  user: User | null;
  activeTenant: ActiveTenant | null;
  memberships: Membership[];
  isLegacyAdmin: boolean;
};

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const session = useSession();
  // whoami fetches user + tenant context from the tRPC `me.whoami` procedure
  // (cookie-authenticated). It only runs once we know the better-auth session
  // is present, to avoid 401s on the public pages.
  const whoami = trpc.me.whoami.useQuery(undefined, {
    enabled: !!session.data?.session,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 30_000,
  });

  const isLoading = session.isPending || (!!session.data?.session && whoami.isLoading);
  const value: AuthCtx = {
    isLoading,
    isAuthed: !!whoami.data,
    user: whoami.data?.user ?? null,
    activeTenant: whoami.data?.activeTenant ?? null,
    memberships: whoami.data?.memberships ?? [],
    isLegacyAdmin: whoami.data?.isLegacyAdmin ?? false,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth() must be inside <AuthProvider>");
  return v;
}
