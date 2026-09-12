# Known limitations

Written as an engineer would hand this to the next person, not as a sales
document. Everything here is a real constraint of the prototype.

---

## Document handling

- **PDF only.** Validated by magic bytes, not filename. DOCX, EPUB, HTML and
  plain text are not supported.
- **Scanned pages are read by the model, and only up to 12 per document.** There
  is no local OCR engine. Pages with no text layer are sent to the model's
  native PDF understanding; beyond 12 such pages the vision pass is skipped
  (bounded cost) and those pages are simply not indexed. A document that is
  *entirely* scanned and long will index poorly. Without an API key the vision
  path returns nothing rather than inventing page content — the right failure,
  but a failure.
- **Table extraction is heuristic.** Column structure is reconstructed from
  glyph positions and a run of column-like lines is kept as one chunk. Complex
  tables — merged cells, nested headers, multi-page — will degrade to
  approximate text.
- **No figure or equation understanding** beyond what the vision pass
  transcribes. Mathematical notation in particular round-trips badly.
- **20MB upload cap**, and processing a very large PDF is single-threaded per
  job.

## Retrieval

- **Local hashed embeddings, not a neural encoder.** Good at morphology and
  typo tolerance, weak at genuine synonymy. "Automobile" will not match "car"
  on the vector arm; it relies on the reranker or the lexical arm.
- **The relevance floor can produce a false refusal.** A legitimate question
  worded very differently from the source can fall below the threshold. This is
  a deliberate bias — a false refusal is better than a confident fabrication —
  but it is a real cost.
- **No chunk-level deduplication.** Uploading two overlapping documents means
  near-duplicate passages can occupy several of the six evidence slots.
- **Retrieval scores the whole corpus in memory per query.** Fine for hundreds
  or low thousands of chunks; it needs a real vector index (pgvector, Qdrant)
  well before tens of thousands.
- **No query rewriting.** A follow-up like "why?" is answered against
  conversation history rather than a rewritten standalone query, which weakens
  retrieval on short follow-ups.

## AI behaviour

- **Grounding classification is heuristic.** It checks for refusal phrasing and
  citation presence. A confidently wrong answer that cites a real page is
  classified `GROUNDED`. Detecting *that* needs claim-level verification.
- **Citations are passage-level, not sentence-level.** The cited page did inform
  the answer; there is no guarantee a specific sentence maps to a specific span.
- **The offline provider is extractive.** It quotes and stitches your material
  rather than explaining it, cannot synthesise across documents, and cannot
  grade a semantic paraphrase — one evaluation case fails on exactly that, and
  is left visible on purpose (`docs/EVALUATION.md`).
- **No streaming for structured output.** Quiz generation and grading block
  until complete, so a slow model shows as a spinner.
- **Prompt-injection defence is prompt-level plus architecture-level, not
  proven.** The boundary block and the read-only capability layer make it hard
  and low-impact; neither is a guarantee. The eval suite tests two injection
  vectors, which is a floor, not a proof.

## Learning model

- **Mastery is a defensible heuristic, not a validated instrument.** The
  constants (learning rates, difficulty ceilings, the confidence curve) were
  chosen for sensible behaviour, not fitted to learning-outcome data. It is
  useful as a relative signal and should not be read as a measurement.
- **Concepts come from one document at a time.** Two materials teaching the same
  idea under different names produce two concepts and split the mastery history.
  There is name-based deduplication and the prompt asks for reuse, but no
  embedding-level concept merging.
- **No forgetting curve.** Mastery does not decay with time, so a concept
  mastered three months ago and never revisited still reads as mastered. Given
  that the seeded material is *about* spaced repetition, this is a conspicuous
  gap and the first thing I would add.
- **Trends need roughly two weeks of data** to be meaningful; before that most
  concepts read as `NEW`.

## Scale and infrastructure

- **SQLite has a single writer.** Concurrent quiz submissions and job execution
  will contend under real load. The schema ports to Postgres unchanged.
- **The job queue polls once a second** and jobs are claimed one at a time per
  worker. Throughput is adequate for document processing, not for a high-rate
  event stream.
- **Local filesystem storage does not survive an ephemeral host.** On Vercel,
  Fly or a container platform without a volume, uploaded PDFs are lost on
  redeploy. `StorageAdapter` is S3-shaped; this is one file to implement.
- **No horizontal-scale story for the in-process worker.** Multiple web
  instances each running a worker is safe (leases prevent double-execution) but
  wasteful; the intended production shape is `WORKER_IN_PROCESS=false` plus
  dedicated worker processes.
- **Analytics recompute on page load** apart from the daily rollups. The
  platform-wide admin aggregates in particular would need materialised views.

## Security

- **No rate limiting.** A logged-in user can drive AI cost as fast as the
  provider allows. The per-user daily budget cap (`AI_DAILY_BUDGET_USD`) is the
  only guard, and it is off by default.
- **Sessions cannot be revoked.** A JWT is valid until it expires; there is no
  server-side session store, so "sign out everywhere" is not possible.
- **No email verification, password reset, or MFA.**
- **No audit trail for administrator reads.** The admin surface is read-only,
  but who looked at whose data is not recorded.
- **Uploaded files are not virus-scanned**, and are served only to their owner.
- **No CSRF tokens.** Mitigated by `SameSite=Lax` cookies and JSON-only
  endpoints, which is adequate here but not a complete defence.

## Product surface

- **No collaboration, sharing, or multi-tenant organisations.** Everything is
  single-user.
- **No mobile app**, though the UI is responsive.
- **Conversation history is not searchable.**
- **No export.** A learner cannot take their data out.
- **Recommendations are one at a time.** No study plan, no schedule, no calendar.
- **Accessibility is considered but not audited.** Semantic markup, labelled
  controls, keyboard-reachable dialogs, status conveyed by icon and text as well
  as colour, and a validated chart palette — but no screen-reader testing.

## Testing

- **123 tests, but no browser-level end-to-end tests.** The UI is verified by
  build, typecheck and manual HTTP smoke tests, not by Playwright.
- **No load or soak testing.**
- **The evaluation suite is 20 cases** against two seeded documents.

---

## What I would build next, in order

1. **Time-decay in the mastery model and a spaced-repetition scheduler.** The
   biggest gap between what this measures and what actually helps someone learn.
   The domain model already has snapshots and per-concept history to build on.
2. **Postgres with pgvector.** Removes the single-writer limit and the
   in-memory retrieval scan in one move.
3. **Claim-level grounding verification.** Split the answer into claims and
   verify each against its cited span, rather than checking that a citation
   exists. This is the difference between "cited" and "true".
4. **Concept merging across materials**, using embedding similarity plus a model
   confirmation step, so mastery history stops fragmenting.
5. **Object storage and a separate worker deployment.** The two changes that
   make this deployable somewhere real without caveats.
6. **Rate limiting and per-user cost budgets on by default.**
7. **A larger, partly human-reviewed evaluation set**, with sampled real tutor
   answers scored by a person, to calibrate the automatic scorers.
8. **Query rewriting for follow-up turns**, which is the cheapest remaining
   retrieval win.
