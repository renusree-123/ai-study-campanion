import type { ReactNode } from "react";

/** Simple, accessible data table. Scrolls horizontally rather than overflowing. */
export function Table({
  columns,
  children,
  empty,
}: {
  columns: { key: string; label: string; align?: "left" | "right"; width?: number }[];
  children: ReactNode;
  empty?: string;
}) {
  const hasRows = Array.isArray(children) ? children.length > 0 : Boolean(children);
  if (!hasRows && empty) {
    return (
      <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0, padding: "12px 0" }}>
        {empty}
      </p>
    );
  }

  return (
    <div style={{ overflowX: "auto", margin: "0 -4px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  textAlign: column.align ?? "left",
                  padding: "7px 10px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 570,
                  fontSize: 11.5,
                  whiteSpace: "nowrap",
                  width: column.width,
                }}
              >
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({
  children,
  align = "left",
  mono,
  muted,
  nowrap,
}: {
  children: ReactNode;
  align?: "left" | "right";
  mono?: boolean;
  muted?: boolean;
  nowrap?: boolean;
}) {
  return (
    <td
      style={{
        textAlign: align,
        padding: "8px 10px",
        borderBottom: "1px solid var(--border)",
        color: muted ? "var(--text-muted)" : "var(--text)",
        fontFamily: mono ? "var(--font-mono)" : undefined,
        fontVariantNumeric: align === "right" ? "tabular-nums" : undefined,
        whiteSpace: nowrap ? "nowrap" : undefined,
      }}
    >
      {children}
    </td>
  );
}

export function Tr({ children }: { children: ReactNode }) {
  return <tr>{children}</tr>;
}
