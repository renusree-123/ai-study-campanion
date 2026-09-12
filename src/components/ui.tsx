import type { CSSProperties, ReactNode } from "react";
import Link from "next/link";

/** Shared primitives. Styling is inline against the CSS variables in
 *  globals.css so light/dark swap in one place and nothing hard-codes a hex. */

export function Card({
  children,
  padding = 18,
  style,
  className,
}: {
  children: ReactNode;
  padding?: number;
  style?: CSSProperties;
  className?: string;
}) {
  return (
    <div
      className={className}
      style={{
        background: "var(--surface)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding,
        boxShadow: "var(--shadow-sm)",
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function SectionTitle({
  children,
  action,
  hint,
}: {
  children: ReactNode;
  action?: ReactNode;
  hint?: string;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "baseline",
        justifyContent: "space-between",
        gap: 12,
        marginBottom: 12,
        flexWrap: "wrap",
      }}
    >
      <div>
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 650, letterSpacing: "-0.01em" }}>
          {children}
        </h2>
        {hint ? (
          <p style={{ margin: "3px 0 0", fontSize: 12, color: "var(--text-muted)" }}>{hint}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

type Tone = "default" | "accent" | "success" | "warning" | "danger" | "info";

const TONE_STYLES: Record<Tone, { bg: string; fg: string }> = {
  default: { bg: "var(--surface-2)", fg: "var(--text-muted)" },
  accent: { bg: "var(--accent-soft)", fg: "var(--accent)" },
  success: { bg: "var(--success-soft)", fg: "var(--success)" },
  warning: { bg: "var(--warning-soft)", fg: "var(--warning)" },
  danger: { bg: "var(--danger-soft)", fg: "var(--danger)" },
  info: { bg: "var(--info-soft)", fg: "var(--info)" },
};

export function Badge({
  children,
  tone = "default",
  title,
}: {
  children: ReactNode;
  tone?: Tone;
  title?: string;
}) {
  const style = TONE_STYLES[tone];
  return (
    <span
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        background: style.bg,
        color: style.fg,
        borderRadius: 999,
        padding: "2px 9px",
        fontSize: 11.5,
        fontWeight: 600,
        lineHeight: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function Button({
  children,
  variant = "primary",
  size = "md",
  type = "button",
  disabled,
  onClick,
  href,
  style,
  title,
  full,
}: {
  children: ReactNode;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  type?: "button" | "submit";
  disabled?: boolean;
  onClick?: () => void;
  href?: string;
  style?: CSSProperties;
  title?: string;
  full?: boolean;
}) {
  const palette: Record<string, CSSProperties> = {
    primary: { background: "var(--accent)", color: "var(--accent-text)", border: "1px solid transparent" },
    secondary: { background: "var(--surface)", color: "var(--text)", border: "1px solid var(--border-strong)" },
    ghost: { background: "transparent", color: "var(--text-muted)", border: "1px solid transparent" },
    danger: { background: "var(--danger-soft)", color: "var(--danger)", border: "1px solid transparent" },
  };

  const base: CSSProperties = {
    ...palette[variant],
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 8,
    padding: size === "sm" ? "5px 11px" : "8px 15px",
    fontSize: size === "sm" ? 12.5 : 13.5,
    fontWeight: 560,
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.55 : 1,
    width: full ? "100%" : undefined,
    transition: "background 120ms ease, border-color 120ms ease",
    ...style,
  };

  if (href && !disabled) {
    return (
      <Link href={href} style={base} title={title}>
        {children}
      </Link>
    );
  }
  return (
    <button type={type} disabled={disabled} onClick={onClick} style={base} title={title}>
      {children}
    </button>
  );
}

export function Field({
  label,
  hint,
  children,
  required,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
  required?: boolean;
}) {
  return (
    <label style={{ display: "block", marginBottom: 14 }}>
      <span
        style={{
          display: "block",
          fontSize: 12.5,
          fontWeight: 580,
          marginBottom: 5,
          color: "var(--text)",
        }}
      >
        {label}
        {required ? <span style={{ color: "var(--danger)" }}> *</span> : null}
      </span>
      {children}
      {hint ? (
        <span style={{ display: "block", fontSize: 11.5, color: "var(--text-muted)", marginTop: 4 }}>
          {hint}
        </span>
      ) : null}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  background: "var(--surface)",
  border: "1px solid var(--border-strong)",
  borderRadius: 8,
  padding: "8px 11px",
  fontSize: 13.5,
  outline: "none",
};

export function EmptyState({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: string;
}) {
  return (
    <div
      style={{
        textAlign: "center",
        padding: "34px 20px",
        color: "var(--text-muted)",
      }}
    >
      {icon ? <div style={{ fontSize: 26, marginBottom: 8 }}>{icon}</div> : null}
      <div style={{ fontWeight: 600, color: "var(--text)", fontSize: 13.5 }}>{title}</div>
      {body ? (
        <p style={{ margin: "6px auto 0", fontSize: 12.5, maxWidth: 420, lineHeight: 1.6 }}>{body}</p>
      ) : null}
      {action ? <div style={{ marginTop: 14 }}>{action}</div> : null}
    </div>
  );
}

export function Alert({
  tone = "info",
  title,
  children,
}: {
  tone?: Tone;
  title?: string;
  children: ReactNode;
}) {
  const style = TONE_STYLES[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : undefined}
      style={{
        background: style.bg,
        color: style.fg,
        borderRadius: 8,
        padding: "10px 13px",
        fontSize: 12.8,
        lineHeight: 1.55,
      }}
    >
      {title ? <strong style={{ display: "block", marginBottom: 2 }}>{title}</strong> : null}
      {children}
    </div>
  );
}

export function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div>
      <div
        style={{
          fontSize: 11.5,
          color: "var(--text-muted)",
          fontWeight: 550,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: 24,
          fontWeight: 640,
          letterSpacing: "-0.02em",
          marginTop: 3,
          lineHeight: 1.15,
          color: tone ? TONE_STYLES[tone].fg : "var(--text)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {value}
      </div>
      {sub ? (
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>{sub}</div>
      ) : null}
    </div>
  );
}

export function StatGrid({ children, min = 150 }: { children: ReactNode; min?: number }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(${min}px, 1fr))`,
        gap: 16,
      }}
    >
      {children}
    </div>
  );
}

export function Divider({ margin = 14 }: { margin?: number }) {
  return <hr style={{ border: 0, borderTop: "1px solid var(--border)", margin: `${margin}px 0` }} />;
}

export function KeyValue({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl style={{ margin: 0, display: "grid", gap: 8 }}>
      {items.map((item) => (
        <div key={item.label} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
          <dt style={{ fontSize: 12.5, color: "var(--text-muted)" }}>{item.label}</dt>
          <dd
            style={{
              margin: 0,
              fontSize: 12.5,
              fontWeight: 560,
              textAlign: "right",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function formatPercent(value: number, digits = 0): string {
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatRelative(date: Date | string | null | undefined): string {
  if (!date) return "never";
  const value = typeof date === "string" ? new Date(date) : date;
  const seconds = Math.floor((Date.now() - value.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 2592000) return `${Math.floor(seconds / 86400)}d ago`;
  return value.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 60_000)}m`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}
