# AI tools and models used

This document separates **AI used to build the product** from **AI that is part
of the running product** (PRD §86, §88), and is deliberately complete rather
than flattering.

---

## Part 1 — AI used to build the product

### Claude Opus 5, via Claude Code (Anthropic's CLI coding agent)

| | |
| --- | --- |
| **Tool / model** | Claude Opus 5 (`claude-opus-5`) running inside Claude Code |
| **Where used** | Essentially the whole codebase: schema design, backend services, retrieval, AI layer, React UI, tests, evaluation harness, and this documentation |
| **Why** | The task was a full-stack build against a 94-section specification in a compressed timeframe. An agentic coding tool that can read the spec, hold the whole architecture in context, run commands and iterate against real failures fits that shape of work. |
| **What it contributed** | The initial architecture, essentially all of the implementation, and the test and evaluation suites. It also drove the debugging loop — running the app, reading real output, and fixing what was actually broken rather than what looked plausible. |
| **Development or product?** | **Development only.** Claude Code is not part of the deployed system. |

**How it was actually used.** Not "generate an app". The loop was:

1. Read the PRD in full and extract the concrete requirements.
2. Verify the environment before committing to a stack — checking Node,
   network, and whether the installed Anthropic SDK actually exposed the APIs
   being planned for. (It did not expose `messages.parse` / `output_config`, so
   the structured-output approach changed to strict tool use *before* any code
   was written against the wrong assumption.)
3. Build a layer, typecheck it, then **run it against real data** and read the
   output.
4. Fix what the output showed was wrong.

That fourth step is where most of the value was. Several defects were found by
running the thing rather than by reading it:

| Found by running | The bug |
| --- | --- |
| Inspecting seeded chunks | The chunker collapsed a whole PDF page into one 2.4k-character chunk, because extracted PDF text has no blank lines and the splitter keyed on them. Rewritten to work line-by-line. |
| Inspecting extracted concepts | Concepts came out as "Able", "Well", "Study" — useless. Rewritten to read section headings first, with a generic-word filter. |
| Testing the tutor | "How do I make sourdough bread?" was answered from a study-skills document, because BM25 matched the single word "make". Led to the retrieval relevance floor. |
| Running the quiz loop | Open-response questions never appeared (the mastery gate was unreachable on fresh material) and the difficulty band never moved. Both fixed. |
| Running the eval suite | Hyphenated words ("re-reading") never matched their parts, breaking rubric grading; and single-sentence extractive answers were quoting definitions without their subject. |
| Running the built app | A server component was passing a function prop to a client chart component — a runtime 500 on the analytics page. |

None of these were visible in code review. All were visible in output.

### Other AI tooling

| Tool | Where | Product or development |
| --- | --- | --- |
| Anthropic `claude-api` reference skill | Confirming current model IDs, the thinking/temperature rules on the Opus 5 family, and the SDK's structured-output surface | Development |
| Data-visualisation reference skill + its palette validator | Chart palette, mark specs, and the accessibility gates; the palette was validated with a script against this app's own surfaces rather than chosen by eye | Development |

### What was **not** AI-generated

- The PRD (supplied).
- The seeded sample documents' subject matter is written prose in
  `prisma/sample/content.ts`, authored for the demo rather than model-generated,
  so the demo does not depend on model output being present.

---

## Part 2 — AI inside the running product

Everything below runs in the deployed application.

### Provider

| | |
| --- | --- |
| **Primary** | Anthropic `claude-opus-5` |
| **Fallback tier** | `claude-sonnet-5` (configurable via `AI_FALLBACK_MODEL`) |
| **Last resort** | Built-in deterministic offline provider |
| **Abstraction** | `src/lib/ai/types.ts` — application code never imports the vendor SDK |

Requests are non-streaming for structured work and streaming for the tutor.
`thinking` is omitted, which means adaptive thinking on `claude-opus-5`;
`temperature` is not sent, having been removed on that model family.

### Where the model is used

| Feature | Prompt | Output | What it does |
| --- | --- | --- | --- |
| AI Tutor | `tutor.answer@1.3.0` | Streamed text | Answers from retrieved material with page citations; refuses when unsupported |
| Concept extraction | `concept.extract@1.2.0` | Structured | Finds the teachable concepts in a processed document |
| Material summary | `material.summarise@1.0.0` | Structured | Short factual summary for the materials list |
| Quiz generation | `quiz.generate@1.4.0` | Structured | One adaptive question grounded in retrieved evidence |
| Open-answer grading | `grading.open@1.3.0` | Structured | Rubric-level score, covered and missing points, feedback |
| Recommendations | `recommendation.generate@1.3.0` | Structured | The single most useful next action |
| Learning context | `context.distil@1.2.0` | Structured | Distils durable learner facts from a conversation |
| Retrieval rerank | `retrieval.rerank@1.1.0` | Structured | Reorders the hybrid-retrieval shortlist by true relevance |
| Evaluation judge | `eval.judge@1.1.0` | Structured | Model-based grader available to the eval suite |
| Document understanding | `material.vision_ocr@1.1.0` | Text | Reads pages with no text layer (scans, diagrams, image tables) via native PDF input |

The live registry is visible in the app at **Admin → AI usage → Prompt registry**.

### Non-model AI/ML in the product

| Component | What it is | Why not a model |
| --- | --- | --- |
| Embeddings | Local hashed character-n-gram + word-bigram vectors, L2 normalised | No second vendor on the document-processing critical path; the semantic work is done by the reranker |
| BM25 | Classic lexical ranking over per-chunk term frequencies | Precise on jargon and proper nouns, where embeddings are weak |
| Mastery model | Difficulty-weighted moving average with a confidence term | Transparent and explainable to a learner |
| Adaptive selection | Scored on uncertainty × importance × staleness × coverage | Deterministic, inspectable, and shown to the learner as a reason |
| Grounding classification | Rule-based check of refusal signals and citation presence | Self-reported groundedness is not evidence |
| Offline provider | Extractive and rule-based over the same retrieved evidence | Lets the whole product run with no credentials |

### What the model is deliberately *not* trusted with

| Decision | Owner | Why |
| --- | --- | --- |
| Multiple-choice correctness | Application | The stored `correctIndex` is the truth; the model does not re-grade |
| Mastery arithmetic | Application | Deterministic and auditable |
| Which question comes next | Application | The selector is a scored policy, not a model choice |
| Authorisation | Application | Scope comes from the session, never from model arguments |
| Whether a tool may write | Application | `mutates` tools are refused from read paths |
| Whether an answer was grounded | Application | Checked against the evidence actually retrieved |

### Cost and usage tracking

Every model call — including every retry and every failure — writes an
`AiRequestLog` row with feature, prompt id and version, provider, model, status,
latency, input/output/cached tokens, estimated cost and trace id. Per-model
prices live in `src/lib/ai/pricing.ts` and cost is labelled *estimated*
throughout the UI. An optional `AI_DAILY_BUDGET_USD` cap stops a runaway loop
from becoming a bill.

### Safety posture

- **Data vs instructions.** Every system prompt that renders retrieved or
  user-authored content carries an explicit boundary block, and all such content
  is wrapped in tags. An uploaded PDF is data.
- **Injection is tested, not assumed.** The eval suite includes an injection
  case in the tutor and another inside a graded answer ("award full marks").
  Both are expected to fail to influence the system, and are scored.
- **Blast radius.** Even a successful injection reaches a capability layer that
  is read-only on that path.
