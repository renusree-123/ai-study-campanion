"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Alert, Button, Card, Field, inputStyle } from "./ui";

export function AuthForm({ mode }: { mode: "login" | "register" }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const isRegister = mode === "register";

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/auth/${mode}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(isRegister ? { email, password, name } : { email, password }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body?.error?.message ?? "Something went wrong. Please try again.");
        return;
      }
      // Full navigation so server components pick up the new session cookie.
      router.push("/");
      router.refresh();
    } catch {
      setError("Could not reach the server. Check your connection and try again.");
    } finally {
      setPending(false);
    }
  }

  async function demoLogin(as: "learner" | "admin") {
    setPending(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: as === "admin" ? "admin@demo.dev" : "learner@demo.dev",
          password: "demo-password-123",
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(
          body?.error?.message ??
            "Demo accounts are not available. Run `npm run db:seed` to create them.",
        );
        return;
      }
      router.push(as === "admin" ? "/admin" : "/");
      router.refresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div style={{ textAlign: "center", marginBottom: 22 }}>
        <div style={{ fontSize: 22, fontWeight: 680, letterSpacing: "-0.025em" }}>
          AI Study Companion
        </div>
        <p style={{ margin: "5px 0 0", fontSize: 13, color: "var(--text-muted)" }}>
          Learn from your own materials, and see how you are progressing.
        </p>
      </div>

      <Card padding={22}>
        <h1 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 640 }}>
          {isRegister ? "Create your account" : "Sign in"}
        </h1>

        <form onSubmit={submit}>
          {isRegister ? (
            <Field label="Name" required>
              <input
                style={inputStyle}
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                minLength={2}
                autoComplete="name"
                placeholder="Ada Lovelace"
              />
            </Field>
          ) : null}

          <Field label="Email" required>
            <input
              style={inputStyle}
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="you@example.com"
            />
          </Field>

          <Field
            label="Password"
            required
            hint={isRegister ? "At least 8 characters." : undefined}
          >
            <input
              style={inputStyle}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={isRegister ? 8 : 1}
              autoComplete={isRegister ? "new-password" : "current-password"}
            />
          </Field>

          {error ? (
            <div style={{ marginBottom: 14 }}>
              <Alert tone="danger">{error}</Alert>
            </div>
          ) : null}

          <Button type="submit" disabled={pending} full>
            {pending ? "Please wait…" : isRegister ? "Create account" : "Sign in"}
          </Button>
        </form>

        <p style={{ margin: "16px 0 0", fontSize: 12.5, color: "var(--text-muted)", textAlign: "center" }}>
          {isRegister ? (
            <>
              Already have an account? <Link href="/login" style={{ color: "var(--accent)" }}>Sign in</Link>
            </>
          ) : (
            <>
              New here? <Link href="/register" style={{ color: "var(--accent)" }}>Create an account</Link>
            </>
          )}
        </p>
      </Card>

      <Card padding={16} style={{ marginTop: 14 }}>
        <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 9 }}>
          Reviewing this project? Sign in with a seeded demo account.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="secondary" size="sm" onClick={() => demoLogin("learner")} disabled={pending} full>
            Demo learner
          </Button>
          <Button variant="secondary" size="sm" onClick={() => demoLogin("admin")} disabled={pending} full>
            Demo admin
          </Button>
        </div>
      </Card>
    </>
  );
}
