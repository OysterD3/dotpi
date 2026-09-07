export const meta = {
	name: "deep-research",
	description: "read fetched sources in parallel, cross-check them, and write one self-contained HTML report",
	phases: [
		{ title: "Read", detail: "one agent per source" },
		{ title: "Cross-check", detail: "contradictions, independence, gaps" },
		{ title: "Write", detail: "one self-contained HTML file" },
		{ title: "Gate", detail: "the file is really on disk" },
	],
};

/**
 * deep-research — read every fetched source in parallel, cross-check them, and
 * write one self-contained HTML report.
 *
 * Called by /research (agent/extensions/research). The session agent does the
 * sweep, because workflow subagents spawn with --no-extensions and therefore
 * have no web_search and no fetch; this script starts where the pages are
 * already on disk. It is a SAVED workflow rather than one the model authors per
 * run because the source-file contract in the command's prompt and the reader
 * that consumes it are two halves of one contract.
 *
 * args: { question, dir, sources: ["src-01.md", …], out, refute? }
 */

const input = args || {};
const question = input.question;
const dir = input.dir;
const out = input.out;
const sources = Array.isArray(input.sources) ? input.sources : [];

if (!question || !dir || !out || sources.length === 0) {
	return { error: "deep-research needs args: { question, dir, sources: [...], out }", got: Object.keys(input) };
}

const EXTRACT = {
	type: "object",
	required: ["url", "relevant", "claims"],
	properties: {
		url: { type: "string" },
		title: { type: "string" },
		kind: { type: "string", description: "primary | secondary | vendor | opinion | unknown, from the source's own header" },
		dated: { type: "string" },
		relevant: { type: "boolean", description: "false when this source says nothing that bears on the question" },
		claims: {
			type: "array",
			items: {
				type: "object",
				required: ["claim", "quote"],
				properties: {
					claim: { type: "string", description: "what this source says, in one sentence" },
					quote: { type: "string", description: "the words it says it in, verbatim, from the file" },
					evidence: { type: "string", description: "what the source offers in support: data, a citation, or none" },
				},
			},
		},
		unsupported: { type: "array", items: { type: "string" }, description: "assertions it makes with nothing behind them" },
		derivedFrom: { type: "string", description: "if it is restating another source, that source" },
	},
};

const CROSS = {
	type: "object",
	required: ["answer", "confidence", "why", "contradictions", "independence", "gaps"],
	properties: {
		answer: { type: "string", description: "the answer to the question, in one paragraph" },
		confidence: { type: "string", description: "high | medium | low" },
		why: { type: "string", description: "what the confidence rests on, and what would move it" },
		agreements: { type: "array", items: { type: "string" } },
		contradictions: {
			type: "array",
			items: {
				type: "object",
				required: ["claim", "sides", "settles"],
				properties: {
					claim: { type: "string" },
					sides: { type: "array", items: { type: "string" }, description: "each side, with the URL that holds it" },
					settles: { type: "string", description: "what evidence would settle it" },
				},
			},
		},
		independence: { type: "array", items: { type: "string" }, description: "claims that look corroborated but trace to one origin" },
		gaps: { type: "array", items: { type: "string" }, description: "what the sweep could not establish, and why" },
	},
};

const VERDICT = {
	type: "object",
	required: ["holds", "reason"],
	properties: {
		holds: { type: "boolean", description: "false if this lens breaks the answer" },
		reason: { type: "string" },
		revised: { type: "string", description: "the answer this lens would accept, if it broke the first one" },
	},
};

// One agent per source. They are read-only on purpose: a reader that can edit
// is a reader that can decide to go fix something it noticed.
phase("Read");
const extracts = await parallel(
	sources.map((file, index) => () =>
		agent(
			[
				"Read the single file " + dir + "/" + file + ". It is one web page, fetched and saved.",
				"",
				"The research question: " + question,
				"",
				"Return what THIS source says that bears on that question, with the words it uses — quote from the file,",
				"do not paraphrase into a claim it did not make. Its front-matter block carries the url, title, dated and",
				"kind; copy them across rather than inferring them.",
				"",
				"If it says nothing that bears on the question, set relevant false and return no claims. That is a useful",
				"answer and a stretched one is not. If it is plainly restating another source, say which in derivedFrom —",
				"six pages repeating one press release must not read as six sources agreeing.",
				"",
				"Read only this file. Another agent has each of the others.",
			].join("\n"),
			{
				label: "read:" + String(file).replace(/\.md$/, ""),
				phase: "Read",
				tools: ["read", "grep", "find", "ls"],
				schema: EXTRACT,
			},
		),
	),
);

const read = extracts.filter(Boolean);
const useful = read.filter((extract) => extract.relevant !== false);
log(read.length + "/" + sources.length + " sources read, " + useful.length + " with something to say");

if (useful.length === 0) {
	return { out: null, sources: sources.length, read: read.length, error: "no source said anything about the question" };
}

// A barrier, and it earns it: this stage exists to compare every extract with
// every other one. Contradiction and independence are properties of the SET.
phase("Cross-check");
let cross = await agent(
	[
		"Below are structured extracts, one per source, for this question:",
		"",
		question,
		"",
		"Answer it from them, and treat the set as the evidence rather than the individual pages.",
		"",
		"- Where sources disagree, report BOTH sides with their URLs and say what would settle it. Do not average them.",
		"- Where they agree, check the agreement is independent: anything with derivedFrom, or several sources sharing one",
		"  origin, counts once. Say which agreements are thinner than they look.",
		"- Name the gaps: what the sweep could not establish, and whether that is because nobody has published it or",
		"  because the sweep did not reach it.",
		"- Confidence is about the evidence, not about your fluency. One vendor benchmark is low however clear it is.",
	].join("\n"),
	{ phase: "Cross-check", schema: CROSS, context: { text: JSON.stringify(useful) } },
);

// A failed cross-check must not fall through to Write. The writer is told to
// take the answer from it, so a null one is answered by improvisation — an
// unchecked report, in a feature whose whole claim is checked evidence.
if (!cross) {
	return { out: null, sources: { fetched: sources.length, read: read.length, useful: useful.length }, error: "the cross-check failed; no report was written" };
}

// The deep run's difference: the answer is attacked before it is written, by
// three lenses rather than three copies of one skeptic. A majority against it
// replaces the answer instead of decorating it with a caveat.
let refuted = null;
if (input.refute && cross) {
	const LENSES = [
		"Does the evidence actually say this? Check the answer against the quotes, not against plausibility.",
		"Is the strongest counter-source being discounted? Find the extract that most disagrees and see whether it was handled or waved past.",
		"Is this resting on one source? Trace the load-bearing claim back and see how many independent origins hold it up.",
	];
	const votes = (
		await parallel(
			LENSES.map((lens, index) => () =>
				agent(
					[
						"Try to REFUTE this answer through one lens. Default to holds=false when you are unsure —",
						"an answer that survives only because you were generous is the failure this stage exists to catch.",
						"",
						"Lens: " + lens,
						"",
						"The answer: " + cross.answer,
						"",
						"Its stated confidence: " + cross.confidence + " — because: " + cross.why,
					].join("\n"),
					{ label: "refute:" + String(index + 1), phase: "Cross-check", schema: VERDICT, context: { text: JSON.stringify(useful) } },
				),
			),
		)
	).filter(Boolean);

	const broke = votes.filter((vote) => vote.holds === false);
	log(broke.length + "/" + votes.length + " lenses broke the answer");
	if (broke.length > votes.length / 2) {
		refuted = broke.map((vote) => vote.reason);
		cross = await agent(
			[
				"A majority of independent lenses broke this answer. Write the one the evidence supports instead —",
				"not the same answer with a caveat bolted on.",
				"",
				"The answer they broke: " + cross.answer,
				"",
				"Why each broke it:",
				...broke.map((vote) => "- " + vote.reason + (vote.revised ? " — would accept: " + vote.revised : "")),
			].join("\n"),
			{ label: "revise", phase: "Cross-check", schema: CROSS, context: { text: JSON.stringify(useful) } },
		);
	}
}

const HTML_SPEC = [
	"ONE self-contained HTML file: inline <style>, no external stylesheet, no font import, no script that",
	"fetches anything. It has to open from disk on a machine with no network.",
	"",
	"- A system font stack, a max width around 46rem, generous line height.",
	"- Light and dark both, via prefers-color-scheme. Never a hardcoded white background.",
	"- The answer first and whole, before any apparatus. A reader who stops after the first screen should",
	"  have the answer and its confidence.",
	"- A confidence badge that states the level AND what it rests on.",
	"- Contradictions as their own section, each with both sides, both URLs, and what would settle it.",
	"- A sources table: title, kind, date, and the URL as a real link. Mark the ones that added nothing.",
	"- Open questions last, including anything the sweep could not reach.",
	"- No claim without a link. If a sentence has no source, it does not go in.",
].join("\n");

phase("Write");
await agent(
	[
		"Write the research report to " + out + ". Create the directory if it is not there.",
		"",
		"The question: " + question,
		"",
		refuted ? "Note: an earlier answer was refuted and replaced. Say so in the report, and say what broke it." : "",
		"",
		HTML_SPEC,
		"",
		"The cross-check result and the per-source extracts are in the context. Use the extracts for the sources",
		"table and for quotes; use the cross-check for the answer, the contradictions and the gaps.",
	]
		.filter(Boolean)
		.join("\n"),
	{
		phase: "Write",
		context: { text: JSON.stringify({ cross: cross, refuted: refuted, sources: useful }) },
	},
);

// The only verdict here no agent authored. An agent reporting that it wrote a
// file is prose; a non-zero exit is not.
phase("Gate");
let gate;
try {
	gate = await shell("test -s " + JSON.stringify(out));
	if (gate.exitCode !== 0) {
		await agent("The report is missing or empty at " + out + ". Write it. " + HTML_SPEC, {
			phase: "Gate",
			context: { text: JSON.stringify({ cross: cross, sources: useful }) },
		});
		gate = await shell("test -s " + JSON.stringify(out));
	}
} catch (error) {
	// shell() is unavailable in an untrusted project. Report that no gate ran
	// rather than claiming one passed.
	gate = { exitCode: null, ungated: String((error && error.message) || error) };
}

return {
	out: out,
	written: gate.exitCode === 0,
	ungated: gate.ungated,
	sources: { fetched: sources.length, read: read.length, useful: useful.length },
	answer: cross && cross.answer,
	confidence: cross && cross.confidence,
	refuted: refuted,
};
