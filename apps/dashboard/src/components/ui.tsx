import { useEffect, useState, type ReactNode } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`bg-(--color-bg-elev) border border-(--color-border) rounded-lg p-5 ${className}`}
    >
      {children}
    </div>
  );
}

export function Button({
  children,
  variant = "primary",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
}) {
  const base = "px-3 py-1.5 rounded text-sm font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed";
  const styles = {
    primary: "bg-(--color-accent) text-(--color-bg) hover:bg-(--color-accent-hover)",
    secondary: "bg-(--color-bg) border border-(--color-border) hover:bg-(--color-border)/40",
    danger: "bg-(--color-danger) text-(--color-bg) hover:opacity-90",
    ghost: "hover:bg-(--color-border)/40 text-(--color-text-muted) hover:text-(--color-text)",
  }[variant];
  return <button {...props} className={`${base} ${styles} ${props.className ?? ""}`}>{children}</button>;
}

export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "success" | "warning" | "danger";
}) {
  const styles = {
    neutral: "bg-(--color-border)/50 text-(--color-text-muted)",
    success: "bg-(--color-success)/20 text-(--color-success)",
    warning: "bg-(--color-warning)/20 text-(--color-warning)",
    danger: "bg-(--color-danger)/20 text-(--color-danger)",
  }[tone];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${styles}`}
    >
      {children}
    </span>
  );
}

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-accent) w-full ${props.className ?? ""}`}
    />
  );
}

export function SecretInput({
  className = "",
  ...props
}: Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">) {
  const [reveal, setReveal] = useState(false);
  return (
    <div className="relative">
      <input
        {...props}
        type="text"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        data-1p-ignore
        data-lpignore="true"
        data-form-type="other"
        style={{
          WebkitTextSecurity: reveal ? "none" : "disc",
          textSecurity: reveal ? "none" : "disc",
        } as React.CSSProperties}
        className={`bg-(--color-bg) border border-(--color-border) rounded pl-3 pr-10 py-2 text-sm outline-none focus:border-(--color-accent) w-full font-mono tracking-wider placeholder:font-sans placeholder:tracking-normal placeholder:text-(--color-text-muted)/60 ${className}`}
      />
      <button
        type="button"
        onClick={() => setReveal((v) => !v)}
        aria-label={reveal ? "Hide secret" : "Show secret"}
        tabIndex={-1}
        className="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-border)/40 transition-colors"
      >
        {reveal ? <IconEyeOff /> : <IconEye />}
      </button>
    </div>
  );
}

function IconEye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEyeOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );
}

export function Select({ children, ...props }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      className={`bg-(--color-bg) border border-(--color-border) rounded px-3 py-2 text-sm outline-none focus:border-(--color-accent) w-full ${props.className ?? ""}`}
    >
      {children}
    </select>
  );
}

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between mb-6">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {subtitle && <p className="text-sm text-(--color-text-muted) mt-1">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  size = "md",
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  size?: "sm" | "md" | "lg";
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl" }[size];

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className={`w-full ${widths} bg-(--color-bg-elev) border border-(--color-border) rounded-lg shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-(--color-border)">
          <h2 className="font-semibold">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="text-(--color-text-muted) hover:text-(--color-text) text-lg leading-none px-2"
          >
            ×
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}
