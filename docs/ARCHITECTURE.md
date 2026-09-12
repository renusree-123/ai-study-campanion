# Architecture

## 1. System overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│  BROWSER                                                                  │
│  React Server Components (reads)  ·  Client components (interaction)      │
│  SSE consumer for streamed tutor answers                                  │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │ HTTP / SSE
┌───────────────────────────────▼──────────────────────────────────────────┐
│  APPLICATION — Next.js 15 (App Router), single deployable                 │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐ │
│  │ API layer            src/app/api/**                                  │ │
│  │   handler() wrapper: trace id, timing, error envelope                │ │
│  │   Zod validation on every body and query                             │ │
│  └───────────────────────────────┬─────────────────────────────────────┘ │
│                                  │                                        │
│  ┌───────────────────────────────▼─────────────────────────────────────┐ │
│  │ AUTH & OWNERSHIP     src/lib/auth/**                                 │ │
│  │   JWT session cookie · scrypt passwords · role check                 │ │
│  │   assertProjectAccess / resolveJobOwnership — the isolation choke    │ │
│  │   point. Every read and write of a Space/Project subtree passes here │ │
│  └───────────────────────────────┬─────────────────────────────────────┘ │
│                                  │                                        │
│  ┌───────────────────────────────▼─────────────────────────────────────┐ │
│  │ DOMAIN SERVICES      src/lib/domain/**                               │ │
│  │   learning · tutor · quiz · mastery · growth · recommendations       │ │
│  │   analytics · learning-context · admin (read model)                  │ │
│  └───┬───────────────────┬──────────────────┬──────────────────────────┘ │
│      │                   │                  │                             │
│  ┌───▼──────────┐  ┌─────▼─────────┐  ┌─────▼──────────────────────────┐ │
│  │ AI LAYER     │  │ RETRIEVAL     │  │ EVENTS + JOBS                  │ │
│  │ src/lib/ai   │  │ src/lib/      │  │ src/lib/events, src/lib/jobs   │ │
│  │              │  │  retrieval    │  │                                │ │
│  │ router       │  │ chunking      │  │ transactional outbox           │ │
│  │ providers    │  │ BM25          │  │ dispatcher → reaction table    │ │
│  │ prompts (vN) │  │ embeddings    │  │ durable queue: lease, retry,   │ │
│  │ tools        │  │ RRF fusion    │  │  backoff, dedupe, recovery     │ │
│  │ usage/cost   │  │ LLM rerank    │  │ worker (in-process or separate)│ │
│  └───┬──────────┘  └─────┬─────────┘  └─────┬──────────────────────────┘ │
└──────┼───────────────────┼──────────────────┼────────────────────────────┘
       │                   │                  │
┌──────▼───────────────────▼──────────────────▼────────────────────────────┐
│  DATA LAYER                                                               │
│  Relational (Prisma)          Document storage        Search index        │
│   users, spaces, projects      StorageAdapter          MaterialChunk       │
│   materials, chunks            local FS (dev)           embedding JSON     │
│   concepts, mastery            S3-shaped interface      termFreq JSON      │
│   conversations, messages                                                  │
│   quizzes, questions, answers  Learning context        Observability       │
│   recommendations               LearningContextItem     AiRequestLog        │
│   activity, domain events       (salience + embedding)  RetrievalLog        │
│   jobs, daily stats                                     ToolInvocation      │
│   eval runs + case results                              Job / DomainEvent   │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
┌───────────────────────────────▼──────────────────────────────────────────┐
│  EXTERNAL                                                                 │
│  Anthropic API (claude-opus-5) — text, structured output, streaming,      │
│  native PDF understanding.   Falls back to the offline provider.          │
└──────────────────────────────────────────────────────────────────────────┘
```

Nothing above the data layer talks to Anthropic directly. Application code
depends on the `AiProvider` interface; the router owns provider selection,
retries, fallback and accounting.

---

## 2. Layers and their responsibilities

| Layer            | Location              | Owns                                                     | Must not                                     |
| ---------------- | --------------------- | -------------------------------------------------------- | -------------------------------------------- |
| API              | `src/app/api`         | HTTP shape, validation, status codes                      | Contain business logic                        |
| Auth/ownership   | `src/lib/auth`        | Identity, roles, tenancy boundary                         | Be bypassed by any data path                  |
| Domain           | `src/lib/domain`      | Learning rules, mastery maths, adaptive selection         | Know about HTTP or React                      |
| AI               | `src/lib/ai`          | Prompts, providers, structured output, tools, accounting  | Be imported directly as a vendor SDK elsewhere|
| Retrieval        | `src/lib/retrieval`   | Chunking, indexing, hybrid search, reranking              | Cross a project boundary                      |
| Events/Jobs      | `src/lib/events/jobs` | Asynchrony, reactions, durability                         | Block an interactive request                  |
| Data             | `prisma/schema.prisma`| Persistence, indexes, constraints                         | Encode enums the product needs to extend      |

---

## 3. Data model

```
User ──┬── Space ──── Project ──┬── Material ──── MaterialChunk ──┬── ConceptChunk
       │                        │                                 │
       │                        ├── Concept ──────────────────────┘
       │                        │      └── Mastery ──── MasterySnapshot
       │                        │
       │                        ├── Conversation ──── Message (citations, grounding)
       │                        │
       │                        ├── Quiz ──── QuizQuestion ──── QuizAnswer
       │                        │
       │                        ├── Recommendation
       │                        └── ProjectDailyStat
       │
       ├── LearningContextItem   (project-scoped or global)
       ├── ActivityEvent
       └── UserDailyStat

Cross-cutting: Job · DomainEvent · AiRequestLog · RetrievalLog ·
               ToolInvocation · EvalRun ─── EvalCaseResult
```

Design notes worth calling out:

- **`userId` is denormalised onto every ownable row.** It makes the isolation
  filter a single indexed predicate rather than a join through the space.
- **No database enums.** SQLite does not support them, and the PRD explicitly
  requires new activity types without an architectural change. Status columns
  are strings with the allowed values documented beside them and enforced by Zod.
- **No `Json` columns.** Structured values are TEXT holding JSON, read through
  `parseJson` which is total. This ports to Postgres unchanged.
- **Denormalised rollups** (`Project.masteryAvg`, `materialCount`, …) are
  recomputed by the analytics job so list views need no per-row aggregate.
- **`MasterySnapshot` is append-only.** Growth is derived from history rather
  than from a single stored "previous" value, so a trend means a direction of
  travel rather than the last answer.
- **Idempotency lives in the schema**: `Job.dedupeKey`, `DomainEvent.dedupeKey`,
  `QuizAnswer.questionId`, `Recommendation@(projectId,dedupeKey)`,
  `MaterialChunk@(materialId,index)` are all unique.

---

## 4. Request flow: a tutor question

```
POST /api/conversations/:id/messages
  │
  ├─ requireUser()                       401 if not signed in
  ├─ assertConversationAccess()          404 if not yours (never 403 — no probing)
  ├─ assertProjectAccess()
  ├─ Zod validate body                   422 with field paths on failure
  ├─ guard: project has READY material    409 with an actionable message
  │
  ├─ persist the learner's message       (so a mid-answer failure loses nothing)
  ├─ record activity
  │
  ├─ buildTutorContext()                 ── parallel ──
  │     ├─ hybrid retrieval (project-scoped, reranked)
  │     ├─ relevance-ranked learner context
  │     ├─ mastery snapshot
  │     └─ rolling conversation summary + last 6 turns verbatim
  │
  ├─ open SSE stream
  │     ├─ event: meta    retrieval stats + citations, before the first token
  │     ├─ event: delta   tokens as they arrive
  │     └─ event: done    messageId, grounding, citations, latency
  │
  ├─ on stream close:
  │     ├─ classifyGrounding(answer, evidence)   GROUNDED | PARTIAL | UNSUPPORTED
  │     ├─ persist assistant message + citations + tokens + model + traceId
  │     └─ publish TUTOR_INTERACTION_COMPLETED   (nothing else runs inline)
  │
  └─ on failure: persist a FAILED assistant turn, send event: error
```

The context is *assembled*, never dumped: retrieval gets the largest share of
the budget, history is summarised beyond the last six turns, and learner context
is relevance-ranked rather than sent whole (PRD §40).

---

## 5. Background processing

```
enqueue(type, payload, dedupeKey)
        │  unique dedupeKey → at-most-once enqueue
        ▼
     Job(QUEUED)
        │  claimNextJob(): conditional UPDATE WHERE status='QUEUED'
        │  → one winner, no locks, identical on SQLite and Postgres
        ▼
     Job(RUNNING, lockedBy, lockedAt)
        │
        ├── success  → SUCCEEDED (duration recorded)
        ├── retryable failure, attempts left → QUEUED with exponential backoff
        ├── retryable failure, budget spent  → DEAD
        ├── permanent failure                → FAILED (no retries burned)
        └── worker crashes → lease expires → recoverStuckJobs() requeues it
```

Handlers are written to be safely re-runnable: they recompute from source and
upsert, rather than incrementing or appending.

### The event → workflow chain

`publish()` writes a `DomainEvent` row — optionally inside the same transaction
as the state change that caused it (transactional outbox). The `event.dispatch`
job drains pending events and fans each one out through a **reaction table**
(`src/lib/events/dispatcher.ts`), which is the single readable place where
"when X happens, do Y" lives.

```
QUIZ_COMPLETED
   └→ quiz.finalise        recompute score from answers (not counters)
        ├→ recalculateTrends()
        ├→ rollupDailyStats()
        ├→ recommendation.generate
        └→ insight.generate     detect repeated mistakes → write learner context

MATERIAL_PROCESSED
   ├→ recommendation.generate
   └→ analytics.rollup

TUTOR_INTERACTION_COMPLETED
   ├→ context.distil        durable learner facts + rolling summary
   └→ analytics.rollup
```

Delivery is at-least-once, and duplicate protection exists at both ends: the
event's own unique key, and each downstream job's dedupe key.

---

## 6. Retrieval

```
query
  ├── BM25 over per-chunk term frequencies         (precise, lexical)
  ├── cosine over hashed n-gram embeddings         (fuzzy, morphological)
  ├── Reciprocal Rank Fusion                       (fuse by rank, not by score)
  ├── relevance floor: max(term coverage, 1.25 × cosine) ≥ 0.30
  └── LLM rerank of the top 12                     (semantic judgement)
```

RRF is used rather than a weighted sum because BM25 scores and cosine
similarities are not on a comparable scale; fusing by rank removes the need to
calibrate one against the other and is robust when one arm returns nothing.

**The relevance floor is the load-bearing piece.** Without it BM25 returns
*something* for any query sharing a single common word with the corpus, and the
tutor would "answer" a sourdough question out of a study-skills document. It is
what makes an honest refusal possible.

Project isolation is applied in the SQL `WHERE`, not after scoring, so another
project's chunk never enters the candidate pool.

---

## 7. AI layer

```
domain service
   └─ runTextPrompt / runStructuredPrompt(prompt, input, ctx)
        │  attributes the call to a prompt id + version
        ▼
      ai router
        ├─ budget pre-check (optional per-user daily cap)
        ├─ primary provider  → retry ×N with jittered backoff
        ├─ fallback model    → one attempt
        ├─ offline provider  → last resort, so an outage degrades not breaks
        ├─ per-attempt timeout
        └─ writes AiRequestLog for EVERY attempt:
             feature, promptId@version, provider, model, status, latency,
             input/output/cached tokens, estimated cost, retries, error
        ▼
     AiProvider
        ├─ AnthropicProvider   claude-opus-5
        │     text · structured (strict tool + Zod) · streaming · PDF vision
        └─ OfflineProvider     deterministic, extractive, no credentials
```

Structured output uses a **forced strict tool call**, then re-validates with
Zod. `strict: true` makes the arguments schema-valid at the API level; the Zod
pass exists because the *application*, not the model, owns the contract.

### Controlled capabilities (§22, §23)

The model cannot touch the database. It can only request a registered tool, and
every request passes the same gate:

```
model output → schema validation → side-effect policy → authorisation
             → execute → audit row → result
```

- `userId`/`projectId` come from the **session**, never from model arguments.
- A tool declaring `mutates: true` is refused unless the call site explicitly
  allows mutations. The tutor read path runs with mutations disabled, so no
  amount of injected text in an uploaded PDF can cause a write.
- Every invocation — including every denial — lands in `ToolInvocation`.

---

## 8. Observability

| Question                                   | Where it is answered                       |
| ------------------------------------------ | ------------------------------------------ |
| Why was that answer slow?                  | `AiRequestLog.latencyMs` + `RetrievalLog`  |
| Which AI operation failed, and why?        | `AiRequestLog.status` + `.error`           |
| Which retrieval returned poor context?     | `RetrievalLog` returned/candidate/topScore |
| Which model was used, and what did it cost?| `AiRequestLog.model` / `.costUsd`          |
| Which prompt version produced this?        | `AiRequestLog.promptId@promptVersion`      |
| Which workflow generated a recommendation? | `Recommendation.generatedBy` + `Job`       |
| Why did a document fail?                   | `Material.error` + `Job.lastError`         |
| Which stage of a workflow failed?          | `Job.stage` + `Job.progress`               |
| What did the AI actually *do*?             | `ToolInvocation`                           |

Everything shares a **`traceId`**, so one tutor request can be followed across
the AI, retrieval and tool logs. All of it surfaces in `/admin/ai` and
`/admin/health`.

---

## 9. Security

| Concern                | Control                                                                 |
| ---------------------- | ----------------------------------------------------------------------- |
| Authentication         | scrypt (OWASP params), HTTP-only SameSite cookie, signed JWT             |
| Account enumeration    | Login verifies a decoy hash on unknown email — constant-ish timing       |
| Authorisation          | Ownership guards on every path; admin surface is separate and read-only  |
| Resource probing       | A miss returns 404, never 403 — a 403 would confirm the id exists        |
| Data isolation         | `userId`/`projectId` in the SQL `WHERE`, re-verified inside job handlers |
| Upload safety          | Magic-byte check, size cap, content-addressed key, sanitised filename    |
| Path traversal         | Key normalisation *and* a resolved-root check in the storage adapter     |
| Prompt injection       | Data/instruction boundary in every system prompt; untrusted content in tags |
| AI privilege escalation| Tool allowlist, session-derived scope, read paths cannot mutate          |
| XSS                    | Hand-written Markdown renderer that escapes first; no raw HTML survives  |
| Secret handling        | Production boot fails on the default `AUTH_SECRET`; `.env` is gitignored |
