"use client";

import { createAuthClient } from "better-auth/react";

function getBaseURL(): string {
  if (typeof window !== "undefined") {
    const fromEnv = process.env.NEXT_PUBLIC_ADMIN_URL;
    if (fromEnv) return fromEnv;
    if (window.location.port === "" || window.location.port === "80" || window.location.port === "443") {
      return window.location.origin;
    }
    return `${window.location.protocol}//${window.location.hostname}:7780`;
  }
  return process.env.NEXT_PUBLIC_ADMIN_URL ?? "http://localhost:7780";
}

export const authClient = createAuthClient({
  baseURL: getBaseURL(),
});

export const { useSession, signIn, signUp, signOut } = authClient;
