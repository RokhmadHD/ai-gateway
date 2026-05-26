"use client";

import type { ReactNode } from "react";

export function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm bg-(--color-bg-elev) border border-(--color-border) rounded-lg p-6">
        <h1 className="text-lg font-semibold mb-1">{title}</h1>
        {subtitle && (
          <p className="text-sm text-(--color-text-muted) mb-5">{subtitle}</p>
        )}
        {children}
      </div>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-(--color-text-muted)">{label}</span>
      {children}
    </label>
  );
}

export function Divider() {
  return (
    <div className="flex items-center gap-3 my-4 text-[11px] uppercase tracking-wider text-(--color-text-muted)">
      <span className="flex-1 h-px bg-(--color-border)" />
      or
      <span className="flex-1 h-px bg-(--color-border)" />
    </div>
  );
}

export function SocialButton({
  onClick,
  disabled,
  label,
}: {
  onClick: () => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full bg-(--color-bg) border border-(--color-border) rounded py-2 text-sm hover:border-(--color-accent) disabled:opacity-50 transition-colors"
    >
      {label}
    </button>
  );
}
