"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

const LINKS = [
  { href: "/", label: "Home", exact: true },
  { href: "/spaces", label: "Spaces" },
  { href: "/analytics", label: "Analytics" },
];

export function Nav({
  user,
  aiProvider,
}: {
  user: { name: string; email: string; role: string };
  aiProvider: { provider: string; model: string; isLive: boolean };
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);

  const isActive = (href: string, exact?: boolean) =>
    exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);

  async function signOut() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const links = [...LINKS];
  if (user.role === "ADMIN") links.push({ href: "/admin", label: "Admin" });

  return (
    <header
      style={{
        borderBottom: "1px solid var(--border)",
        background: "var(--surface)",
        position: "sticky",
        top: 0,
        zIndex: 30,
      }}
    >
      <div
        style={{
          maxWidth: 1240,
          margin: "0 auto",
          padding: "0 20px",
          display: "flex",
          alignItems: "center",
          gap: 18,
          height: 54,
        }}
      >
        <Link href="/" style={{ fontWeight: 680, fontSize: 14.5, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>
          AI Study Companion
        </Link>

        <nav style={{ display: "flex", gap: 2, flex: 1, overflowX: "auto" }}>
          {links.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              style={{
                padding: "6px 11px",
                borderRadius: 7,
                fontSize: 13,
                fontWeight: 540,
                whiteSpace: "nowrap",
                color: isActive(link.href, link.exact) ? "var(--text)" : "var(--text-muted)",
                background: isActive(link.href, link.exact) ? "var(--surface-2)" : "transparent",
              }}
            >
              {link.label}
            </Link>
          ))}
        </nav>

        <span
          title={
            aiProvider.isLive
              ? `Live AI provider: ${aiProvider.provider} / ${aiProvider.model}`
              : "No AI API key configured. Running the deterministic offline provider: answers are extracted from your own materials."
          }
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11.5,
            color: "var(--text-muted)",
            whiteSpace: "nowrap",
          }}
        >
          <span
            aria-hidden="true"
            style={{
              width: 7,
              height: 7,
              borderRadius: 999,
              background: aiProvider.isLive ? "var(--success)" : "var(--warning)",
            }}
          />
          {aiProvider.isLive ? aiProvider.model : "offline AI"}
        </span>

        <div style={{ position: "relative" }}>
          <button
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            style={{
              width: 30,
              height: 30,
              borderRadius: 999,
              border: "1px solid var(--border-strong)",
              background: "var(--surface-2)",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: 640,
            }}
            title={`${user.name} (${user.email})`}
          >
            {user.name.slice(0, 1).toUpperCase()}
          </button>

          {menuOpen ? (
            <>
              <div
                onClick={() => setMenuOpen(false)}
                style={{ position: "fixed", inset: 0, zIndex: 40 }}
                aria-hidden="true"
              />
              <div
                role="menu"
                style={{
                  position: "absolute",
                  right: 0,
                  top: 38,
                  zIndex: 50,
                  minWidth: 208,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                  borderRadius: 9,
                  boxShadow: "var(--shadow)",
                  padding: 6,
                }}
              >
                <div style={{ padding: "7px 10px", borderBottom: "1px solid var(--border)", marginBottom: 5 }}>
                  <div style={{ fontSize: 12.5, fontWeight: 600 }}>{user.name}</div>
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>{user.email}</div>
                  {user.role === "ADMIN" ? (
                    <div style={{ fontSize: 11, color: "var(--accent)", marginTop: 2 }}>Administrator</div>
                  ) : null}
                </div>
                <button
                  onClick={signOut}
                  role="menuitem"
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    padding: "7px 10px",
                    border: 0,
                    background: "transparent",
                    borderRadius: 6,
                    cursor: "pointer",
                    fontSize: 12.5,
                  }}
                >
                  Sign out
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </header>
  );
}
