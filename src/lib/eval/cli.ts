/**
 * Evaluation CLI.
 *
 *   npm run eval              # run every suite
 *   npm run eval -- tutor     # one suite
 *   npm run eval -- all "before prompt change"   # label the run
 *
 * Exits non-zero when a case regresses against the previous run of the same
 * suite, so this can gate a deploy in CI.
 */
import "../load-env";
import { db } from "../db";
import { ai } from "../ai/router";
import { runEvaluation } from "./runner";
import { SUITES, type Suite } from "./dataset";

// Colour is suppressed when stdout is not a TTY, so CI logs stay clean.
const ESC = String.fromCharCode(27);
const useColour = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string) => (useColour ? `${ESC}[${code}m` : "");
const GREEN = c("32");
const RED = c("31");
const YELLOW = c("33");
const DIM = c("2");
const RESET = c("0");

async function main() {
  const requested = (process.argv[2] ?? "all") as Suite;
  const label = process.argv[3] ?? "";

  if (!SUITES.includes(requested)) {
    console.error(`Unknown suite "${requested}". Options: ${SUITES.join(", ")}`);
    process.exit(2);
  }

  const provider = ai.describe();
  console.log(`\nAI Study Companion - evaluation`);
  console.log(`  suite:    ${requested}`);
  console.log(`  provider: ${provider.provider} / ${provider.model}${provider.isLive ? "" : " (offline)"}`);
  if (!provider.isLive) {
    console.log(
      `${DIM}  Note: running against the deterministic offline provider. Set ANTHROPIC_API_KEY\n` +
        `        to evaluate real model behaviour.${RESET}`,
    );
  }
  console.log("");

  const { run, outcomes, diff, metrics } = await runEvaluation({
    suite: requested,
    label,
    onProgress: (done, total, caseId) => {
      if (useColour) process.stdout.write(`${DIM}  [${done + 1}/${total}] ${caseId}...${RESET}\r`);
    },
  });

  if (useColour) process.stdout.write(`${" ".repeat(80)}\r`);

  for (const outcome of outcomes) {
    const mark = outcome.passed ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
    console.log(`  ${mark}  ${outcome.caseId.padEnd(42)} ${outcome.score.toFixed(2)}`);
    if (!outcome.passed) {
      console.log(`        ${DIM}${outcome.notes}${RESET}`);
      if (outcome.error) console.log(`        ${RED}${outcome.error}${RESET}`);
    }
  }

  console.log(
    `\n  ${run.passedCases}/${run.totalCases} passed - avg score ${run.avgScore.toFixed(3)} - ${run.durationMs}ms`,
  );

  if (Object.keys(metrics).length > 0) {
    console.log(`\n  Metrics`);
    for (const [metric, value] of Object.entries(metrics).sort()) {
      console.log(`    ${metric.padEnd(30)} ${value.toFixed(3)}`);
    }
  }

  if (run.baselineRunId) {
    console.log(`\n  Compared against the previous ${requested} run:`);
    if (diff.improved.length === 0 && diff.regressed.length === 0) {
      console.log(`    ${DIM}no change${RESET}`);
    }
    for (const id of diff.improved) console.log(`    ${GREEN}improved${RESET}  ${id}`);
    for (const id of diff.regressed) console.log(`    ${RED}REGRESSED${RESET} ${id}`);
  } else {
    console.log(`\n  ${DIM}First run for this suite - no baseline to compare against.${RESET}`);
  }

  console.log("");

  // Non-zero exit on regression so CI can block a bad prompt or model change.
  if (diff.regressed.length > 0) {
    console.log(`${RED}Regression detected in ${diff.regressed.length} case(s).${RESET}\n`);
    process.exitCode = 1;
  } else if (run.passedCases < run.totalCases) {
    console.log(
      `${YELLOW}${run.totalCases - run.passedCases} case(s) failing (no regression vs baseline).${RESET}\n`,
    );
  }
}

main()
  .catch((error) => {
    console.error(`\n${RED}Evaluation failed:${RESET}`, error instanceof Error ? error.message : error);
    process.exitCode = 2;
  })
  .finally(async () => {
    await db.$disconnect();
  });
