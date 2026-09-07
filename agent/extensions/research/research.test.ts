/**
 * Unit coverage for /research: argument parsing, slugs, source directories,
 * fan-out detection, the depth table, and the assembled prompt.
 *
 * Run it after editing this extension, from a directory where pi's packages
 * resolve:
 *     bun run agent/extensions/research/research.test.ts
 *
 * The prompt is the product, so it is asserted on directly — a depth that
 * stopped naming its own angle count, or a fan-out variant that stopped
 * admitting it ran inline, is a real regression with no other symptom.
 *
 * The last block validates agent/workflows/deep-research.js against the real
 * engine. That is the half of the contract this extension does not contain: the
 * prompt tells the model to write src-NN.md files and call a saved workflow by
 * name, and none of that is worth anything if the script it names does not
 * parse. It SKIPs rather than fails when dynamic-workflow is not installed,
 * because every extension here has to stand on its own.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs, slugify, tokenize } from "./args.ts";
import { anglesFor, ANGLES, CONFIG, DEPTHS, DEPTH_SPECS, sourceBudget } from "./config.ts";
import { detectFanOut, sourceDir } from "./index.ts";
import { researchPrompt } from "./prompt.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// -------------------------------------------------------------------- args

console.log("--- parsing [--depth] <question> ---");
check("bare is the default depth and no question", parseArgs(""), {
	depth: CONFIG.defaultDepth,
	question: "",
	unknownFlags: [],
	extraDepths: [],
});
check("a question alone", parseArgs("does prompt caching help").question, "does prompt caching help");
check("a depth flag is taken", parseArgs("--deep does it help").depth, "deep");
check("and leaves the question intact", parseArgs("--deep does it help").question, "does it help");
check("the flag can trail", parseArgs("does it help --quick").depth, "quick");
check("case-insensitive", parseArgs("--DEEP x").depth, "deep");
// The reason the depth is a flag and not a leading positional word: a question
// is free text, and plenty of them open with a depth name.
check("a question opening with a depth name keeps it", parseArgs("deep learning on small datasets"), {
	depth: CONFIG.defaultDepth,
	question: "deep learning on small datasets",
	unknownFlags: [],
	extraDepths: [],
});
check("first depth wins", parseArgs("--quick --deep x").depth, "quick");
check("and the loser is reported, not dropped", parseArgs("--quick --deep x").extraDepths, ["--deep"]);
check("unknown flags are kept for a warning", parseArgs("--fix x").unknownFlags, ["--fix"]);
check("and do not become part of the question", parseArgs("--fix x").question, "x");
check("whitespace collapses", parseArgs("  a   b  ").question, "a b");
check("tokenize drops empties", tokenize("  a   b "), ["a", "b"]);

console.log("\n--- slugs ---");
check("lowercased and hyphenated", slugify("Does Prompt Caching Help?"), "does-prompt-caching-help");
check("punctuation collapses to one hyphen", slugify("a -- b // c"), "a-b-c");
check("no leading or trailing hyphen", slugify("  ...what now?  "), "what-now");
check("capped", slugify("a".repeat(200)).length, 48);
// A truncation that lands on a separator must not leave a trailing hyphen.
check("and the cap does not leave a dangling hyphen", slugify("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa b"), "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
// A nameless file is worse than a generic one.
check("nothing usable still gets a name", slugify("???"), "research");

console.log("\n--- fan-out and where the sources go ---");
check("workflow wins over task", detectFanOut(["task", "workflow", "read"]), "workflow");
check("task when it is the only one", detectFanOut(["task"]), "task");
check("neither is none", detectFanOut(["read", "bash"]), "none");
check("an empty tool list is none", detectFanOut([]), "none");
check("the scratchpad is used when announced", sourceDir("/tmp/pi/scratch", "abc"), "/tmp/pi/scratch/research-abc");
check("and the run still has a home without one", sourceDir(undefined, "abc").endsWith("research-abc"), true);
check("which is not inside the project", sourceDir(undefined, "abc").startsWith("/"), true);

console.log("\n--- the depth table ---");
check("every depth has a spec", DEPTHS.every((depth) => DEPTH_SPECS[depth] !== undefined), true);
// Depth has to buy something at every step, or the flag is decoration.
check("angles grow with depth", [anglesFor("quick").length, anglesFor("standard").length, anglesFor("deep").length], [3, 5, 8]);
check("and so does the source budget", [sourceBudget("quick"), sourceBudget("standard"), sourceBudget("deep")], [9, 20, 40]);
check("only deep refutes", DEPTHS.filter((depth) => DEPTH_SPECS[depth].refute), ["deep"]);
check("no depth asks for more angles than exist", DEPTHS.every((depth) => DEPTH_SPECS[depth].angles <= ANGLES.length), true);
// The angles are modalities, so a duplicate key would be one search run twice.
check("angle keys are distinct", new Set(ANGLES.map((angle) => angle.key)).size, ANGLES.length);
check("angles are taken cheapest first", anglesFor("quick").map((angle) => angle.key), ["definition", "primary", "counter"]);

// ------------------------------------------------------------------ prompt

console.log("\n--- the assembled prompt ---");
const plan = { question: "does prompt caching help agent loops?", depth: "standard" as const, fanOut: "workflow" as const, dir: "/scratch/research-x", out: "docs/research/x.html" };
const withWorkflow = researchPrompt(plan);
const withTask = researchPrompt({ ...plan, fanOut: "task" });
const inline = researchPrompt({ ...plan, fanOut: "none" });
const deep = researchPrompt({ ...plan, depth: "deep", question: "q" });

check("the question leads it", withWorkflow.startsWith("# Deep research: does prompt caching help agent loops?"), true);
check("the depth is named", withWorkflow.includes("Depth: **standard**"), true);
// The sweep is the session agent's job because it is the only thing with a
// network. A prompt that leaves that implicit invites a fleet that cannot search.
check("the sweep says who runs it", withWorkflow.includes("You are the only thing in this session that can reach the network"), true);
check("every angle for the depth is listed", anglesFor("standard").every((angle) => withWorkflow.includes("**" + angle.key + "**")), true);
check("and no angle beyond it", withWorkflow.includes("**provenance**"), false);
check("deep lists them all", ANGLES.every((angle) => deep.includes("**" + angle.key + "**")), true);
check("the source budget is stated", withWorkflow.includes("20 or so in total"), true);

// The file contract is what the readers consume; the two halves must agree.
check("the file naming is exact", withWorkflow.includes("/scratch/research-x/src-01.md"), true);
check("the front-matter block is spelled out", withWorkflow.includes("kind: <primary | secondary | vendor | opinion | unknown>"), true);
check("and summarising instead of extracting is ruled out", withWorkflow.includes("not your summary of it"), true);
check("the unfetched results are recorded too", withWorkflow.includes("question.md"), true);

// The workflow tool refuses to fan out without an explicit opt-in, and pi's
// list of what counts does not include slash commands. Left unsaid, the model
// reads that rule and asks — or quietly runs inline — with ultracode off.
check("the command is stated to BE the opt-in", withWorkflow.includes("running /research IS that"), true);
check("the workflow variant names the saved workflow", withWorkflow.includes('name: "' + CONFIG.workflow + '"'), true);
check("and passes the depth's refute setting", withWorkflow.includes("refute: false"), true);
check("deep passes it on", deep.includes("refute: true"), true);
// A blocking workflow call spends the turn the fleet exists to free.
check("it is told not to block", withWorkflow.includes("Do NOT pass wait: true"), true);
check("and not to read the sources itself", withWorkflow.includes("do NOT read the sources yourself"), true);

check("the task variant uses task", withTask.includes("use `task`: one subagent per source file"), true);
check("and refuses the one-agent shortcut", withTask.includes("Do not hand one subagent the whole directory"), true);
check("the inline variant admits it", inline.includes("there is no fan-out here"), true);
check("and says the report must admit it too", inline.includes("Say so in the report"), true);
check("no variant claims a tool it was not given", [withTask.includes("workflow({"), inline.includes("workflow({")], [false, false]);

check("the rules are stated", withWorkflow.includes("No claim without a source"), true);
check("contradictions are not averaged", withWorkflow.includes("surfaced, never averaged"), true);
check("agreement is checked for independence", withWorkflow.includes("checked for independence"), true);
check("only deep announces the refutation pass", [withWorkflow.includes("refuted before it is written"), deep.includes("refuted before it is written")], [false, true]);
check("the output path is named", withWorkflow.includes("docs/research/x.html"), true);
check("and it has to be self-contained", withWorkflow.includes("self-contained HTML"), true);

// --------------------------------------------------- the other half of it

console.log("\n--- the saved workflow ---");
{
	const script = join(import.meta.dirname, "..", "..", "workflows", CONFIG.workflow + ".js");
	const engine = join(import.meta.dirname, "..", "dynamic-workflow", "engine.ts");
	if (!existsSync(script)) {
		failures++;
		console.log(`FAIL  ${CONFIG.workflow}.js is missing — /research names it in every workflow-variant prompt`);
	} else if (!existsSync(engine)) {
		console.log("  SKIP  dynamic-workflow is not installed, so the script cannot be validated");
	} else {
		const source = readFileSync(script, "utf8");
		const { validateScript } = await import(engine);
		let meta: { name?: string; phases?: Array<{ title: string }> } | undefined;
		let error: string | undefined;
		try {
			meta = validateScript(source).meta;
		} catch (thrown) {
			error = thrown instanceof Error ? thrown.message : String(thrown);
		}
		check("it parses and compiles against the real engine", error, undefined);
		// The name is how /research reaches it; a rename here is a silent 404 there.
		check("its name is the one the prompt calls", meta?.name, CONFIG.workflow);
		check("and it declares the four phases", meta?.phases?.map((phase) => phase.title), ["Read", "Cross-check", "Write", "Gate"]);
		// The gate is the only verdict in the run no agent authored.
		check("the gate is shell(), not an agent", source.includes("await shell("), true);
		check("and it is written as exitCode === 0", source.includes("gate.exitCode === 0"), true);
		// Readers that can edit are readers that can wander off and fix something.
		check("readers are read-only", source.includes('tools: ["read", "grep", "find", "ls"]'), true);
	}
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
