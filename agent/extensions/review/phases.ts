/**
 * The fixed sections every review prompt is assembled from.
 *
 * These are the parts that do not vary with level or fan-out: how the diff is
 * gathered, how a candidate is judged, and what the output has to look like.
 * Keeping them here means a level only chooses *which angles* run and *how
 * many* findings survive — never what "confirmed" means.
 */

import { CONFIG, LEVEL_SPECS, type Level } from "./config.ts";

/**
 * The gather phase is identical everywhere on purpose: a review that disagrees
 * with itself about what it is reviewing is worse than no review. The
 * working-tree clause matters more than it looks — these commands are usually
 * run *before* the commit, so a range diff alone would silently review nothing.
 *
 * It takes its own number rather than hardcoding "Phase 0", so the caller owns
 * the whole sequence. Hardcoding it here meant prompt.ts had to seed its
 * counter at 1 to agree with a string in another file, with nothing enforcing
 * that agreement.
 */
export function gatherDiff(n: number): string {
	return `## Phase ${n} — Gather the diff

Run \`git diff @{upstream}...HEAD\` (or \`git diff main...HEAD\` / \`git diff HEAD~1\`
if there's no upstream) to get the unified diff under review. If there are
uncommitted changes, or the range diff is empty, also run \`git diff HEAD\` and
include the working-tree changes in scope — the review often runs before the
commit.

**Then run \`git ls-files --others --exclude-standard\` and Read every file it
lists.** Untracked files appear in NO diff, so a change made mostly of new
files looks empty to \`git diff\` and would otherwise go entirely unreviewed —
the most common shape for a new module, and the easiest to miss. Treat those
files as added in full.

If a target was passed as an argument, review that target instead. Treat all of
the above as the review scope.
`;
}

/** How cleanup findings state their cost, and how they rank against bugs. */
export const CLEANUP_SHAPE = `Cleanup, altitude, and conventions candidates use the same
\`file\`/\`line\`/\`summary\` shape; in \`failure_scenario\`, state the concrete
cost (what is duplicated, wasted, harder to maintain, or which rule is broken)
instead of a crash. Correctness bugs always outrank cleanup, altitude, and
conventions findings when the output cap forces a cut.
`;

/** The three verdicts a verifier may return. */
export const VERDICTS = `- **CONFIRMED** — can name the inputs/state that trigger it and the wrong
  output or crash. Quote the line.
- **PLAUSIBLE** — mechanism is real, trigger is uncertain (timing, env,
  config). State what would confirm it.
- **REFUTED** — factually wrong (code doesn't say that) or guarded elsewhere.
  Quote the line that proves it.`;

/**
 * The bias that makes a verify pass useful instead of destructive.
 *
 * Without it verifiers refute nearly everything — "depends on runtime state"
 * describes most real bugs — and the review returns an empty list that reads
 * like a clean bill of health.
 */
export const PLAUSIBLE_BY_DEFAULT = `**PLAUSIBLE by default** — do not refute a candidate for being "speculative" or
"depends on runtime state" when the state is realistic: concurrency races,
nil/undefined on a rare-but-reachable path (error handler, cold cache, missing
optional field), falsy-zero treated as missing, off-by-one on a boundary the
code does not exclude, retry storms / partial failures, regex/allowlist that
lost an anchor. These are PLAUSIBLE.

**REFUTED** only when constructible from the code: factually wrong (quote the
actual line); provably impossible (type/constant/invariant — show it); already
handled in this diff (cite the guard); or pure style with no observable effect.`;

/** The report contract. `cap` is the level's ceiling on surviving findings. */
export function outputContract(cap: number, uncertaintyAllowed: boolean): string {
	const uncertainty = uncertaintyAllowed
		? `Include PLAUSIBLE findings as well as CONFIRMED ones, and label each with its
verdict — at this level a missed bug costs more than a false positive.`
		: `Report only CONFIRMED findings. Drop anything you could not confirm rather
than reporting it with a hedge — at this level precision is the whole point.`;

	return `## Output

${uncertainty}

Return findings as a JSON array of at most ${cap} objects:

\`\`\`json
[
  {
    "file": "path/to/file.ext",
    "line": 123,
    "summary": "one-sentence statement of the bug",
    "failure_scenario": "concrete inputs/state → wrong output/crash"
  }
]
\`\`\`

Ranked most-severe first. If more than ${cap} survive, keep the ${cap} most
severe. If nothing survives, return \`[]\` and say so plainly rather than
padding the list to look thorough.
`;
}

/**
 * How many finder subagents a diff of `lines` lines deserves.
 *
 * Scaling to size rather than using a fixed fleet is what keeps a two-line fix
 * from spawning eight agents, and a two-thousand-line refactor from getting the
 * same attention as the two-line fix.
 */
export function finderBudget(lines: number): number {
	const wanted = Math.ceil(lines / CONFIG.linesPerFinder);
	return Math.max(CONFIG.minFinders, Math.min(CONFIG.maxFinders, wanted));
}

/**
 * The final sweep: what to look for once the angles are exhausted.
 *
 * Framed as "things no angle above would have named", because a sweep told to
 * "look again" re-finds what it already found. These are the defects that
 * survive an angle-driven pass.
 */
export const SWEEP_FOCUS = `moved or extracted code that dropped a guard or an anchor;
second-tier footguns (a default evaluated once at definition time, non-deterministic
hashing, a lock scope quietly narrowed, predicate methods with side effects);
setup/teardown asymmetry in tests; config defaults flipped.`;

/** Whether a level may report findings it could not confirm. */
export function allowsUncertainty(level: Level): boolean {
	return LEVEL_SPECS[level].uncertain;
}
