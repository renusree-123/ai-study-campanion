import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Loads .env for CLI entrypoints (seed, worker, eval).
 *
 * Next.js loads .env itself, so this is only needed for scripts run under tsx.
 * Written by hand rather than pulling in dotenv: it is fifteen lines, and the
 * dependency would exist solely for developer scripts.
 *
 * Real environment variables always win, so a value exported in the shell or
 * injected by the host is never overwritten by a checked-out .env.
 */
export function loadEnvFile(file = ".env"): void {
  const target = path.resolve(process.cwd(), file);
  if (!existsSync(target)) return;

  for (const rawLine of readFileSync(target, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const separator = line.indexOf("=");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    if (!key || key in process.env) continue;

    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

// Side-effecting import: `import "@/lib/load-env"` at the top of a CLI script.
loadEnvFile();
