import { AppError } from "../errors";
import { isHeading } from "../retrieval/chunking";
import { estimateTokens } from "./pricing";
import {
  extractAllTags,
  extractTag,
  seededRandom,
  sentences,
  slugify,
  termFrequencies,
  titleCase,
  tokenOverlap,
  tokenize,
  truncate,
} from "./text";
import type {
  AiCallMeta,
  AiProvider,
  AiResult,
  DocumentUnderstandingRequest,
  GenerateStructuredRequest,
  GenerateTextRequest,
  StreamEvent,
  StreamResult,
} from "./types";

/**
 * Deterministic offline provider.
 *
 * Why this exists: an AI product that cannot be run or tested without a funded
 * API key is hard to review, hard to CI, and impossible to demo offline. This
 * provider implements the same contract using extractive//rule-based logic over
 * the *same retrieved evidence* the live provider sees, so every product flow —
 * grounded answers, citations, refusals, quiz generation, grading, mastery
 * updates, recommendations — works end to end with zero credentials.
 *
 * It is a genuine fallback, not a stub: answers are extractive from the
 * project's own material and refusals fire on the same evidence threshold. It
 * is clearly labelled as `offline-deterministic` in the UI and in every AI
 * usage row so nobody mistakes its output for model output.
 *
 * Every prompt in src/lib/ai/prompts renders its inputs into XML-ish tags
 * (`<evidence>`, `<question>`, …). The live model benefits from the structure
 * and this provider parses the same tags.
 */
export class OfflineProvider implements AiProvider {
  readonly id = "offline";
  readonly isLive = false;
  readonly model = "offline-deterministic";

  async generateText(
    request: GenerateTextRequest,
    meta: AiCallMeta,
  ): Promise<AiResult<string>> {
    const started = Date.now();
    const payload = request.messages.map((m) => m.content).join("\n\n");
    const text = this.textFor(meta, payload);
    return this.wrap(text, payload, started);
  }

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
    meta: AiCallMeta,
  ): Promise<AiResult<T>> {
    const started = Date.now();
    const payload = request.messages.map((m) => m.content).join("\n\n");
    const draft = this.structuredFor(meta, payload, request.schemaName);
    const parsed = request.schema.safeParse(draft);
    if (!parsed.success) {
      throw new AppError(
        "AI_INVALID_OUTPUT",
        `Offline provider could not satisfy schema ${request.schemaName}: ${parsed.error.issues
          .map((i) => `${i.path.join(".")} ${i.message}`)
          .join("; ")}`,
      );
    }
    const result = await this.wrap(JSON.stringify(draft), payload, started);
    return { ...result, value: parsed.data };
  }

  async streamText(
    request: GenerateTextRequest,
    meta: AiCallMeta,
  ): Promise<StreamResult> {
    const started = Date.now();
    const payload = request.messages.map((m) => m.content).join("\n\n");
    const text = this.textFor(meta, payload);
    const chunks = text.match(/[^\s]+\s*/g) ?? [text];

    async function* iterate(): AsyncIterable<StreamEvent> {
      for (const chunk of chunks) {
        // A small delay makes the offline demo feel like a real stream and
        // exercises the same client-side incremental rendering path.
        await new Promise((resolve) => setTimeout(resolve, 8));
        yield { type: "text", text: chunk };
      }
      yield { type: "done" };
    }

    const self = this;
    return {
      stream: iterate(),
      final: async () => self.wrap(text, payload, started),
    };
  }

  async understandDocument(
    request: DocumentUnderstandingRequest,
    _meta: AiCallMeta,
  ): Promise<AiResult<string>> {
    // Without a vision model there is nothing to read from the page image.
    // Saying so is correct behaviour; inventing page content would poison
    // retrieval with text that is not in the user's material.
    return {
      value: "",
      usage: { inputTokens: 0, outputTokens: 0, cachedTokens: 0 },
      model: this.model,
      provider: this.id,
      latencyMs: 0,
      stopReason: "end_turn",
    };
  }

  async health() {
    return { ok: true, latencyMs: 0, detail: "Offline deterministic provider (no API key)" };
  }

  // -------------------------------------------------------------------------

  private async wrap(
    text: string,
    payload: string,
    started: number,
  ): Promise<AiResult<string>> {
    return {
      value: text,
      usage: {
        inputTokens: estimateTokens(payload),
        outputTokens: estimateTokens(text),
        cachedTokens: 0,
      },
      model: this.model,
      provider: this.id,
      latencyMs: Date.now() - started,
      stopReason: "end_turn",
    };
  }

  /** Evidence passages the prompt supplied, in rank order. */
  private evidence(payload: string): { label: string; body: string }[] {
    return extractAllTags(payload, "passage").map((raw) => {
      const label = extractTag(raw, "source") || "Source";
      const body = extractTag(raw, "text") || raw;
      return { label, body };
    });
  }

  private textFor(meta: AiCallMeta, payload: string): string {
    switch (meta.feature) {
      case "TUTOR":
        return this.tutorAnswer(payload);
      case "SUMMARISATION":
        return this.summarise(payload);
      default:
        return this.summarise(payload);
    }
  }

  /**
   * Extractive grounded answer. Picks the evidence sentences that overlap the
   * question most, and refuses when nothing clears the support threshold —
   * the same contract the live prompt is held to (PRD §20).
   */
  private tutorAnswer(payload: string): string {
    const question = extractTag(payload, "question") || payload.slice(0, 400);
    const passages = this.evidence(payload);
    if (passages.length === 0) {
      return this.refusal();
    }

    // Require more than one shared content word before treating a sentence as
    // an answer. A single incidental overlap ("make", "used") is noise, and
    // answering from it is exactly the confabulation §20 forbids.
    const questionTokens = new Set(tokenize(question));
    const scored = passages
      .flatMap((passage) =>
        sentences(passage.body).map((sentence) => {
          const shared = [...new Set(tokenize(sentence))].filter((t) =>
            questionTokens.has(t),
          );
          return {
            sentence,
            label: passage.label,
            score: tokenOverlap(question, sentence),
            sharedTerms: shared.length,
          };
        }),
      )
      .filter((candidate) => candidate.sharedTerms >= 2 && candidate.score > 0)
      .sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best || best.score < 0.3) {
      return this.refusal();
    }

    // Include the sentence that precedes or follows the best match. A single
    // extracted sentence is often the definition without the explanation, which
    // reads as a non-answer even when it is technically correct.
    const sentenceIndex = new Map<string, { list: string[]; at: number }>();
    for (const passage of passages) {
      const list = sentences(passage.body);
      list.forEach((sentence, at) => {
        if (!sentenceIndex.has(sentence)) sentenceIndex.set(sentence, { list, at });
      });
    }

    const picked: typeof scored = [];
    const seenSentences = new Set<string>();
    const seenLabels = new Set<string>();

    for (const candidate of scored) {
      if (picked.length >= 5) break;
      if (seenSentences.has(candidate.sentence)) continue;
      picked.push(candidate);
      seenSentences.add(candidate.sentence);
      seenLabels.add(candidate.label);

      // Pull in the surrounding sentences. The preceding one comes first and
      // matters most: the best lexical match is often a back-reference ("This
      // is known as the testing effect") whose subject lives in the sentence
      // before it, and quoting it alone reads as a non-answer.
      const located = sentenceIndex.get(candidate.sentence);
      if (located) {
        const before = located.list[located.at - 1];
        const after = located.list[located.at + 1];
        if (before && !seenSentences.has(before)) {
          // Insert before the match so the quoted passage reads in order.
          picked.splice(picked.length - 1, 0, {
            ...candidate,
            sentence: before,
            score: candidate.score * 0.5,
          });
          seenSentences.add(before);
        }
        if (after && !seenSentences.has(after) && picked.length < 5) {
          picked.push({ ...candidate, sentence: after, score: candidate.score * 0.5 });
          seenSentences.add(after);
        }
      }
    }

    const body = picked.map((p) => p.sentence).join(" ");
    const sources = [...seenLabels].map((label) => `- ${label}`).join("\n");

    return [
      `Based on your project materials:`,
      ``,
      body,
      ``,
      `**Sources**`,
      sources,
      ``,
      `_Answered by the offline deterministic provider (no AI model key configured). ` +
        `The passages above are quoted directly from your uploaded material._`,
    ].join("\n");
  }

  private refusal(): string {
    return (
      "I could not find enough supporting evidence in this project's materials to answer " +
      "that reliably, so I would rather not guess.\n\n" +
      "You could try rephrasing the question, asking about a topic your uploaded documents " +
      "cover, or adding a material that discusses it."
    );
  }

  private summarise(payload: string): string {
    const source =
      extractTag(payload, "content") ||
      extractTag(payload, "material") ||
      this.evidence(payload)
        .map((p) => p.body)
        .join(" ") ||
      payload;
    return truncate(sentences(source).slice(0, 4).join(" "), 900);
  }

  private structuredFor(
    meta: AiCallMeta,
    payload: string,
    schemaName: string,
  ): unknown {
    switch (meta.feature) {
      case "CONCEPT_EXTRACTION":
        return this.extractConcepts(payload);
      case "QUIZ_GENERATION":
        return this.generateQuestion(payload);
      case "OPEN_GRADING":
        return this.gradeOpenAnswer(payload);
      case "RECOMMENDATION":
        return this.recommend(payload);
      case "CONTEXT_DISTILLATION":
        return this.distilContext(payload);
      case "RERANK":
        return this.rerank(payload);
      case "EVALUATION":
        return this.judge(payload);
      case "SUMMARISATION":
        return { summary: this.summarise(payload) };
      default:
        throw new AppError(
          "AI_INVALID_OUTPUT",
          `Offline provider has no generator for ${meta.feature}/${schemaName}`,
        );
    }
  }

  /**
   * Heading-first concept extraction.
   *
   * Section headings are the strongest available signal for "what is this
   * material teaching" — a human skimming a document would read them first.
   * Repeated multi-word capitalised phrases come next, and single words are
   * admitted only when they are frequent, long, and not generic filler.
   */
  private extractConcepts(payload: string) {
    const content = extractTag(payload, "content") || payload;
    const goal = extractTag(payload, "goal");
    const title = extractTag(payload, "title");

    // The document's own title is a label, not a learnable concept.
    const titleSlug = slugify(title.replace(/\.pdf$/i, ""));

    const candidates = new Map<string, number>();
    const bump = (rawName: string, weight: number) => {
      const name = rawName.trim().replace(/\s+/g, " ");
      if (!isPlausibleConcept(name)) return;
      if (titleSlug && slugify(name) === titleSlug) return;
      candidates.set(name, (candidates.get(name) ?? 0) + weight);
    };

    // 1. Section headings, with the numbering stripped.
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.length > 90) continue;
      const numbered = trimmed.match(/^\d+(?:\.\d+)*\.?\s+(.{3,80})$/);
      if (numbered) {
        bump(stripLeadingArticle(numbered[1]), 10);
        continue;
      }
      if (isHeading(trimmed) && trimmed.split(/\s+/).length <= 8) {
        bump(stripLeadingArticle(trimmed), 6);
      }
    }

    // 2. Repeated multi-word capitalised phrases in the body.
    const phraseRegex = /\b([A-Z][a-z]{2,}(?:\s+(?:of|the|and)?\s*[A-Za-z][a-z]{2,}){1,2})\b/g;
    for (const match of content.matchAll(phraseRegex)) {
      bump(match[1], 1.5);
    }

    // 3. Frequent, distinctive single words.
    const unigrams = termFrequencies(tokenize(content));
    for (const [term, count] of Object.entries(unigrams)) {
      if (count < 4 || term.length < 7) continue;
      bump(titleCase(term), count * 0.4);
    }

    // 4. Terms from the learner's stated goal matter more than raw frequency.
    for (const term of tokenize(goal)) {
      if (term.length < 5) continue;
      for (const key of candidates.keys()) {
        if (key.toLowerCase().includes(term)) candidates.set(key, candidates.get(key)! + 5);
      }
    }

    // Drop a candidate wholly contained in a stronger one ("Retrieval" vs
    // "Retrieval Practice"), so mastery is not split across near-duplicates.
    const ranked = [...candidates.entries()].sort((a, b) => b[1] - a[1]);
    const kept: { name: string; weight: number }[] = [];
    for (const [name, weight] of ranked) {
      const lower = name.toLowerCase();
      const subsumed = kept.some((k) => {
        const other = k.name.toLowerCase();
        return other.includes(lower) || lower.includes(other);
      });
      if (subsumed) continue;
      kept.push({ name, weight });
      if (kept.length >= 8) break;
    }

    const maxWeight = kept[0]?.weight ?? 1;
    const concepts = kept.map(({ name, weight }) => ({
      name: truncate(name, 60),
      description: truncate(
        sentences(content).find((sentence) =>
          sentence.toLowerCase().includes(name.toLowerCase()),
        ) ?? `A key idea covered in ${title || "this material"}.`,
        220,
      ),
      importance: Math.max(0.25, Math.min(1, weight / maxWeight)),
    }));

    return {
      concepts:
        concepts.length > 0
          ? concepts
          : [
              {
                name: truncate(title || "General Material", 60),
                description: "Overall content of the uploaded material.",
                importance: 0.5,
              },
            ],
    };
  }

  /** Build a question out of the highest-signal evidence sentence. */
  private generateQuestion(payload: string) {
    const type = extractTag(payload, "questionType").toUpperCase() === "OPEN" ? "OPEN" : "MCQ";
    const concept = extractTag(payload, "conceptName") || "this topic";
    const difficulty = (extractTag(payload, "difficulty") || "MEDIUM").toUpperCase();
    const passages = this.evidence(payload);
    const pool = passages.flatMap((p) =>
      sentences(p.body).map((sentence) => ({ sentence, label: p.label })),
    );

    const random = seededRandom(`${concept}|${difficulty}|${type}|${pool.length}`);
    const ranked = pool
      .map((item) => ({ ...item, score: tokenOverlap(concept, item.sentence) }))
      .sort((a, b) => b.score - a.score);
    const chosen = ranked[0] ?? { sentence: "", label: "Project material", score: 0 };

    if (!chosen.sentence) {
      return {
        type,
        prompt: `In your own words, explain ${concept} and why it matters.`,
        options: type === "MCQ" ? [
          `${concept} is a central idea in this material.`,
          `${concept} is unrelated to this material.`,
          `${concept} only applies outside this subject.`,
          `${concept} has no practical use.`,
        ] : [],
        correctIndex: type === "MCQ" ? 0 : null,
        referenceAnswer: `A good answer defines ${concept} and connects it to the project material.`,
        rubric: [`Defines ${concept}`, `Connects it to the material`, "Gives an example"],
        explanation: `This checks a working understanding of ${concept}.`,
      };
    }

    if (type === "OPEN") {
      const keyTerms = tokenize(chosen.sentence).slice(0, 4);
      return {
        type: "OPEN",
        prompt: `Explain ${concept} in your own words, referring to what the material says about it.`,
        options: [],
        correctIndex: null,
        referenceAnswer: chosen.sentence,
        rubric: [
          `Mentions ${concept}`,
          ...keyTerms.slice(0, 3).map((term) => `References "${term}"`),
        ],
        explanation: `The material states: ${truncate(chosen.sentence, 240)}`,
      };
    }

    // MCQ: correct option is the evidence sentence; distractors are negated or
    // unrelated statements drawn from other passages, so they stay plausible.
    const distractorPool = ranked.slice(1).map((r) => r.sentence);
    const distractors = [
      distractorPool[0] ?? `${titleCase(concept)} is not discussed in this material.`,
      distractorPool[Math.floor(random() * Math.max(1, distractorPool.length))] ??
        `${titleCase(concept)} is only relevant in unrelated contexts.`,
      `${titleCase(concept)} has no measurable effect according to this material.`,
    ]
      .map((d) => truncate(d, 220))
      .filter((d, i, arr) => arr.indexOf(d) === i)
      .slice(0, 3);

    while (distractors.length < 3) {
      distractors.push(`None of the above applies to ${concept}. (${distractors.length + 1})`);
    }

    const correct = truncate(chosen.sentence, 220);
    const options = [correct, ...distractors];
    // Deterministic shuffle so the answer is not always first.
    const correctIndex = Math.floor(random() * options.length);
    [options[0], options[correctIndex]] = [options[correctIndex], options[0]];

    return {
      type: "MCQ",
      prompt: `According to your project materials, which statement about ${concept} is correct?`,
      options,
      correctIndex,
      referenceAnswer: correct,
      rubric: [],
      explanation: `The material supports: ${correct}`,
    };
  }

  /** Rubric-point overlap grading with partial credit. */
  private gradeOpenAnswer(payload: string) {
    const answer = extractTag(payload, "studentAnswer");
    const reference = extractTag(payload, "referenceAnswer");
    const rubric = extractAllTags(payload, "rubricPoint");

    if (answer.trim().length < 3) {
      return {
        score: 0,
        isCorrect: false,
        feedback: "No answer was provided, so there is nothing to assess yet.",
        coveredPoints: [],
        missingPoints: rubric,
      };
    }

    // Each rubric point earns proportional credit rather than passing a binary
    // threshold: an answer that half-covers three points deserves half marks,
    // not zero. A point is *reported* as covered once it is mostly addressed.
    const covered: string[] = [];
    const missing: string[] = [];
    let pointCredit = 0;
    for (const point of rubric) {
      const overlap = tokenOverlap(point, answer);
      pointCredit += Math.min(1, overlap / 0.6);
      if (overlap >= 0.5) covered.push(point);
      else missing.push(point);
    }

    const rubricScore = rubric.length > 0 ? pointCredit / rubric.length : 0;
    const referenceScore = reference ? tokenOverlap(reference, answer) : 0;
    // Weight the rubric more heavily than raw similarity to the reference.
    const score = Math.round(Math.min(1, rubricScore * 0.65 + referenceScore * 0.35) * 100) / 100;

    const feedback =
      score >= 0.8
        ? `Strong answer — you covered ${covered.length} of ${rubric.length || 1} key points, including the core idea.`
        : score >= 0.5
          ? `You have the main idea, but the answer is incomplete.${
              missing.length ? ` Missing: ${missing.slice(0, 2).join("; ")}.` : ""
            }`
          : `This answer does not yet demonstrate the key ideas.${
              missing.length ? ` Focus on: ${missing.slice(0, 3).join("; ")}.` : ""
            }`;

    return {
      score,
      isCorrect: score >= 0.6,
      feedback,
      coveredPoints: covered,
      missingPoints: missing,
    };
  }

  private recommend(payload: string) {
    const weak = extractAllTags(payload, "weakConcept");
    const goal = extractTag(payload, "goal");
    const materialCount = Number(extractTag(payload, "materialCount") || "0");
    const recentAccuracy = Number(extractTag(payload, "recentAccuracy") || "0");

    if (materialCount === 0) {
      return {
        title: "Add your first learning material",
        body: "This project has no material yet, so the tutor has nothing to ground its answers in. Upload a PDF to unlock grounded answers and adaptive quizzes.",
        actionType: "ADD_MATERIAL",
        conceptNames: [],
        rationale: "No processed materials exist for this project.",
        priority: 0.95,
      };
    }

    if (weak.length === 0) {
      return {
        title: "Take a short quiz to establish a baseline",
        body: `There is not enough assessment evidence yet to tell where you stand${
          goal ? ` against your goal of ${truncate(goal, 80)}` : ""
        }. A five-question adaptive quiz will produce your first mastery estimates.`,
        actionType: "TAKE_QUIZ",
        conceptNames: [],
        rationale: "Mastery confidence is low across all concepts.",
        priority: 0.7,
      };
    }

    const focus = weak.slice(0, 2);
    return {
      title: `Review ${focus[0]} and reassess`,
      body:
        `Your weakest area is ${focus[0]}${focus[1] ? `, followed by ${focus[1]}` : ""}. ` +
        `Recent assessment accuracy is ${Math.round(recentAccuracy * 100)}%. ` +
        `Re-read the related material, then take a short quiz focused on ${focus[0]} to confirm the improvement.`,
      actionType: "TAKE_QUIZ",
      conceptNames: focus,
      rationale: `Lowest mastery concepts: ${focus.join(", ")}.`,
      priority: 0.85,
    };
  }

  /** Keep only statements that look durable rather than conversational. */
  private distilContext(payload: string) {
    const transcript = extractTag(payload, "transcript") || payload;
    const signals: { kind: string; pattern: RegExp }[] = [
      { kind: "GOAL", pattern: /\b(i want to|my goal|i need to|preparing for|studying for|aiming to)\b/i },
      { kind: "PREFERENCE", pattern: /\b(prefer|i like|easier for me|explain it|in simple terms|analog)/i },
      { kind: "DIFFICULTY", pattern: /\b(confus|struggl|don't understand|do not understand|hard time|lost|unclear)\b/i },
      { kind: "STRENGTH", pattern: /\b(already know|familiar with|comfortable with|i understand)\b/i },
    ];

    const items: { kind: string; content: string; salience: number }[] = [];
    for (const sentence of sentences(transcript)) {
      for (const signal of signals) {
        if (signal.pattern.test(sentence)) {
          items.push({
            kind: signal.kind,
            content: truncate(sentence, 220),
            salience: signal.kind === "GOAL" ? 0.9 : 0.6,
          });
          break;
        }
      }
      if (items.length >= 5) break;
    }
    return { items };
  }

  /** Identity rerank — preserves the retriever's fused ordering. */
  private rerank(payload: string) {
    const ids = extractAllTags(payload, "candidateId");
    return {
      ranking: ids.map((id, index) => ({
        id,
        relevance: Math.max(0.05, 1 - index * 0.1),
      })),
    };
  }

  private judge(payload: string) {
    const answer = extractTag(payload, "answer");
    const expected = extractTag(payload, "expected");
    const overlap = expected ? tokenOverlap(expected, answer) : 0;
    return {
      score: Math.round(overlap * 100) / 100,
      passed: overlap >= 0.5,
      reasoning: `Token overlap with the expected answer is ${(overlap * 100).toFixed(0)}%.`,
    };
  }
}

/**
 * Filters out phrases that are grammatically plausible but useless as a
 * learnable concept — generic academic filler, bare verbs, and words a learner
 * would never say they were studying.
 */
const GENERIC_CONCEPT_WORDS = new Set([
  "able",
  "well",
  "study",
  "studies",
  "learner",
  "learners",
  "learning",
  "information",
  "material",
  "materials",
  "example",
  "examples",
  "practice",
  "result",
  "results",
  "section",
  "chapter",
  "introduction",
  "conclusion",
  "overview",
  "summary",
  "reference",
  "references",
  "figure",
  "table",
  "however",
  "therefore",
  "because",
  "important",
  "different",
  "following",
  "general",
  "common",
  "using",
  "used",
  "based",
  "means",
  "produces",
  "requires",
  "consistently",
]);

function isPlausibleConcept(name: string): boolean {
  if (name.length < 4 || name.length > 70) return false;
  const words = name.split(/\s+/);
  if (words.length > 6) return false;
  const lower = name.toLowerCase();
  // A single generic word is never a concept; a phrase containing one can be
  // ("Retrieval Practice" survives, "Practice" does not).
  if (words.length === 1 && GENERIC_CONCEPT_WORDS.has(lower)) return false;
  if (words.every((w) => GENERIC_CONCEPT_WORDS.has(w.toLowerCase()))) return false;
  if (!/[a-z]/i.test(name)) return false;
  return true;
}

function stripLeadingArticle(text: string): string {
  return text.replace(/^(the|a|an)\s+/i, "").trim();
}
