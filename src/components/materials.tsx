"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, Badge, Button, Card, EmptyState, formatRelative } from "./ui";
import { MaterialStatusBadge } from "./learning";

export interface MaterialView {
  id: string;
  filename: string;
  status: string;
  stage: string;
  progress: number;
  pageCount: number;
  chunkCount: number;
  sizeBytes: number;
  summary: string;
  error: string | null;
  usedOcr: boolean;
  createdAt: string;
  processedAt: string | null;
}

const STAGE_LABELS: Record<string, string> = {
  UPLOADED: "Uploaded",
  QUEUED: "Queued",
  READING_CONTENT: "Reading content",
  UNDERSTANDING_STRUCTURE: "Understanding structure",
  EXTRACTING_KNOWLEDGE: "Extracting knowledge",
  CREATING_SEARCHABLE_REPRESENTATION: "Creating searchable representation",
  READY: "Ready",
  FAILED: "Failed",
};

/**
 * Materials panel.
 *
 * Uploads return immediately; processing runs in the background. This polls
 * while anything is in flight and stops as soon as everything settles, so an
 * idle tab makes no requests (PRD §13, §14).
 */
export function MaterialsPanel({
  projectId,
  initial,
}: {
  projectId: string;
  initial: MaterialView[];
}) {
  const router = useRouter();
  const [materials, setMaterials] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const settledRef = useRef(false);

  const inFlight = materials.some((m) => m.status === "QUEUED" || m.status === "PROCESSING");

  const refresh = useCallback(async () => {
    const response = await fetch(`/api/projects/${projectId}/materials`);
    if (!response.ok) return;
    const body = await response.json();
    setMaterials(body.data);
    const stillWorking = body.data.some(
      (m: MaterialView) => m.status === "QUEUED" || m.status === "PROCESSING",
    );
    // Once processing finishes, refresh the server components so concepts,
    // mastery and recommendations on the other tabs reflect the new material.
    if (!stillWorking && !settledRef.current) {
      settledRef.current = true;
      router.refresh();
    }
    if (stillWorking) settledRef.current = false;
  }, [projectId, router]);

  useEffect(() => {
    if (!inFlight) return;
    const timer = setInterval(refresh, 1500);
    return () => clearInterval(timer);
  }, [inFlight, refresh]);

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploading(true);
    setError(null);
    for (const file of Array.from(files)) {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch(`/api/projects/${projectId}/materials`, {
        method: "POST",
        body: form,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        setError(body?.error?.message ?? `Could not upload ${file.name}.`);
        break;
      }
    }
    setUploading(false);
    settledRef.current = false;
    await refresh();
    if (inputRef.current) inputRef.current.value = "";
  }

  async function remove(id: string, filename: string) {
    if (!confirm(`Remove "${filename}"? Its extracted knowledge will be deleted too.`)) return;
    await fetch(`/api/materials/${id}`, { method: "DELETE" });
    await refresh();
    router.refresh();
  }

  async function reprocess(id: string) {
    await fetch(`/api/materials/${id}/reprocess`, { method: "POST" });
    settledRef.current = false;
    await refresh();
  }

  return (
    <div style={{ display: "grid", gap: 16 }}>
      <Card>
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void upload(e.dataTransfer.files);
          }}
          style={{
            border: `1.5px dashed ${dragging ? "var(--accent)" : "var(--border-strong)"}`,
            background: dragging ? "var(--accent-soft)" : "transparent",
            borderRadius: 10,
            padding: "26px 18px",
            textAlign: "center",
            transition: "border-color 120ms ease, background 120ms ease",
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 7 }} aria-hidden="true">📄</div>
          <div style={{ fontSize: 13.5, fontWeight: 590, marginBottom: 3 }}>
            Drop a PDF here, or choose a file
          </div>
          <p style={{ margin: "0 0 13px", fontSize: 12.3, color: "var(--text-muted)" }}>
            Text, tables and diagrams are all read. Pages with no text layer are read visually.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            onChange={(e) => void upload(e.target.files)}
            style={{ display: "none" }}
            id="material-upload"
          />
          <Button
            variant="secondary"
            onClick={() => inputRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? "Uploading…" : "Choose PDF"}
          </Button>
        </div>

        {error ? (
          <div style={{ marginTop: 13 }}>
            <Alert tone="danger">{error}</Alert>
          </div>
        ) : null}
      </Card>

      {materials.length === 0 ? (
        <Card>
          <EmptyState
            icon="📚"
            title="No materials yet"
            body="The tutor answers only from what you upload here. Add a PDF to give it something to teach from."
          />
        </Card>
      ) : (
        <div style={{ display: "grid", gap: 12 }}>
          {materials.map((material) => (
            <Card key={material.id}>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 12,
                  alignItems: "flex-start",
                  flexWrap: "wrap",
                }}
              >
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: 13.5, fontWeight: 600, wordBreak: "break-word" }}>
                      {material.filename}
                    </span>
                    <MaterialStatusBadge status={material.status} stage={material.stage} />
                    {material.usedOcr ? (
                      <Badge tone="info" title="Some pages had no text layer and were read visually.">
                        visually read
                      </Badge>
                    ) : null}
                  </div>
                  <div style={{ fontSize: 11.5, color: "var(--text-subtle)", marginTop: 3 }}>
                    {(material.sizeBytes / 1024).toFixed(0)} KB
                    {material.pageCount > 0 ? ` · ${material.pageCount} pages` : ""}
                    {material.chunkCount > 0 ? ` · ${material.chunkCount} sections indexed` : ""}
                    {" · "}
                    {formatRelative(material.createdAt)}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 7 }}>
                  {material.status === "FAILED" ? (
                    <Button variant="secondary" size="sm" onClick={() => reprocess(material.id)}>
                      Retry
                    </Button>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(material.id, material.filename)}
                  >
                    Remove
                  </Button>
                </div>
              </div>

              {material.status === "PROCESSING" || material.status === "QUEUED" ? (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      fontSize: 11.5,
                      color: "var(--text-muted)",
                      marginBottom: 4,
                    }}
                  >
                    <span>{STAGE_LABELS[material.stage] ?? material.stage}</span>
                    <span>{material.progress}%</span>
                  </div>
                  <div
                    style={{ height: 5, background: "var(--surface-2)", borderRadius: 3, overflow: "hidden" }}
                    role="progressbar"
                    aria-valuenow={material.progress}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <div
                      style={{
                        width: `${Math.max(4, material.progress)}%`,
                        height: "100%",
                        background: "var(--accent)",
                        borderRadius: 3,
                        transition: "width 400ms ease",
                      }}
                    />
                  </div>
                </div>
              ) : null}

              {material.status === "FAILED" && material.error ? (
                <div style={{ marginTop: 12 }}>
                  <Alert tone="danger" title="Could not process this document">
                    {material.error}
                  </Alert>
                </div>
              ) : null}

              {material.summary ? (
                <p
                  style={{
                    margin: "12px 0 0",
                    fontSize: 12.5,
                    color: "var(--text-muted)",
                    lineHeight: 1.6,
                    paddingTop: 11,
                    borderTop: "1px solid var(--border)",
                  }}
                >
                  {material.summary}
                </p>
              ) : null}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
