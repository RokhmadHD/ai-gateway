"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useAuth } from "@/app/AuthContext";
import { signOut } from "@/lib/auth";
import { trpc } from "@/lib/trpc";
import { useEffect, useState, type ReactNode } from "react";

type NavItem = {
  href: string;
  label: string;
  icon: ReactNode;
};

const SECTIONS: { title: string; items: readonly NavItem[] }[] = [
  {
    title: "Manage",
    items: [
      { href: "/", label: "Overview", icon: <IconHome /> },
      { href: "/providers", label: "Providers", icon: <IconStack /> },
      { href: "/proxies", label: "Proxies", icon: <IconNetwork /> },
      { href: "/api-keys", label: "API Keys", icon: <IconKey /> },
      { href: "/settings/members", label: "Members", icon: <IconUsers /> },
    ],
  },
  {
    title: "Insights",
    items: [
      { href: "/metrics", label: "Token Metrics", icon: <IconChart /> },
      { href: "/snapshot", label: "Live Snapshot", icon: <IconPulse /> },
      { href: "/logs", label: "Logs", icon: <IconList /> },
    ],
  },
  {
    title: "Help",
    items: [{ href: "/docs", label: "Docs", icon: <IconBook /> }],
  },
];

const AUTH_PATHS = ["/sign-in", "/sign-up", "/accept-invite"];

export function Sidebar() {
  const pathname = usePathname();
  const router = useRouter();
  const { user, activeTenant, memberships, isAuthed } = useAuth();
  const switchTenant = trpc.me.switchTenant.useMutation();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [tenantMenu, setTenantMenu] = useState(false);

  // Hide the chrome entirely on the dedicated auth pages.
  const isAuthPage = AUTH_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  if (isAuthPage || !isAuthed) return null;

  async function onSignOut() {
    await signOut();
    router.replace("/sign-in");
  }

  async function onSwitchTenant(tenantId: string) {
    if (tenantId === activeTenant?.id) {
      setTenantMenu(false);
      return;
    }
    await switchTenant.mutateAsync({ tenantId });
    setTenantMenu(false);
    await utils.invalidate();
  }

  return (
    <>
      {/* mobile top bar */}
      <div className="md:hidden sticky top-0 z-30 flex items-center gap-3 px-4 h-14 bg-(--color-bg-elev) border-b border-(--color-border)">
        <button
          onClick={() => setOpen(true)}
          aria-label="Open menu"
          className="p-1.5 -ml-1.5 rounded text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-border)/40 transition-colors"
        >
          <IconMenu />
        </button>
        <div className="w-7 h-7 rounded-md bg-(--color-accent) flex items-center justify-center text-(--color-bg) font-bold text-sm">
          A
        </div>
        <div className="text-sm font-semibold">AI Gateway</div>
      </div>

      <div
        onClick={() => setOpen(false)}
        className={`md:hidden fixed inset-0 z-40 bg-black/50 transition-opacity ${
          open ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        aria-hidden="true"
      />

      <aside
        className={`
          w-64 shrink-0 border-r border-(--color-border) bg-(--color-bg-elev)
          flex flex-col
          fixed inset-y-0 left-0 z-50 transition-transform duration-200 ease-out
          ${open ? "translate-x-0" : "-translate-x-full"}
          md:static md:translate-x-0
        `}
      >
        <div className="px-5 pt-6 pb-4 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-(--color-accent) flex items-center justify-center text-(--color-bg) font-bold text-base">
            A
          </div>
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">AI Gateway</div>
            <div className="text-[11px] text-(--color-text-muted) leading-tight">control plane</div>
          </div>
          <button
            onClick={() => setOpen(false)}
            aria-label="Close menu"
            className="md:hidden p-1.5 -mr-1.5 rounded text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-border)/40 transition-colors"
          >
            <IconClose />
          </button>
        </div>

        {/* tenant switcher */}
        {activeTenant && (
          <div className="px-3 pb-4 relative">
            <button
              onClick={() => memberships.length > 1 && setTenantMenu((v) => !v)}
              className={`w-full text-left px-3 py-2 rounded-md border border-(--color-border) bg-(--color-bg) flex items-center gap-2 ${
                memberships.length > 1 ? "hover:border-(--color-accent)" : "cursor-default"
              }`}
            >
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wider text-(--color-text-muted)">Workspace</div>
                <div className="text-sm truncate" title={activeTenant.slug}>
                  {memberships.find((m) => m.tenantId === activeTenant.id)?.tenantName ?? activeTenant.slug}
                </div>
              </div>
              <div className="text-[10px] uppercase tracking-wider text-(--color-accent)">{activeTenant.role}</div>
              {memberships.length > 1 && (
                <span className="text-(--color-text-muted)">{tenantMenu ? "▴" : "▾"}</span>
              )}
            </button>
            {tenantMenu && (
              <div className="absolute left-3 right-3 mt-1 z-10 bg-(--color-bg-elev) border border-(--color-border) rounded-md shadow-lg overflow-hidden">
                {memberships.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => onSwitchTenant(m.tenantId)}
                    className={`w-full text-left px-3 py-2 text-sm hover:bg-(--color-border)/40 flex items-center justify-between ${
                      m.tenantId === activeTenant.id ? "text-(--color-accent)" : ""
                    }`}
                  >
                    <span className="truncate">{m.tenantName}</span>
                    <span className="text-[10px] uppercase tracking-wider text-(--color-text-muted) ml-2">
                      {m.role}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <nav className="flex-1 px-3 flex flex-col gap-5 overflow-y-auto">
          {SECTIONS.map((section) => (
            <div key={section.title}>
              <div className="px-3 mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-(--color-text-muted)/80">
                {section.title}
              </div>
              <div className="flex flex-col gap-0.5">
                {section.items.map((item) => {
                  const active =
                    pathname === item.href ||
                    (item.href !== "/" && pathname.startsWith(item.href));
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      className={`group relative flex items-center gap-2.5 px-3 py-2 rounded-md text-sm transition-colors ${
                        active
                          ? "bg-(--color-accent)/15 text-(--color-text) font-medium"
                          : "text-(--color-text-muted) hover:bg-(--color-border)/40 hover:text-(--color-text)"
                      }`}
                    >
                      {active && (
                        <span className="absolute left-0 top-1.5 bottom-1.5 w-0.5 rounded-r bg-(--color-accent)" />
                      )}
                      <span
                        className={`shrink-0 ${active ? "text-(--color-accent)" : "text-(--color-text-muted) group-hover:text-(--color-text)"}`}
                      >
                        {item.icon}
                      </span>
                      <span>{item.label}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        <div className="border-t border-(--color-border) px-5 py-4 text-[11px] text-(--color-text-muted) flex flex-col gap-2">
          {user && (
            <div className="text-(--color-text) text-xs truncate" title={user.email}>
              {user.name || user.email}
            </div>
          )}
          <button
            onClick={onSignOut}
            className="flex items-center gap-2 px-2 py-1.5 -mx-2 rounded text-[12px] text-(--color-text-muted) hover:text-(--color-danger) hover:bg-(--color-danger)/10 transition-colors"
          >
            <IconLogout />
            <span>Sign out</span>
          </button>
        </div>
      </aside>
    </>
  );
}

function IconHome() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12 12 3l9 9" />
      <path d="M5 10v10h14V10" />
    </svg>
  );
}

function IconStack() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m12 3 9 5-9 5-9-5 9-5z" />
      <path d="m3 13 9 5 9-5" />
      <path d="m3 18 9 5 9-5" />
    </svg>
  );
}

function IconPulse() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l3-8 4 16 3-8h4" />
    </svg>
  );
}

function IconKey() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="15" r="4" />
      <path d="m10.85 12.15 7.9-7.9" />
      <path d="m18 5 3 3" />
      <path d="m15 8 3 3" />
    </svg>
  );
}

function IconChart() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 3v18h18" />
      <path d="M7 14l4-4 4 4 5-5" />
    </svg>
  );
}

function IconLogout() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}

function IconMenu() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function IconClose() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function IconBook() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4v16a2 2 0 0 0 2 2h14V4H6a2 2 0 0 0-2 2z" />
      <path d="M8 4v18" />
    </svg>
  );
}

function IconList() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  );
}

function IconUsers() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconNetwork() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="6" rx="1" />
      <rect x="2" y="16" width="6" height="6" rx="1" />
      <rect x="16" y="16" width="6" height="6" rx="1" />
      <path d="M12 8v4" />
      <path d="M12 12H5v4" />
      <path d="M12 12h7v4" />
    </svg>
  );
}
