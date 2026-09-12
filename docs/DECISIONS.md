# Technology decisions and trade-offs

Each entry states the choice, the reasoning, what was given up, and what would
change it. The prototype timeline (3–4 days) is an explicit input to several of
these.

---

## Next.js 15 (App Router) as a single deployable

**Why.** The product is one coherent application: server-rendered dashboards,
a streaming chat surface, file upload, and a REST API. Splitting it into a
separate SPA and API server would add a build target, a CORS story, an auth
token story and a second deploy — for no benefit at this size. React Server
Components let every dashboard read its data by calling a domain service
directly, with no HTTP hop and no client-side loading state.

**Trade-off.** The API and UI scale together. If the tutor became CPU-heavy
enough to starve page rendering, the API would need to be extracted.

**Why not a separate FastAPI/Express backend.** It buys independent scaling the
prototype does not need, and costs a duplicated type layer across the boundary.

---

## SQLite in development, Postgres-shaped schema

**Why.** `npm install && npm run setup && npm run dev` has to work with no
Docker, no database server and no cloud account — reviewers should not have to
provision infrastructure to read the code. The schema deliberately avoids
SQLite-only and Postgres-only features (see `prisma/schema.prisma`), so the
migration is two lines plus `prisma db push`.

**Trade-off.** SQLite has a single writer. Under real concurrent load the job
queue would contend. That is fine for a prototype and documented as a scaling
limitation.

**What changes it.** Any real deployment: switch `provider` to `postgresql`,
point `DATABASE_URL` at it. `docs/DEPLOYMENT.md` has the steps.

---

## Prisma

**Why.** Generated types keep the schema and the code honest, and the migration
and introspection story is good. Its query builder is expressive enough for the
analytics aggregates here (`groupBy`, `_avg`, `_count`) without hand-written SQL.

**Trade-off.** Prisma is heavy, and complex analytical queries eventually want
raw SQL. Two places already push at that edge (platform-wide struggling
concepts, per-day rollups) and would become views or materialised views at scale.

---

## Database-backed job queue rather than Redis/BullMQ

**Why.** This is the decision I would defend hardest.

1. **Exactly-once enqueue for free.** A job can be inserted in the same
   transaction as the state change that justifies it. There is no window where
   the row exists but the job was lost, or the reverse.
2. **One fewer service.** No broker to run, secure, back up or pay for.
3. **Operable with a SQL query.** The admin health page reads queue depth,
   failures and stuck leases with a plain aggregate.

Durability comes from the schema: `dedupeKey` unique for at-most-once enqueue,
`lockedBy`/`lockedAt` leases so a crashed worker's jobs are recovered rather
than stranded, bounded retries with exponential backoff, and a terminal `DEAD`
state distinct from `FAILED` (retries exhausted vs. not worth retrying).

**Trade-off.** Polling latency (about a second) and database write load. Neither
matters for document processing and analytics.

**What changes it.** Thousands of jobs a second, or a need for sub-100ms
dispatch. The `enqueue`/`claimNextJob` interface is narrow enough to swap.

---

## Hybrid retrieval with local hashed embeddings

**Why not a hosted embedding model.** Anthropic does not serve an embeddings
endpoint, so using one would add a second vendor, a second key and a second
failure mode to the critical path of document processing.

**Why not a bundled neural encoder.** transformers.js with MiniLM is ~90MB of
model download at cold start. That is a poor trade for a prototype that must
boot quickly on a small host.

**What was built instead.** A three-arm retriever:

| Arm            | Contributes                                    |
| -------------- | ---------------------------------------------- |
| BM25           | precise lexical matching, proper nouns, jargon  |
| Hashed n-grams | morphology and typo tolerance, fuzzy recall     |
| LLM rerank     | actual semantic judgement, over a shortlist     |

The semantic work happens in the reranker, where a strong model is already in
the loop, rather than in a weak embedding. Fusion is Reciprocal Rank Fusion
because BM25 scores and cosine similarities are not on a comparable scale.

**Trade-off.** Pure-vector recall for heavily paraphrased queries is weaker than
a real sentence encoder would give. The reranker and the BM25 arm cover most of
it; the eval suite has an explicit paraphrase case that passes.

**What changes it.** `EmbeddingProvider` is one interface with one
implementation. Swapping in Voyage, OpenAI or a local ONNX model is a new file.

---

## A relevance floor on retrieval

**Why.** This is what makes honest refusal possible, and it was found by the
evaluation suite rather than by design. Without a floor, BM25 returns *something*
for any query sharing one common word with the corpus — so "How do I make
sourdough bread rise?" matched a study-skills document on the word "make", and
the tutor dutifully answered from it.

A chunk now has to clear `max(query-term coverage, 1.25 × cosine) ≥ 0.30`.
Returning nothing is the correct behaviour when the materials do not cover a
topic.

**Trade-off.** A genuinely relevant but very differently worded question can be
rejected. Preferring a false refusal over a confident fabrication is the right
side to err on for a learning product.

---

## Claude Opus 5 behind a provider interface, with a deterministic offline fallback

**Why Opus 5.** The hard tasks here are grounded synthesis with correct
refusal, and writing assessment questions whose distractors are plausible.
Both reward the strongest available reasoning; a cheaper model produces
distractors you can spot by length alone. `claude-sonnet-5` is configured as
the fallback tier.

**Why the interface.** Application code depends on `AiProvider`, never the
vendor SDK. That is what lets the router own retries, fallback and accounting
in one place, and what makes the offline provider possible.

**Why an offline provider at all.** An AI product that cannot be run or tested
without a funded API key is hard to review, impossible to CI, and undemoable on
a plane. This one is a genuine fallback, not a stub: it answers extractively
from the same retrieved evidence, refuses on the same evidence threshold,
generates questions from real passages, and grades against rubrics. It is
labelled `offline-deterministic` everywhere it appears.

It also turned out to be a real engineering asset: because it is deterministic,
the evaluation suite is a *regression* detector rather than a variance detector,
and the whole test suite runs in 20 seconds with no network.

**Trade-off.** Offline answers are extractive rather than explanatory, and
semantic grading of a paraphrase is beyond it. Documented in
`docs/LIMITATIONS.md`.

---

## Structured output via forced strict tool use

**Why not free-form JSON.** Parsing JSON out of prose fails in ways that are
tedious and unpredictable. `strict: true` on a tool makes the arguments
schema-valid at the API level, which removes the largest class of failure before
it reaches the application.

**Why validate again with Zod.** Because the *application* owns the contract,
not the model. Schema-valid is not the same as usable: a 3-option MCQ or an
out-of-range correct index passes JSON Schema and is still a bug. The quiz
generator has its own invariant checks on top.

**Implementation note.** The installed SDK (`0.71.2`) exposes `strict` on the
beta tool type, so structured generation uses `client.beta.messages.create`
with the `structured-outputs-2025-11-13` beta. `thinking` is omitted entirely —
on `claude-opus-5` that means adaptive thinking runs by default — and
`temperature` is not sent, having been removed on that model family.

---

## A single Zod schema per structured prompt, converted to JSON Schema

**Why.** Two hand-written artefacts (a JSON Schema for the model, a validator
for the code) drift. `src/lib/ai/schema.ts` derives the JSON Schema from the
Zod schema, so there is one source of truth. It supports only the subset the
prompts use and throws loudly on anything else, rather than silently emitting a
schema the model cannot satisfy.

**Trade-off.** A hand-rolled converter is a small maintenance surface. It is
~90 lines and directly tested.

---

## Prompts as versioned, registered artefacts

**Why.** Prompts are application behaviour. Scattered template literals cannot
be evaluated, attributed or rolled back. Every prompt has an id, a semantic
version, a declared responsibility, typed input, and — where code consumes the
output — a typed output schema. The id and version are stamped on every
`AiRequestLog` row, so latency, cost and failures are attributable to a specific
prompt version, and the eval suite can compare versions.

---

## An explicit capability layer instead of giving the model database access

**Why.** "Structured, controlled, validated, observable, permission-aware"
(PRD §22) is a set of properties, not a vibe. Each is a concrete mechanism:

| Property         | Mechanism                                                     |
| ---------------- | ------------------------------------------------------------- |
| Structured       | Registry of named tools with Zod schemas                       |
| Validated        | Arguments parsed, not coerced; failures audited                |
| Permission-aware | Scope comes from the session; ownership re-checked per call    |
| Controlled       | `mutates: true` refused unless the call site opts in           |
| Observable       | Every invocation and denial written to `ToolInvocation`        |

The read path used by the tutor runs with mutations disabled. That is the
concrete answer to "what if an uploaded PDF contains instructions": even a
perfectly successful injection reaches a layer that cannot write.

---

## A transparent heuristic mastery model, not IRT or BKT

**Why.** The PRD asks for an *understandable* representation of learning state,
not a psychometrically validated one. The model is an evidence-weighted moving
average with three properties that matter:

1. **Difficulty-aware targets** — an easy question answered correctly cannot
   demonstrate mastery, and a hard one answered wrongly does not disprove it.
2. **Confidence-damped rate** — early evidence moves the estimate a long way;
   once there is a track record a single unlucky answer cannot erase it.
3. **Asymmetry** — a wrong answer is stronger evidence than a right one,
   because guessing exists.

A learner can reason about it ("I got two hard ones right and it moved a lot"),
which a latent-trait model does not offer.

**Trade-off.** Not calibrated against real learning outcomes. The constants are
defensible, not validated.

---

## Adaptive selection scored, not branched

**Why.** The PRD is explicit that "wrong → easy, right → hard" is not adaptive
(§26). Concept selection maximises expected learning value:

```
value = uncertainty × importance × staleness × coverage × focus
```

Uncertainty peaks at ~0.5 mastery — testing something you clearly know or
clearly do not teaches nobody anything. Difficulty starts from the modelled
ability and steps a band only after a *run* of outcomes, never a single answer.
Every question stores the reason it was chosen, and the UI shows it.

---

## Hand-written Markdown renderer

**Why.** Model output is untrusted text rendered into the page. The safest
renderer is one that escapes everything first and then re-introduces only the
small set of constructs the tutor is asked to produce. No raw HTML can survive,
so there is no sanitiser to configure and no bypass to keep up with. It is ~150
lines and directly tested against script tags, `javascript:` and `data:` URLs.

**Trade-off.** Not CommonMark-complete. It handles what the tutor prompt asks for.

---

## Inline SVG charts instead of a charting library

**Why.** The dashboards need seven chart types, all simple. Recharts or Chart.js
would add ~150KB to first load and still need theming to match. Hand-rolled SVG
is a few hundred lines, themes from the same CSS variables as everything else,
and has no runtime dependency.

The palette is not eyeballed: it is taken from a validated data-visualisation
reference and re-checked against this app's own light and dark surfaces
(lightness band, chroma floor, colour-vision-deficiency separation, normal-vision
separation, contrast). One light-mode hue lands below 3:1 contrast, so every
chart that uses it also ships visible value labels.

**Trade-off.** No zoom, brush or export. Not needed here.

---

## What was deliberately simplified

| Simplified                       | Why it was acceptable                                        |
| -------------------------------- | ------------------------------------------------------------ |
| SQLite instead of Postgres       | Zero-setup review; schema ports unchanged                     |
| Local filesystem storage         | `StorageAdapter` is S3-shaped; one file to swap               |
| In-process worker by default     | `npm run dev` is the whole system; separable by one env var   |
| Polling job queue                | Sub-second dispatch is not a requirement here                 |
| Rule-based eval scorers          | Deterministic, free, and a real regression signal             |
| No email verification or reset   | Not on the critical path of the learning loop                 |
| Structured logs to stdout        | Any host aggregates them; no vendor lock-in for a prototype   |
| No rate limiting                 | Single-tenant demo; the AI budget cap is the cost guard       |
