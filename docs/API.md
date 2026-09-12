# API reference

All endpoints are under `/api`. Authentication is a signed, HTTP-only session
cookie set by `/api/auth/login`.

## Conventions

**Success**

```json
{ "data": { ... }, "meta": { ... } }
```

**Failure**

```json
{
  "error": { "code": "VALIDATION_ERROR", "message": "…", "details": [ … ] },
  "traceId": "tr_…"
}
```

Every response carries an `x-trace-id` header. The same id appears in the
structured logs and, for AI-backed endpoints, in `AiRequestLog`,
`RetrievalLog` and `ToolInvocation` — so one request can be followed end to end.

| Code | Status | Meaning |
| --- | --- | --- |
| `BAD_REQUEST` | 400 | Malformed request |
| `UNAUTHENTICATED` | 401 | Not signed in |
| `FORBIDDEN` | 403 | Signed in, not permitted |
| `NOT_FOUND` | 404 | Missing — **or not yours** (see below) |
| `CONFLICT` | 409 | Valid request, wrong state |
| `PAYLOAD_TOO_LARGE` | 413 | Upload over the cap |
| `UNSUPPORTED_MEDIA_TYPE` | 415 | Not a PDF |
| `VALIDATION_ERROR` | 422 | Failed schema validation; `details` has field paths |
| `RATE_LIMITED` / `BUDGET_EXCEEDED` | 429 | AI spend cap reached |
| `AI_PROVIDER_ERROR` / `AI_INVALID_OUTPUT` | 502 | Upstream AI failure |
| `AI_TIMEOUT` | 504 | AI request timed out |
| `INTERNAL` | 500 | Unexpected; message is always generic |

> **404 rather than 403 for another user's resource.** A 403 would confirm the
> id exists. Ownership misses are indistinguishable from non-existence.

---

## Authentication

| Method | Path | Body | Returns |
| --- | --- | --- | --- |
| `POST` | `/api/auth/register` | `{ email, password (≥8), name }` | User; sets the session cookie. The first account created becomes an administrator. |
| `POST` | `/api/auth/login` | `{ email, password }` | User; sets the session cookie |
| `POST` | `/api/auth/logout` | — | `{ signedOut: true }` |
| `GET` | `/api/auth/me` | — | The current session user |

---

## Spaces

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/spaces` | — | Yours only, with project counts |
| `POST` | `/api/spaces` | `{ name, description?, color?, icon? }` | |
| `GET` | `/api/spaces/:spaceId` | — | Includes its projects |
| `PATCH` | `/api/spaces/:spaceId` | `{ name?, description?, color?, icon? }` | |
| `DELETE` | `/api/spaces/:spaceId` | — | Soft delete (archives the space and its projects) |

## Projects

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/projects?spaceId=` | — | |
| `POST` | `/api/projects` | `{ spaceId, name, description?, goal? }` | A stated goal is also written to persistent learning context |
| `GET` | `/api/projects/:projectId` | — | With counts |
| `PATCH` | `/api/projects/:projectId` | `{ name?, description?, goal? }` | |
| `DELETE` | `/api/projects/:projectId` | — | Soft delete |

## Materials

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/materials` | — | Poll this for processing status |
| `POST` | `/api/projects/:projectId/materials` | `multipart/form-data`, field `file` | Returns 201 immediately; processing is a background job. Re-uploading identical bytes returns the existing material with `deduplicated: true`. |
| `GET` | `/api/materials/:materialId` | — | `{ status, stage, progress, pageCount, chunkCount, summary, error }` |
| `DELETE` | `/api/materials/:materialId` | — | Removes chunks and the stored object |
| `POST` | `/api/materials/:materialId/reprocess` | — | Re-runs the pipeline; rebuilds rather than duplicating |

Processing stages, in order: `QUEUED` → `READING_CONTENT` →
`UNDERSTANDING_STRUCTURE` → `EXTRACTING_KNOWLEDGE` →
`CREATING_SEARCHABLE_REPRESENTATION` → `READY` (or `FAILED`).

## Tutor

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/conversations` | — | |
| `POST` | `/api/projects/:projectId/conversations` | `{ title? }` | |
| `GET` | `/api/conversations/:conversationId` | — | Messages with citations and grounding |
| `DELETE` | `/api/conversations/:conversationId` | — | |
| `POST` | `/api/conversations/:conversationId/messages` | `{ content }` | **Server-Sent Events** |

### The streaming protocol

`Content-Type: text/event-stream`. Four event types, all JSON:

```
event: meta
data: {"retrievedCount":3,"retrievalLatencyMs":10,"citations":[{"materialId":"…","materialName":"Handbook.pdf","page":2,"chunkId":"…","quote":"…"}]}

event: delta
data: {"text":"Retrieval practice "}

event: done
data: {"messageId":"…","grounding":"GROUNDED","citations":[…],"latencyMs":1840,"model":"claude-opus-5"}

event: error
data: {"message":"The AI service is unavailable right now. Your learning data is unchanged — please try again."}
```

`meta` arrives before the first token, so the client can show what is being read.
`grounding` is one of `GROUNDED`, `PARTIAL`, `UNSUPPORTED`, `NA`.

Returns `409` if the project has no processed material — there would be nothing
to ground an answer in.

## Quiz

| Method | Path | Body | Notes |
| --- | --- | --- | --- |
| `GET` | `/api/projects/:projectId/quizzes` | — | History |
| `POST` | `/api/projects/:projectId/quizzes` | `{ questionCount?: 3–15, focusConceptIds?: string[] }` | An existing active quiz is **resumed**, not duplicated (`resumed: true`) |
| `GET` | `/api/quizzes/:quizId` | — | Questions; correct answers are withheld until answered |
| `POST` | `/api/quizzes/:quizId/next` | — | Next question, generating it if needed. Idempotent: returns the existing unanswered question rather than skipping ahead. |
| `POST` | `/api/quizzes/:quizId/answer` | `{ questionId, selectedIndex?, answer? }` | Grades, records, updates mastery in one transaction |
| `POST` | `/api/quizzes/:quizId/complete` | — | Finalises and triggers the background workflow chain |

`answer` returns the result, the mastery delta, and progress:

```json
{
  "data": {
    "result": {
      "isCorrect": true, "score": 1, "feedback": "…",
      "coveredPoints": [], "missingPoints": [],
      "correctIndex": 2, "explanation": "…", "evaluatedBy": "rule"
    },
    "mastery": {
      "conceptId": "…", "conceptName": "Retrieval Practice",
      "previousLevel": 0.46, "level": 0.61, "delta": 0.15
    },
    "progress": { "answered": 3, "planned": 5 },
    "finished": false
  }
}
```

Re-submitting an answered question returns `{ alreadyAnswered: true }` with the
stored result — it is not re-graded and mastery is not double-counted.

## Admin

All require `role = ADMIN`; a learner receives 403 (or a redirect on pages).

| Method | Path | Notes |
| --- | --- | --- |
| `GET` | `/api/admin/evaluation` | Recent evaluation runs |
| `POST` | `/api/admin/evaluation` | `{ suite?, label? }` — runs a suite and returns the diff against the previous run |

The remaining admin surfaces are server-rendered pages rather than JSON
endpoints, reading through `src/lib/domain/admin.ts`: `/admin`, `/admin/users`,
`/admin/users/:userId`, `/admin/spaces`, `/admin/projects`, `/admin/activity`,
`/admin/analytics`, `/admin/ai`, `/admin/evaluation`, `/admin/health`.

---

## Validation and isolation

Every body and query string is validated with Zod before a handler runs; unknown
fields are stripped rather than persisted. Every endpoint that touches a Space
or Project subtree resolves it through an ownership guard that filters by
`userId` **in the SQL query**, so another user's row is never loaded and then
compared. Background jobs re-verify the `(userId, projectId)` pair at execution
time, so a stale or tampered job payload cannot cross a tenancy boundary.
