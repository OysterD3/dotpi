/**
 * Assembling the prompt each command injects.
 *
 * Both commands are prompts, not procedures: the work is done by the agent in
 * the session, using whatever tools it has. What this file decides is which
 * shape of instruction it gets, and the deciding factor is fan-out — whether a
 * subagent tool is active right now.
 *
 * That matters enough to be said out loud in the prompt. A single-pass inline
 * review and a fleet of independent reviewers produce different coverage, and
 * a summary that does not distinguish them misleads whoever reads it into
 * thinking the deeper thing ran. So the inline variants are instructed to say
 * what actually happened.
 *
 * Pure — no pi APIs, no git — so every variant is testable as a string.
 */

import { SIMPLIFY_ANGLES } from "./angles.ts";
import { anglesFor, cleanupAngles, CONFIG, type FanOut, LEVEL_SPECS, type Level } from "./config.ts";
import { CLEANUP_SHAPE, gatherDiff, outputContract, PLAUSIBLE_BY_DEFAULT, SWEEP_FOCUS, VERDICTS } from "./phases.ts";

/** A review target passed as an argument: a path, a ref range, a PR number. */
function targetLine(target: string): string {
	return target ? `Review target: \`${target}\`\n\n` : "";
}

function count(n: number, word: string): string {
	return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * How the angles are shared out among the finders.
 *
 * Both directions have to be stated. An earlier version only covered "more
 * finders than angles", which is the rare case; when the fleet is smaller than
 * the angle list — a small diff at max effort, say — the prompt said "one per
 * angle" and most angles simply went unassigned, while the header still
 * advertised the widest review.
 */
function assignment(finders: number, angles: number): string {
	if (finders >= angles) {
		return `There are ${count(angles, "angle")} and ${count(finders, "finder")}: give each angle its own
finder, and put the spare finders back on the angles most relevant to this diff.
Every angle must be assigned to at least one finder.`;
	}
	return `There are ${count(angles, "angle")} but only ${count(finders, "finder")}: split the angle
list between them so that **every angle is assigned to exactly one finder** —
no angle may be dropped for lack of a finder. Tell each finder which angles it
owns.`;
}

/**
 * The apply step, shared by both /simplify shapes.
 *
 * `lead` is the only thing that differs between them (the fan-out variant waits
 * for its agents first), so it is a parameter rather than an excuse to retype
 * the paragraph — the skip rule below is the part that must not drift.
 */
function applyFixesSection(opening = "Dedup"): string {
	return `## Phase 2 — Apply the fixes

${opening} findings that point at the same line or mechanism, and fix each
remaining one directly. Skip any finding whose fix would change intended
behavior, require changes well outside the reviewed diff, or that you judge to
be a false positive — note the skip rather than arguing with it. Finish with a
brief summary of what was fixed and what was skipped (or confirm the code was
already clean).`;
}

const SIMPLIFY_LEAD = `You are improving the quality of the changed code, not hunting for bugs. Review
it for reuse, simplification, efficiency, and altitude issues, then fix what you
find. Do not look for correctness bugs — that is what \`/code-review\` is for.`;

/**
 * `/simplify`, in both shapes.
 *
 * The fan-out variant is the real one: four independent reviewers, each blind
 * to what the others are looking at, because one reviewer told to consider four
 * angles reliably spends its attention on whichever angle it noticed first.
 */
export function simplifyPrompt(fanOut: FanOut, target: string): string {
	const angles = SIMPLIFY_ANGLES.join("\n");

	if (fanOut === "none") {
		return `\`/simplify → no subagent tool → single-pass inline cleanup → apply the fixes\`

${SIMPLIFY_LEAD}

No subagent tool is active in this session, so the usual ${CONFIG.simplifyAngles}-agent fan-out
can't run. Work through all four angles below yourself, in this same context,
in one pass — do not skip an angle for lack of fan-out.

${targetLine(target)}${gatherDiff(0)}
## Phase 1 — Review (${CONFIG.simplifyAngles} cleanup angles, single pass)

Review the diff against each angle below in turn. For each, note findings with
\`file\`, \`line\`, a one-line \`summary\`, and the concrete cost (what is
duplicated, wasted, or harder to maintain).

${angles}
${applyFixesSection()} State clearly in your summary that this was a
single-pass review done without a subagent tool, not the full
${CONFIG.simplifyAngles}-agent fan-out, so whoever reads it isn't misled about what actually ran.
`;
	}

	const spawn =
		fanOut === "workflow"
			? `Run **${CONFIG.simplifyAngles} independent review agents** with the \`workflow\` tool, one per angle,
in a single parallel phase so they run concurrently.`
			: `Launch **${CONFIG.simplifyAngles} independent review agents** via the \`task\` tool, all in a
single message so they run concurrently.`;

	return `\`/simplify → ${CONFIG.simplifyAngles} cleanup agents in parallel → apply the fixes\`

${SIMPLIFY_LEAD}

${targetLine(target)}${gatherDiff(0)}
## Phase 1 — Review (${CONFIG.simplifyAngles} cleanup agents in parallel)

${spawn} Pass each agent the diff and exactly one of
the four angles below — one angle per agent, all four covered. Each returns its
findings with \`file\`, \`line\`, a one-line \`summary\`, and the concrete cost
(what is duplicated, wasted, or harder to maintain).

${angles}
${applyFixesSection(`Wait for all ${CONFIG.simplifyAngles} agents to complete, then dedup`)}
`;
}

/** The lead-in that sets a level's precision/recall bias. */
function reviewLead(level: Level): string {
	if (level === "low" || level === "medium") {
		return `You are reviewing for **precision** at ${level} effort: every finding you surface
should be one you can defend from the code. Fewer, certain findings beat a long
list that someone else has to triage.`;
	}
	const name = level === "max" ? "maximum" : level === "xhigh" ? "extra-high" : "high";
	return `You are reviewing for **recall** at ${name} effort: catch every real bug a careful
reviewer would. A missed defect costs more here than a finding that turns out to
be uncertain, so surface the uncertain ones and label them.`;
}

/**
 * `/code-review`, in three shapes.
 *
 * The verify pass is what separates this from a list of guesses: candidates are
 * re-checked by someone whose job is to refute them. It only exists in the
 * fan-out shapes, because a reviewer cannot meaningfully adversarially verify
 * its own finding in the same breath it made it — so the inline shape says so
 * rather than pretending otherwise.
 */
export function codeReviewPrompt(level: Level, fanOut: FanOut, target: string, finders: number, fix: boolean): string {
	const { cap, uncertain, sweep: sweeps } = LEVEL_SPECS[level];
	const angles = anglesFor(level);
	const angleText = angles.join("\n");
	const hasCleanup = cleanupAngles(level).length > 0;
	const output = outputContract(cap, uncertain);

	// Phases are numbered as they are emitted rather than hardcoded: the inline
	// shape has no verify or report phase, and only the top level sweeps, so a
	// fixed number produced prompts that jumped from Phase 2 to Phase 4. The
	// gather phase draws from the same counter, so the sequence has one owner.
	let phase = 0;
	const next = () => phase++;
	const gather = gatherDiff(next());

	const sweepClause = (n: number) => `\n## Phase ${n} — Sweep for gaps

Take one more pass yourself, as a fresh reviewer holding the deduplicated list.
Re-read the diff and the enclosing functions looking ONLY for defects nothing
above would have named: ${SWEEP_FOCUS}
`;

	const applyClause = (n: number) =>
		`\n## Phase ${n} — Apply\n\nAfter reporting, fix each surviving finding directly. Skip any whose fix would\nchange intended behavior or reach well outside the reviewed diff, and say which\nyou skipped and why.\n`;

	if (fanOut === "none") {
		const find = next();
		const check = next();
		const sweep = sweeps ? sweepClause(next()) : "";
		const apply = fix ? applyClause(next()) : "";

		return `\`/code-review ${level} → no subagent tool → single-pass inline → ≤${cap} findings\`

${reviewLead(level)}

No subagent tool is active, so the usual finder fan-out and the independent
verify pass can't run. Work through the angles below yourself, in sequence, in
this same context — do not skip one for lack of fan-out.

${targetLine(target)}${gather}
## Phase ${find} — Find candidates (${count(angles.length, "angle")}, single pass)

Work through each angle in turn. Each surfaces candidate findings with
\`file\`, \`line\`, a one-line \`summary\`, and a concrete \`failure_scenario\`.

${angleText}
${hasCleanup ? CLEANUP_SHAPE : ""}
## Phase ${check} — Dedup and self-check

Dedup near-duplicates (same defect, same location, same reason → keep one).
Re-check each remaining candidate yourself against the diff before keeping it,
using this rubric:

${VERDICTS}

${PLAUSIBLE_BY_DEFAULT}
${sweep}
${output}${apply}
State in your summary that this was a single-pass inline review with no
independent verify pass, so its coverage isn't mistaken for the full run.
`;
	}

	const fleet =
		fanOut === "workflow"
			? `Author a \`workflow\` script that runs **${count(finders, "finder agent")}** concurrently,
then pipelines each candidate into an independent **verifier** agent whose job is
to refute it. Use \`pipeline()\` so a candidate starts verifying as soon as its
finder returns, rather than waiting for the slowest finder.`
			: `Launch **${count(finders, "finder agent")}** via the \`task\` tool in a single message.
When they return, launch one **verifier** agent per surviving candidate — again
in a single message — whose job is to refute it.`;

	const find = next();
	const verify = next();
	const sweep = sweeps ? sweepClause(next()) : "";
	const report = next();
	const apply = fix ? applyClause(next()) : "";

	return `\`/code-review ${level} → ${count(finders, "finder")} + verify → ≤${cap} findings\`

${reviewLead(level)}

${targetLine(target)}${gather}
## Phase ${find} — Find candidates (${count(finders, "agent")})

${fleet}

${assignment(finders, angles.length)}

Each finder returns candidates with \`file\`, \`line\`, a one-line \`summary\`,
and a concrete \`failure_scenario\`.

${angleText}
${hasCleanup ? CLEANUP_SHAPE : ""}
## Phase ${verify} — Verify

Dedup near-duplicates first (same defect, same location, same reason → keep
one), so the same finding is not verified twice. Every verifier is told to
REFUTE the finding it is given, and returns one verdict:

${VERDICTS}

${PLAUSIBLE_BY_DEFAULT}
${sweep}
## Phase ${report} — Report

Drop everything REFUTED. Rank what survives most-severe first.

${output}${apply}`;
}
