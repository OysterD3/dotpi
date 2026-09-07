/**
 * The turn /research injects, assembled per depth and per fan-out.
 *
 * The prompt is the product here, so it is asserted on directly in the tests: a
 * depth that stopped naming its own angle count, or a fan-out variant that
 * stopped admitting it ran inline, is a real regression with no other symptom.
 *
 * ## Why the phases are split where they are
 *
 * Workflow subagents spawn with `--no-extensions`, so they have no web_search
 * and no fetch — those are an extension's tools, and children get plain pi. The
 * session agent is the ONLY thing in a pi session that can reach the network.
 *
 * That is not a limitation to route around; it is the seam. The session agent
 * does the I/O and writes each source to a file, and the fleet supplies the
 * thing one context cannot: reading forty sources without any of them
 * displacing each other. Fetch in the parent, read in the fleet, and the
 * parent's context carries URLs rather than forty pages of prose.
 */

import { type Depth, DEPTH_SPECS, type FanOut, anglesFor, CONFIG, sourceBudget } from "./config.ts";

export type ResearchPlan = {
	question: string;
	depth: Depth;
	fanOut: FanOut;
	/** Where the fetched sources go. Absolute. */
	dir: string;
	/** Where the report goes, relative to the project. */
	out: string;
};

/** The source-file contract. The fleet reads exactly this, so it is stated once. */
function sourceContract(dir: string): string[] {
	return [
		"Write every source you fetch to its own file, numbered in the order you fetched it:",
		"",
		"    " + dir + "/src-01.md, src-02.md, …",
		"",
		"Each file opens with this block and nothing before it:",
		"",
		"    ---",
		"    url: <the absolute URL you fetched>",
		"    title: <the page title, or the best one-line description you have>",
		"    angle: <which angle above sent you here>",
		"    dated: <the publication date if the page states one, else unknown>",
		"    kind: <primary | secondary | vendor | opinion | unknown>",
		"    ---",
		"",
		"Below it, the EXTRACTED TEXT of the page — not the raw HTML, not your summary of it.",
		"A summary here is the whole failure this design exists to avoid: the readers would then be",
		"reading you, and every one of them would inherit whatever you already decided.",
		"",
		"`kind` is a judgement you are well placed to make and they are not, because you saw where the",
		"link came from. A vendor's own benchmark is `vendor` however peer-reviewed it looks.",
		"",
		"Also write " + dir + "/question.md: the question, the angles you took, and — this part matters —",
		"the promising results you did NOT fetch, with a line on why. That file is how the report can",
		"say what was left unread instead of implying the sweep was exhaustive.",
	];
}

function sweepPhase(plan: ResearchPlan): string[] {
	const spec = DEPTH_SPECS[plan.depth];
	const angles = anglesFor(plan.depth);
	return [
		"## Phase 1 — Sweep (you, with your own tools)",
		"",
		"You are the only thing in this session that can reach the network. Do this part yourself.",
		"",
		"Take these " + angles.length + " angles, and treat them as " + angles.length + " different SEARCHES, not one search rephrased:",
		"",
		...angles.map((angle) => "- **" + angle.key + "** — " + angle.brief),
		"",
		"Fetch about " + spec.perAngle + " sources per angle (" + sourceBudget(plan.depth) + " or so in total). Fetch fewer when an angle",
		"genuinely has nothing, and say so in question.md — an angle that came back empty is a finding.",
		"Never fetch the same URL twice, even when two angles surface it; number it once.",
		"",
		...sourceContract(plan.dir),
	];
}

function readPhase(plan: ResearchPlan): string[] {
	if (plan.fanOut === "workflow") {
		return [
			"## Phase 2 — Read (the fleet)",
			"",
			"Then call the `workflow` tool with the saved workflow, and pass it the files you wrote.",
			"The workflow tool asks for an explicit opt-in before it fans out: running /research IS that",
			"opt-in. Do not wait for the ultracode keyword and do not stop to ask.",
			"",
			"",
			"    workflow({",
			'      name: "' + CONFIG.workflow + '",',
			"      args: {",
			"        question: <the question, verbatim>,",
			'        dir: "' + plan.dir + '",',
			'        sources: ["src-01.md", "src-02.md", …],',
			'        out: "' + plan.out + '",',
			"        refute: " + String(DEPTH_SPECS[plan.depth].refute),
			"      }",
			"    })",
			"",
			"It runs in the background: one reader per source, then one cross-check over all the extracts,",
			"then the report, then a gate that checks the file is really on disk. Do NOT pass wait: true,",
			"and do NOT read the sources yourself while it runs — that is the context you just avoided",
			"spending. Say what is in flight and END YOUR TURN. The result comes back as a message.",
		];
	}
	if (plan.fanOut === "task") {
		return [
			"## Phase 2 — Read (subagents, one at a time)",
			"",
			"There is no `workflow` tool in this session, so use `task`: one subagent per source file, each",
			"told to read exactly that file and return what it says about the question, with verbatim",
			"quotes. Do not hand one subagent the whole directory — that rebuilds the single context this",
			"is meant to escape, just somewhere you cannot see it.",
			"",
			"Then do the cross-check yourself, over the extracts rather than over the pages.",
		];
	}
	return [
		"## Phase 2 — Read (inline, because there is no fan-out here)",
		"",
		"Neither `workflow` nor `task` is active in this session, so you read the sources yourself, one",
		"file at a time. Say so in the report: a sweep whose reading all landed in one context is a",
		"shallower thing than one that did not, and the reader deserves to know which they have.",
	];
}

function crossRules(plan: ResearchPlan): string[] {
	const lines = [
		"## The rules that make it research",
		"",
		"- **No claim without a source.** Every assertion in the report carries the URL it came from.",
		"  A sentence you cannot attribute is your prior, and it goes in Open questions or nowhere.",
		"- **Contradictions are surfaced, never averaged.** Two sources disagreeing is the most useful",
		"  thing a sweep returns. Report both, name which is primary, and say what would settle it.",
		"- **Agreement is checked for independence.** Six pages restating one press release is one",
		"  source. Trace the claim back before counting it twice.",
		"- **Say what you could not find.** An angle that came back empty, a paywalled primary source,",
		"  a benchmark nobody published — those bound the answer, and an unbounded answer is a guess",
		"  with citations.",
	];
	if (DEPTH_SPECS[plan.depth].refute) {
		lines.push(
			"- **The answer is refuted before it is written.** This is a deep run: three independent",
			"  lenses try to break the answer — does the evidence actually say this, is the strongest",
			"  counter-source being discounted, is this resting on one source — and a majority against",
			"  it means the answer changes rather than gets a caveat.",
		);
	}
	return lines;
}

function reportPhase(plan: ResearchPlan): string[] {
	return [
		"## Phase 3 — Report",
		"",
		"The deliverable is ONE self-contained HTML file at `" + plan.out + "`: inline CSS, no external",
		"requests, no build step, readable offline. It carries the answer, the confidence and why,",
		"the contradictions, a sources table with every URL and its kind, and the open questions.",
		"",
		plan.fanOut === "workflow"
			? "The fleet writes it. When the result lands, read it and give the user the headline, the confidence, and the path — not a re-summary of the report you just had written."
			: "Write it yourself, then give the user the headline, the confidence and the path.",
	];
}

export function researchPrompt(plan: ResearchPlan): string {
	return [
		"# Deep research: " + plan.question,
		"",
		"Depth: **" + plan.depth + "**. Work through the phases below in order.",
		"",
		...sweepPhase(plan),
		"",
		...readPhase(plan),
		"",
		...crossRules(plan),
		"",
		...reportPhase(plan),
	].join("\n");
}
