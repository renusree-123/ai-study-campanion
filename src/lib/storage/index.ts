import { createHash } from "node:crypto";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { env } from "../env";
import { AppError } from "../errors";

/**
 * Document storage abstraction.
 *
 * The prototype writes to the local filesystem. The interface is deliberately
 * S3-shaped (put/get/delete by key) so swapping in S3, R2 or Vercel Blob is a
 * new implementation of this interface — see docs/DEPLOYMENT.md for why this
 * matters on ephemeral-filesystem hosts.
 */
export interface StorageAdapter {
  readonly id: string;
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

class LocalStorage implements StorageAdapter {
  readonly id = "local-fs";

  private resolve(key: string): string {
    // Defence in depth: a traversal in the key must never escape the root.
    const root = path.resolve(env().STORAGE_DIR);
    const target = path.resolve(root, key);
    if (!target.startsWith(root + path.sep) && target !== root) {
      throw new AppError("BAD_REQUEST", "Invalid storage key.");
    }
    return target;
  }

  async put(key: string, data: Buffer): Promise<void> {
    const target = this.resolve(key);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, data);
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch {
      throw new AppError("NOT_FOUND", `Stored object ${key} is missing.`);
    }
  }

  async delete(key: string): Promise<void> {
    await unlink(this.resolve(key)).catch(() => {});
  }

  async exists(key: string): Promise<boolean> {
    try {
      await readFile(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }
}

let adapter: StorageAdapter = new LocalStorage();

export function storage(): StorageAdapter {
  return adapter;
}

export function setStorageAdapter(next: StorageAdapter): void {
  adapter = next;
}

/**
 * Storage key for an uploaded material. Namespaced by user so a listing of the
 * bucket cannot mix tenants, and suffixed with a content hash so re-uploading
 * the same file is idempotent.
 */
export function materialKey(userId: string, projectId: string, filename: string, data: Buffer) {
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 16);
  // Defence in depth. `resolve()` already refuses to escape the storage root,
  // but the key itself is also normalised here so it stays safe under a
  // backend (S3, R2) that has no filesystem semantics to protect it: strip
  // every path separator, then collapse dot-runs so no ".." survives at all.
  const safeName = filename
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "")
    .slice(-80) || "upload.pdf";
  return {
    key: `materials/${userId}/${projectId}/${hash}-${safeName}`,
    checksum: hash,
  };
}
