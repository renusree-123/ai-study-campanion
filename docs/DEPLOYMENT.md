# Deployment

## Local

```bash
npm install
cp .env.example .env
npm run setup      # prisma generate + db push + seed
npm run dev        # http://localhost:3000, worker in-process
```

No database server, no Docker, no API key required.

---

## Environment variables

| Variable | Required | Default | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | yes | `file:./dev.db` | SQLite path or Postgres URL |
| `AUTH_SECRET` | **in production** | dev default | `openssl rand -base64 48`. Boot fails if left at the default in production. |
| `AUTH_COOKIE_NAME` | no | `asc_session` | |
| `AUTH_SESSION_TTL_HOURS` | no | `168` | |
| `ALLOW_REGISTRATION` | no | `true` | Set `false` to lock a demo to seeded accounts |
| `ANTHROPIC_API_KEY` | no | — | Without it, the offline provider runs |
| `AI_PROVIDER` | no | `auto` | `auto` \| `anthropic` \| `offline` |
| `AI_MODEL` | no | `claude-opus-5` | |
| `AI_FALLBACK_MODEL` | no | `claude-sonnet-5` | Tried once before the offline provider |
| `AI_TIMEOUT_MS` | no | `90000` | Per attempt |
| `AI_MAX_RETRIES` | no | `2` | Primary provider only |
| `AI_DAILY_BUDGET_USD` | no | `0` (off) | Per-user daily spend cap |
| `STORAGE_DIR` | no | `./storage` | Local storage adapter root |
| `MAX_UPLOAD_MB` | no | `20` | |
| `WORKER_IN_PROCESS` | no | `true` | `false` when running a separate worker |
| `WORKER_CONCURRENCY` | no | `2` | |
| `WORKER_POLL_MS` | no | `1000` | |
| `LOG_LEVEL` | no | `info` | `debug` \| `info` \| `warn` \| `error` |

Never commit `.env`. It is gitignored; `.env.example` is the template.

---

## Production checklist

1. **Set a real `AUTH_SECRET`.** The application refuses to boot in production
   with the development default, and refuses to sign a session with it.
2. **Move to Postgres** (below) if you expect concurrent users.
3. **Move to object storage** if the host has an ephemeral filesystem.
4. **Decide where the worker runs** — in-process is fine for one instance.
5. Consider `ALLOW_REGISTRATION=false` for a reviewer-facing demo.
6. Set `AI_DAILY_BUDGET_USD` if the deployment is publicly reachable.

---

## Switching to Postgres

Two lines in `prisma/schema.prisma`:

```prisma
datasource db {
  provider = "postgresql"     // was "sqlite"
  url      = env("DATABASE_URL")
}
```

```bash
DATABASE_URL="postgresql://user:pass@host:5432/asc?schema=public"
npx prisma db push        # or: npx prisma migrate deploy
npm run db:seed
```

The schema is written to port cleanly — no database enums, no `Json` columns, no
array types, no provider-specific attributes. Nothing else changes.

For pgvector, replace `MaterialChunk.embedding` (currently JSON text) with a
`vector` column and swap the cosine scan in `src/lib/retrieval/search.ts` for an
indexed query. The `EmbeddingProvider` interface is unchanged.

---

## Running the worker separately

On the web process:

```bash
WORKER_IN_PROCESS=false npm start
```

On the worker process (same codebase, same `DATABASE_URL` and `STORAGE_DIR`):

```bash
npm run worker
```

Multiple workers are safe: jobs are claimed with a conditional update and held
under a lease, so two workers cannot run the same job, and a crashed worker's
jobs are recovered automatically.

If the web process and the worker do not share a filesystem, object storage is
required — the worker reads the uploaded PDF back from the storage adapter.

---

## Object storage

Implement `StorageAdapter` (`src/lib/storage/index.ts` — four methods) and
register it at boot with `setStorageAdapter()`. The interface is already
S3-shaped, and keys are content-addressed and namespaced by user.

---

## Platform notes

**A VM, container, or any host with a persistent volume** is the simplest fit:
one process, in-process worker, local storage, SQLite or Postgres. Everything
works as documented.

**Vercel and similar serverless platforms** need two changes: object storage
(the filesystem is ephemeral) and an external worker, because a serverless
function will not host a long-running polling loop. Set
`WORKER_IN_PROCESS=false` and run `npm run worker` on a small always-on
instance.

**Docker** — no Dockerfile is included, but the shape is standard:

```dockerfile
FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
CMD ["npm", "start"]
```

---

## Health and monitoring

- **Admin → System health** gives live checks for the database, AI provider,
  job queue, event pipeline, AI error rate and stalled documents.
- Logs are one JSON object per line on stdout, so any aggregator can consume
  them. Every AI request, retrieval and tool call carries a `traceId`.
- For an external uptime probe, `/api/auth/me` is cheap and exercises the
  database and the session layer (expect 401 when unauthenticated).

---

## Continuous integration

```bash
npm ci
npm run typecheck
npm test          # 123 tests, no network, no API key
npm run eval      # exits non-zero on an AI behaviour regression
npm run build
```

The evaluation step is the interesting one: it fails the build when a prompt,
model or retrieval change degrades a case relative to the previous run.
