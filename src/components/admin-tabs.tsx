"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/admin", label: "Overview", exact: true },
  { href: "/admin/users", label: "Users" },
  { href: "/admin/spaces", label: "Spaces" },
  { href: "/admin/projects", label: "Projects" },
  { href: "/admin/activity", label: "Activity" },
  { href: "/admin/analytics", label: "Learning analytics" },
  { href: "/admin/ai", label: "AI usage" },
  { href: "/admin/evaluation", label: "AI evaluation" },
  { href: "/admin/health", label: "System health" },
];

export function AdminTabs() {
  const pathname = usePathname();
  return (
    <nav style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border)", overflowX: "auto" }}>
      {TABS.map((tab) => {
        const active = tab.exact ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            style={{
              padding: "8px 12px",
              fontSize: 12.8,
              fontWeight: 545,
              whiteSpace: "nowrap",
              color: active ? "var(--text)" : "var(--text-muted)",
              borderBottom: `2px solid ${active ? "var(--accent)" : "transparent"}`,
              marginBottom: -1,
            }}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
