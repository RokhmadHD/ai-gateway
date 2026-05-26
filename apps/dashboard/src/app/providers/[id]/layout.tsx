"use client";

import { use, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { AuthGate } from "@/components/AuthGate";
import { trpc } from "@/lib/trpc";
import { Badge } from "@/components/ui";

export default function ProviderLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  return (
    <AuthGate>
      <Shell id={id}>{children}</Shell>
    </AuthGate>
  );
}

function Shell({ id, children }: { id: string; children: ReactNode }) {
  const pathname = usePathname();
  const provider = trpc.providers.get.useQuery({ id });

  const isFileBased =
    provider.data?.type === "kiro" || provider.data?.type === "gemini";
  const tabs = [
    { href: `/providers/${id}`, label: "Overview" },
    ...(isFileBased
      ? [{ href: `/providers/${id}/accounts`, label: "Accounts" }]
      : [{ href: `/providers/${id}/keys`, label: "Keys" }]),
    { href: `/providers/${id}/settings`, label: "Settings" },
  ];

  return (
    <>
      <div className="flex items-start justify-between mb-4">
        <div>
          <Link
            href="/providers"
            className="text-xs text-(--color-text-muted) hover:text-(--color-text) inline-flex items-center gap-1 mb-2"
          >
            ← All providers
          </Link>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">
              {provider.data?.name ?? "Provider"}
            </h1>
            {provider.data && (
              <>
                <Badge tone={provider.data.isActive ? "success" : "neutral"}>
                  {provider.data.isActive ? "active" : "off"}
                </Badge>
                <Badge>{provider.data.type}</Badge>
              </>
            )}
          </div>
          {provider.data && (
            <div className="text-xs text-(--color-text-muted) font-mono mt-1">
              {provider.data.baseUrl}
            </div>
          )}
        </div>
      </div>

      <div className="flex border-b border-(--color-border) mb-6 -mx-8 px-8">
        {tabs.map((t) => {
          const active = pathname === t.href;
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
                active
                  ? "border-(--color-accent) text-(--color-text)"
                  : "border-transparent text-(--color-text-muted) hover:text-(--color-text) hover:border-(--color-border)"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>

      {children}
    </>
  );
}
