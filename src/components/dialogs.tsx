"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Alert, Button, Field, inputStyle } from "./ui";

export function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    // Move focus into the dialog so keyboard users are not left behind it.
    ref.current?.querySelector<HTMLElement>("input, textarea, button")?.focus();
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 100,
        background: "rgba(10,10,14,0.45)",
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        padding: 20,
        overflowY: "auto",
      }}
    >
      <div
        ref={ref}
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          boxShadow: "var(--shadow)",
          width: "100%",
          maxWidth: 460,
          padding: 20,
          marginTop: "8vh",
        }}
      >
        <h2 style={{ margin: "0 0 15px", fontSize: 15.5, fontWeight: 640 }}>{title}</h2>
        {children}
      </div>
    </div>
  );
}

const SPACE_COLORS = ["indigo", "emerald", "amber", "rose", "sky", "violet"] as const;

export function CreateSpaceButton({ variant = "primary" }: { variant?: "primary" | "secondary" }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState<string>("indigo");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await fetch("/api/spaces", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, description, color }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not create the space.");
      return;
    }
    setOpen(false);
    setName("");
    setDescription("");
    router.push(`/spaces/${body.data.id}`);
    router.refresh();
  }

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        New space
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a space">
        <p style={{ margin: "0 0 15px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
          A space is a broad area you want to develop — a skill, a subject, a certification. Focused
          projects live inside it.
        </p>
        <form onSubmit={submit}>
          <Field label="Name" required>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={80}
              placeholder="Machine Learning Foundations"
            />
          </Field>
          <Field label="Description" hint="What does this area cover?">
            <textarea
              style={{ ...inputStyle, minHeight: 66, resize: "vertical" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={500}
              placeholder="Core theory I want to be able to reason about, not just recognise."
            />
          </Field>
          <Field label="Colour">
            <div style={{ display: "flex", gap: 7 }}>
              {SPACE_COLORS.map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => setColor(option)}
                  aria-label={option}
                  aria-pressed={color === option}
                  title={option}
                  style={{
                    width: 26,
                    height: 26,
                    borderRadius: 7,
                    cursor: "pointer",
                    background: `var(--space-${option})`,
                    border:
                      color === option ? "2px solid var(--text)" : "1px solid var(--border-strong)",
                  }}
                />
              ))}
            </div>
          </Field>
          {error ? <div style={{ marginBottom: 13 }}><Alert tone="danger">{error}</Alert></div> : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create space"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}

export function CreateProjectButton({
  spaceId,
  variant = "primary",
}: {
  spaceId: string;
  variant?: "primary" | "secondary";
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [goal, setGoal] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    const response = await fetch("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ spaceId, name, description, goal }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not create the project.");
      return;
    }
    setOpen(false);
    router.push(`/projects/${body.data.id}`);
    router.refresh();
  }

  return (
    <>
      <Button variant={variant} onClick={() => setOpen(true)}>
        New project
      </Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Create a project">
        <p style={{ margin: "0 0 15px", fontSize: 12.5, color: "var(--text-muted)", lineHeight: 1.6 }}>
          A project is one focused learning journey with its own materials, tutor conversations and
          mastery. Nothing is shared with your other projects.
        </p>
        <form onSubmit={submit}>
          <Field label="Project name" required>
            <input
              style={inputStyle}
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={2}
              maxLength={90}
              placeholder="Gradient Descent & Optimisation"
            />
          </Field>
          <Field label="Description">
            <textarea
              style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              maxLength={600}
              placeholder="The optimisation chapter and the exercises that go with it."
            />
          </Field>
          <Field
            label="Learning goal"
            hint="What do you want to be able to do? The tutor uses this to pitch its explanations and to decide what to recommend."
          >
            <textarea
              style={{ ...inputStyle, minHeight: 56, resize: "vertical" }}
              value={goal}
              onChange={(e) => setGoal(e.target.value)}
              maxLength={400}
              placeholder="Be able to derive the update rule from scratch and explain why momentum helps."
            />
          </Field>
          {error ? <div style={{ marginBottom: 13 }}><Alert tone="danger">{error}</Alert></div> : null}
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="submit" disabled={pending}>{pending ? "Creating…" : "Create project"}</Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
