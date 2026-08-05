/**
 * Tests for the opening nudge: what counts as a request that opens new work,
 * and the wiring that turns that into one hidden reminder on that turn.
 *
 * The detector cases are deliberately drawn from real prompts — the ones that
 * should have been asked about and were not, and the mid-task follow-ups that
 * must stay silent. A detector that fires on "fix it for me" would reintroduce
 * asking-instead-of-doing, which is the failure the tool guidance was written
 * against in the first place.
 *
 * Also covers style.ts's model matching, settings.ts's contractModels loader,
 * CONTRACT_NUDGE / contractFollowUpReminder / hasAssumptionsBlock's own
 * wording and detection logic, and the wiring that picks between the two
 * styles and re-arms the contract follow-up on a schedule. The socratic
 * assertions above and below this file's new sections are exactly what they
 * were before those existed — pinning that a model not matched by
 * askUser.contractModels sees byte-identical behaviour to before this file
 * grew a second style.
 *
 * Run: jiti agent/extensions/ask-user/nudge.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ask-nudge-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { CONTRACT_NUDGE, contractFollowUpReminder, followUpReminder, hasAssumptionsBlock, OPENING_NUDGE, opensWork, systemReminder } =
	await import("./nudge.ts");
const { CONFIG, FOLLOWUP_ENTRY_TYPE, NUDGE_ENTRY_TYPE, TOOL_NAME } = await import("./config.ts");
const { loadSettings } = await import("./settings.ts");
const { askStyle } = await import("./style.ts");
const { default: register } = await import("./index.ts");

/** A model shaped enough for style.ts — id/provider are all askStyle reads. */
type FakeModel = { provider: string; id: string };
const OPENAI_MODEL: FakeModel = { provider: "openai", id: "gpt-5.6-sol" };
const ANTHROPIC_MODEL: FakeModel = { provider: "anthropic", id: "claude-opus-5" };

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------- what fires

console.log("--- requests that open work ---");
for (const text of [
	"build me a settings page with a dark mode toggle",
	"Implement retry with exponential backoff for the upload queue",
	"add a caching layer in front of the model registry",
	"Create a CLI that reads the journal and prints a summary",
	"refactor the permission classifier so the rules live in one place",
	"migrate the store from JSON files to sqlite please",
	"write a parser for the run journal format",
	// No work verb at all. This is how a substantial task is most often phrased,
	// and it is the shape of the request that started this whole thread.
	"I want the pi coding agent to achieve token efficiency and proper compaction",
	"we need something that shows which agents failed and why",
	"can you build a dashboard for the workflow runs",
	// Every one of these returned FALSE under the five-word informational scan,
	// each killed by one incidental common word: "do" at index 4, "find" at 4,
	// "look" at 3, "check" at 4. They are exactly the schema/layout-deciding
	// requests the nudge exists for.
	"I need you to do a full rewrite of the sync layer",
	"write a script to find and remove the dead runs",
	"make the dashboard look like the mockup in docs",
	"build the exporter, then check it against the fixture",
	"would you please rewrite the auth module properly",
]) {
	check(JSON.stringify(text.slice(0, 46)), opensWork(text), true);
}

console.log("\n--- turns that must stay silent ---");
for (const text of [
	// Short follow-ups. A request with decisions in it says more than this.
	"Fix it for me",
	"Fix for me",
	"both read fix and guideline",
	"",
	"   ",
	// Continuations: the decisions belong to the turn that opened the work.
	"also make the footer show the elapsed time",
	"now do the same thing for the advisor extension",
	"continue where you left off and finish the remaining files",
	"actually make it a table instead of a list of lines",
	"revert that change and write the guard a different way",
	// Questions about the code. The answer is to go and look.
	"why pi using qoder always end when task is not complete",
	"Can the workflow run parallely?",
	"why does the workflow keep asking permission. Is the behaviour same as Claude Code?",
	"what is the difference between the two spawn implementations",
	"check whether the compaction threshold is actually being read",
	"can you explain how the routing vocabulary is built",
	"look at the panel code and tell me why it renders twice",
	"I want to know why the workflow picked the wrong model",
	// An intent opener governing a lookup verb is still a question. This is the
	// case that stops the head-only rule from over-firing.
	"we need to understand how the seeding path actually works",
	"could you show me where the routing vocabulary is built",
	// Reports, not requests: the work verb is a noun here.
	"the build failed with a type error in the tool file",
	"my design for the store turned out to be wrong",
	// Not addressed to the model at all.
	"/ultracode on for the rest of this session",
	"!ls -la agent/extensions/ask-user",
]) {
	check(JSON.stringify(text.slice(0, 46)), opensWork(text), false);
}

console.log("\n--- the reminder itself ---");
// Both halves have to be there. "Ask now" alone reads as "ask", and that is the
// opposite bug: the tool description spends four lines warning against it.
check("says to ask now", OPENING_NUDGE.includes("ask_user now"), true);
check("and says when not to", OPENING_NUDGE.includes("do not ask"), true);
check("names the common case as not asking", OPENING_NUDGE.includes("the common case"), true);
check("wrapped as a system reminder", systemReminder("x"), "<system-reminder>\nx\n</system-reminder>");

console.log("\n--- CONTRACT_NUDGE: wording ---");
// No "if any exist" anywhere: the whole point is that this wording is not a
// judgment call. Both compliance paths must be named, and named as ONE call /
// ONE block rather than "ask when in doubt".
check("names ask_user as one option", CONTRACT_NUDGE.includes("Call ask_user ONCE"), true);
// The exact marker line hasAssumptionsBlock (below) actually scans for, and
// the exact fallback phrasing for the "genuinely none apply" case — both
// quoted in the nudge so the model is reproducing a literal string, not
// paraphrasing one.
check("names the exact marker line", CONTRACT_NUDGE.includes("'ASSUMPTIONS:'"), true);
check("and its none-apply fallback, verbatim", CONTRACT_NUDGE.includes("'ASSUMPTIONS: none — <one line why>'"), true);
check("says the gate re-applies mid-task", CONTRACT_NUDGE.includes("MID-TASK"), true);
for (const category of ["data source", "schema", "framework/library/dependency", "layout", "scope boundaries", "materially different readings"]) {
	check(`names the "${category}" category`, CONTRACT_NUDGE.includes(category), true);
}
check("wrapped the same way as OPENING_NUDGE", systemReminder(CONTRACT_NUDGE), `<system-reminder>\n${CONTRACT_NUDGE}\n</system-reminder>`);

console.log("\n--- hasAssumptionsBlock ---");
check(
	"a block on its own line is found",
	hasAssumptionsBlock("Some preamble.\nASSUMPTIONS:\n1. Using mock data — real API needs credentials I do not have."),
	true,
);
check(
	"found mid-text, not just as the first line",
	hasAssumptionsBlock("I'll get started.\n\nFirst, a quick note.\n\nASSUMPTIONS:\n1. sqlite over postgres — smaller footprint.\n2. ..."),
	true,
);
check("indentation before the marker is still a line start", hasAssumptionsBlock("notes\n  ASSUMPTIONS:\n  1. x"), true);
check("the none-apply fallback still counts", hasAssumptionsBlock("ASSUMPTIONS: none — the request has no open decisions."), true);
check(
	"the word mid-sentence is not the block",
	hasAssumptionsBlock("I want to surface my assumptions: this looks like it uses mock data."),
	false,
);
check("mid-sentence even at a line's end does not count", hasAssumptionsBlock("Quick note before I start — ASSUMPTIONS: none really."), false);
check("plain prose with no marker at all", hasAssumptionsBlock("Building the settings page now."), false);
check("empty text", hasAssumptionsBlock(""), false);

// Finding 3: markdown-wrapped and case-varied markers must still be found —
// the model was told to print an artifact, and rendering it as markdown
// (bold, a heading) is still printing it.
check("bold-wrapped with **", hasAssumptionsBlock("**ASSUMPTIONS:**\n1. Using mock data — no credentials configured."), true);
check("underscore-emphasis wrapped", hasAssumptionsBlock("__ASSUMPTIONS:__\n1. Using mock data."), true);
check("a markdown heading", hasAssumptionsBlock("## ASSUMPTIONS:\n1. sqlite over postgres."), true);
check("a deeper heading level", hasAssumptionsBlock("###### ASSUMPTIONS:\n1. x"), true);
check("lower/mixed case", hasAssumptionsBlock("Assumptions:\n1. Using mock data."), true);
check("heading AND emphasis stacked", hasAssumptionsBlock("## **ASSUMPTIONS:**\n1. Using mock data."), true);
check("a single-asterisk emphasis wrapper also exposes the marker", hasAssumptionsBlock("*ASSUMPTIONS:*\n1. x"), true);
// But markdown-ness alone must not be enough — the word still has to lead.
check("a heading about assumptions, not the marker itself", hasAssumptionsBlock("## Notes on my assumptions here"), false);

// Finding 5: a line that only APPEARS to start with the marker because it is
// quoted (a fenced code block) or cited (a blockquote) must not count — this
// repo's own test files fence example lines starting with "ASSUMPTIONS:",
// and a model quoting the gate back must not register as having satisfied it.
check(
	"a fenced code block containing the marker does not count",
	hasAssumptionsBlock("Here's the gate as written:\n```\nASSUMPTIONS:\n1. example line\n```\nBuilding now."),
	false,
);
check(
	"a tilde-fenced block containing the marker does not count either",
	hasAssumptionsBlock("~~~\nASSUMPTIONS:\n1. example\n~~~"),
	false,
);
check(
	"a genuine block AFTER a fence closes still counts",
	hasAssumptionsBlock("```\nASSUMPTIONS:\n1. quoted example, not real\n```\nASSUMPTIONS:\n1. Using the demo fixture — no credentials configured."),
	true,
);
check("a blockquoted marker does not count", hasAssumptionsBlock("> ASSUMPTIONS:\n> 1. quoted from the nudge, not printed by me"), false);
check(
	"a real block still counts once the blockquote ends",
	hasAssumptionsBlock("> quoting the gate above\nASSUMPTIONS:\n1. Using mock data."),
	true,
);

console.log("\n--- contractFollowUpReminder restates the exact marker format ---");
{
	const text = contractFollowUpReminder(5);
	// Finding 3: compaction can drop CONTRACT_NUDGE (the only other place this
	// format is spelled out) before this follow-up ever fires, so the follow-up
	// has to be self-sufficient.
	check("restates the exact marker line, quoted", text.includes("'ASSUMPTIONS:'"), true);
	check("and the one-numbered-line-per-assumption shape", text.includes("one numbered line per assumption"), true);
}

console.log("\n--- style.ts: askStyle ---");
check("no model selected yet is socratic", askStyle(undefined, [...CONFIG.contractModels]), "socratic");
check("a provider-level pattern matches every model under it", askStyle(OPENAI_MODEL, [...CONFIG.contractModels]), "contract");
check(
	"a different openai-family model matches the same provider pattern",
	askStyle({ provider: "openai-codex", id: "codex-mini" }, [...CONFIG.contractModels]),
	"contract",
);
check("a model under an unlisted provider is socratic", askStyle(ANTHROPIC_MODEL, [...CONFIG.contractModels]), "socratic");
check("an empty pattern list matches nothing", askStyle(OPENAI_MODEL, []), "socratic");
check(
	"a provider/modelId pattern matches only that model",
	askStyle({ provider: "anthropic", id: "claude-haiku-4-5" }, ["anthropic/claude-haiku-4-5"]),
	"contract",
);
check(
	"...and leaves a sibling model under the same provider alone",
	askStyle(ANTHROPIC_MODEL, ["anthropic/claude-haiku-4-5"]),
	"socratic",
);
check(
	"a provider/modelId glob matches the family it names",
	askStyle({ provider: "anthropic", id: "claude-haiku-4-5" }, ["anthropic/claude-haiku-*"]),
	"contract",
);
check(
	"...and still leaves an unrelated model under the same provider alone",
	askStyle(ANTHROPIC_MODEL, ["anthropic/claude-haiku-*"]),
	"socratic",
);
check("a literal '.' in a model id is not a wildcard", askStyle({ provider: "x", id: "gpt-5x6-sol" }, ["x/gpt-5.6-sol"]), "socratic");
check("...but the real dotted id it names does match", askStyle({ provider: "x", id: "gpt-5.6-sol" }, ["x/gpt-5.6-sol"]), "contract");

console.log("\n--- style.ts: CONFIG.contractModels' default covers OpenAI models via other providers (Finding 4) ---");
// azure-openai-responses is its OWN KnownProvider (pi-ai's types.d.ts),
// distinct from "openai" — a bare-provider entry, same shape as "openai".
check(
	"Azure's Responses API surface for OpenAI models matches by bare provider",
	askStyle({ provider: "azure-openai-responses", id: "gpt-5.6-sol" }, [...CONFIG.contractModels]),
	"contract",
);
// OpenRouter and Vercel AI Gateway both publish OpenAI models with an
// "openai/" namespace IN THE MODEL ID, under their own provider name.
check(
	"a GPT-family model routed through OpenRouter matches the namespaced glob",
	askStyle({ provider: "openrouter", id: "openai/gpt-5.6-sol" }, [...CONFIG.contractModels]),
	"contract",
);
check(
	"...but a non-GPT OpenAI model under the same OpenRouter namespace does not",
	askStyle({ provider: "openrouter", id: "openai/o3-mini" }, [...CONFIG.contractModels]),
	"socratic",
);
check(
	"...nor does an OpenRouter model under an unrelated namespace",
	askStyle({ provider: "openrouter", id: "anthropic/claude-opus-5" }, [...CONFIG.contractModels]),
	"socratic",
);
check(
	"a GPT-family model via Vercel AI Gateway matches the same namespaced shape",
	askStyle({ provider: "vercel-ai-gateway", id: "openai/gpt-5.6-sol" }, [...CONFIG.contractModels]),
	"contract",
);
// GitHub Copilot's ids are bare (no "openai/" namespace), unlike the two above.
check(
	"a GPT-family model via GitHub Copilot matches the bare-id glob",
	askStyle({ provider: "github-copilot", id: "gpt-5.6-sol" }, [...CONFIG.contractModels]),
	"contract",
);
check(
	"...but a non-GPT GitHub Copilot model does not",
	askStyle({ provider: "github-copilot", id: "claude-opus-5" }, [...CONFIG.contractModels]),
	"socratic",
);

console.log("\n--- settings.ts: contractModels ---");
{
	const dir = mkdtempSync(join(tmpdir(), "ask-user-settings-"));
	const project = join(dir, "project");
	mkdirSync(join(project, ".pi"), { recursive: true });
	const write = (path: string, body: unknown) => writeFileSync(path, JSON.stringify(body));
	const userPath = join(dir, "settings.json");
	const projectPath = join(project, ".pi", "settings.json");

	check("defaults with no files match CONFIG.contractModels", loadSettings(dir, project, true).settings, {
		contractModels: [...CONFIG.contractModels],
	});

	write(userPath, { askUser: { contractModels: ["anthropic"] } });
	check(
		"the user block REPLACES the default rather than adding to it",
		loadSettings(dir, project, true).settings.contractModels,
		["anthropic"],
	);

	write(projectPath, { askUser: { contractModels: ["openrouter/*"] } });
	check("a trusted project overrides the user's list", loadSettings(dir, project, true).settings.contractModels, ["openrouter/*"]);
	// An untrusted clone must not be able to opt your session into (or out of)
	// the contract wording for a model you did not choose.
	check("an untrusted project does not", loadSettings(dir, project, false).settings.contractModels, ["anthropic"]);
	check(
		"and names the dropped key",
		loadSettings(dir, project, false).warnings.some((w) => w.includes("askUser.contractModels") && w.includes("not trusted")),
		true,
	);
	rmSync(projectPath);

	// Each loadSettings() call starts fresh from CONFIG.contractModels'
	// default, so a rejected block falls back to that default — not to
	// whatever an earlier, unrelated write() left behind.
	write(userPath, { askUser: { contractModels: [] } });
	check("an empty list is rejected", loadSettings(dir, project, false).settings.contractModels, [...CONFIG.contractModels]);
	write(userPath, { askUser: { contractModels: ["ok", "  "] } });
	check("a blank entry rejects the whole list", loadSettings(dir, project, false).settings.contractModels, [...CONFIG.contractModels]);
	write(userPath, { askUser: { contractModels: "openai" } });
	check("a non-array is rejected", loadSettings(dir, project, false).settings.contractModels, [...CONFIG.contractModels]);
	check("and every rejection is reported", loadSettings(dir, project, false).warnings.length, 1);

	write(userPath, { askUser: { contractModels: [" openai ", "openai-codex"] } });
	check("surrounding whitespace is trimmed", loadSettings(dir, project, false).settings.contractModels, ["openai", "openai-codex"]);

	writeFileSync(userPath, "{ not json");
	check("unparseable settings fall back to defaults, not a crash", loadSettings(dir, project, false).settings.contractModels, [
		...CONFIG.contractModels,
	]);
	check("and it is reported", loadSettings(dir, project, false).warnings.length, 1);

	writeFileSync(userPath, JSON.stringify({ askUser: "not an object" }));
	check("a non-object askUser block is ignored, not fatal", loadSettings(dir, project, false).settings.contractModels, [
		...CONFIG.contractModels,
	]);
}

// -------------------------------------------------------------------- wiring

console.log("\n--- wiring ---");
type Handler = (event: unknown, ctx?: unknown) => unknown;

/**
 * `model` defaults to undefined (socratic — no model matches, exactly the
 * "no model selected yet" case) so every pre-existing call to `install()`
 * below, unchanged, keeps exercising the socratic path byte-for-byte. Tests
 * that care about the contract style pass one explicitly. `cwd`/`trusted`
 * feed session_start's settings.json read (settings.ts) the same way a real
 * ExtensionContext would; no file lives at AGENT until the very last section
 * of this file writes one, so every call up to there resolves
 * CONFIG.contractModels' default.
 */
function install(hasUI = true, idle = false, model?: FakeModel, cwd = AGENT, trusted = true) {
	const handlers = new Map<string, Handler>();
	let tools: string[] = [];
	const sent: { customType?: string; content?: string; display?: boolean; options?: unknown }[] = [];
	const ctx: Record<string, unknown> = {
		hasUI,
		ui: { setStatus: () => {}, notify: () => {} },
		// tool_call fires while a tool is about to execute, so idle defaults to
		// false — the realistic case — and is only flipped for the one test that
		// exercises the triggerTurn backstop.
		isIdle: () => idle,
		model,
		cwd,
		isProjectTrusted: () => trusted,
	};
	register({
		on: (event: string, handler: Handler) => handlers.set(event, handler),
		registerTool: () => {},
		registerCommand: () => {},
		getActiveTools: () => tools,
		setActiveTools: (next: string[]) => {
			tools = next;
		},
		sendMessage: (message: Record<string, unknown>, options?: unknown) => {
			sent.push({ ...message, options } as never);
		},
	} as never);
	handlers.get("session_start")?.({ type: "session_start" }, ctx);

	/** One human turn: type `text`, then start the agent. Returns the injected message, if any. */
	const turn = (text: string, source = "interactive", streamingBehavior?: string) => {
		handlers.get("input")?.({ type: "input", text, source, streamingBehavior });
		const result = handlers.get("before_agent_start")?.({ type: "before_agent_start", prompt: text }, ctx) as
			| { message?: { customType?: string; content?: string; display?: boolean } }
			| undefined;
		return result?.message;
	};
	/**
	 * One tool_call event, the same shape pi dispatches before a tool executes.
	 * `path` defaults to a fresh one per call, so a loop of N calls behaves like
	 * N distinct files touched unless a test passes the same path on purpose to
	 * exercise the "one file, many edits" case.
	 */
	let autoPath = 0;
	const call = (toolName: string, path?: string) => {
		const input = toolName === "write" || toolName === "edit" ? { path: path ?? `auto-${autoPath++}.ts` } : {};
		handlers.get("tool_call")?.({ type: "tool_call", toolCallId: "tc", toolName, input }, ctx);
	};
	/**
	 * One assistant message_end event carrying `text` as its sole text block —
	 * the shape the contract style's ASSUMPTIONS-block detection watches
	 * (index.ts's message_end handler, hasAssumptionsBlock in nudge.ts).
	 * `stopReason` defaults to "stop" (a normal completion) so every
	 * pre-existing call, unchanged, keeps exercising that path; tests that care
	 * about aborted/errored messages (Finding 6) pass one explicitly.
	 */
	const assistant = (text: string, stopReason = "stop") => {
		handlers.get("message_end")?.(
			{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason } },
			ctx,
		);
	};
	/**
	 * Same event, but `blocks` become SEPARATE text content blocks rather than
	 * one — the shape index.ts's message_end handler must scan independently
	 * rather than join (Finding 5): a marker that only appears once two blocks
	 * are concatenated must not count.
	 */
	const assistantBlocks = (blocks: string[], stopReason = "stop") => {
		handlers.get("message_end")?.(
			{
				type: "message_end",
				message: { role: "assistant", content: blocks.map((text) => ({ type: "text", text })), stopReason },
			},
			ctx,
		);
	};
	return { handlers, turn, call, assistant, assistantBlocks, tools: () => tools, sent, ctx };
}

{
	const { turn, tools } = install();
	check("the tool is offered", tools(), ["ask_user"]);
	const first = turn("build me a settings page with a dark mode toggle");
	check("a work-opening request is nudged", first?.content, systemReminder(OPENING_NUDGE));
	check("under its own type", first?.customType, NUDGE_ENTRY_TYPE);
	// Hidden: it is a reminder to the model, not a line of conversation.
	check("and not shown in the transcript", first?.display, false);

	check("a follow-up is not", turn("also add a reset button"), undefined);
	// The cooldown, not the follow-up guard: this one WOULD open work on its own.
	check("nor is a second task inside the cooldown", turn("build me an export dialog with csv and json"), undefined);
}

console.log("\n--- wiring: contract style picks CONTRACT_NUDGE ---");
{
	const { turn } = install(true, false, OPENAI_MODEL);
	const first = turn("build me a settings page with a dark mode toggle");
	check("a matched model gets the contract wording", first?.content, systemReminder(CONTRACT_NUDGE));
	check("under the same entry type as the socratic nudge", first?.customType, NUDGE_ENTRY_TYPE);
	check("hidden, same as the socratic nudge", first?.display, false);
}
{
	// Explicit contrast with the default: an unmatched model — here spelled
	// out rather than relying on the undefined default — is still socratic.
	const { turn } = install(true, false, ANTHROPIC_MODEL);
	check("an unmatched model still gets OPENING_NUDGE", turn("build me a settings page with a dark mode toggle")?.content, systemReminder(OPENING_NUDGE));
}
{
	// style.ts resolves fresh from ctx.model at every delivery point rather
	// than being cached at session_start — this is what lets a model_select
	// mid-session change the wording on the very next nudge. Simulated here by
	// mutating the same ctx object install() wired up, the way pi's own
	// ExtensionContext.model would change out from under a running session.
	const { turn, ctx } = install(true, false, ANTHROPIC_MODEL);
	check("starts socratic", turn("build me a settings page with a dark mode toggle")?.content, systemReminder(OPENING_NUDGE));
	(ctx as { model?: FakeModel }).model = OPENAI_MODEL;
	// Past the cooldown so the next work-opening request is eligible again.
	for (let i = 0; i < CONFIG.nudgeCooldownTurns - 1; i++) turn(`create page number ${i} for the export flow`);
	check(
		"a model switched mid-session gets the new wording on the next nudge, not a cached one",
		turn("create one more page for the archive flow")?.content,
		systemReminder(CONTRACT_NUDGE),
	);
}

console.log("\n--- wiring: enforcement keys off the DELIVERED style, not a re-read of ctx.model (Finding 2) ---");
{
	// A contract nudge goes out (OPENAI_MODEL), then the model switches to one
	// style.ts would resolve as socratic — but nothing has re-delivered a
	// nudge, so the model is still answerable to CONTRACT_NUDGE. The follow-up
	// schedule and wording must stay contract-shaped.
	const { turn, call, ctx, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	(ctx as { model?: FakeModel }).model = ANTHROPIC_MODEL;
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("one short of the contract threshold stays quiet even under the new model", sent.length, 0);
	call("write");
	check("fires at the contract threshold, not the socratic one", sent.length, 1);
	check("with contract wording, keyed off delivery not the current model", sent[0]?.content, contractFollowUpReminder(CONFIG.followUp.afterMutations));
}
{
	// Same switch, but checking ASSUMPTIONS-block compliance rather than the
	// follow-up: a model switched away from contract mid-session must still be
	// able to satisfy (or be held to) the gate it was actually sent.
	const { turn, call, assistant, ctx, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	(ctx as { model?: FakeModel }).model = ANTHROPIC_MODEL;
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("fires once", sent.length, 1);
	assistant("ASSUMPTIONS:\n1. Using the demo fixture, not the real API — no credentials configured.");
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check(
		"the ASSUMPTIONS block still registers as compliance under the model now selected",
		sent.length,
		1,
	);
}
{
	// The converse: a nudge delivered socratic, then a switch to a
	// contract-matched model. The socratic latch — not the contract
	// schedule — still governs, because that is the gate this session's
	// model was actually handed.
	const { turn, call, ctx, sent } = install(true, false, ANTHROPIC_MODEL);
	turn("build me a settings page with a dark mode toggle");
	(ctx as { model?: FakeModel }).model = OPENAI_MODEL;
	for (let i = 0; i < CONFIG.followUp.afterMutations * 4; i++) call("write");
	check("the one-shot socratic latch still governs, however far past threshold mutations go", sent.length, 1);
	check("with socratic wording", sent[0]?.content, followUpReminder(CONFIG.followUp.afterMutations));
}
{
	// style.ts's own header property, preserved: a model switch BEFORE any
	// nudge has gone out still resolves fresh — deliveredStyle is only set at
	// the moment a nudge actually fires.
	const { turn, ctx } = install(true, false, ANTHROPIC_MODEL);
	(ctx as { model?: FakeModel }).model = OPENAI_MODEL;
	check(
		"a switch before the first nudge is not desynced from anything — it just resolves fresh",
		turn("build me a settings page with a dark mode toggle")?.content,
		systemReminder(CONTRACT_NUDGE),
	);
}

console.log("\n--- the cooldown expires ---");
{
	const { turn } = install();
	check("first task nudged", turn("build me a settings page with a dark mode toggle") !== undefined, true);
	// One turn short of the cooldown, so the reminder is still suppressed...
	for (let i = 0; i < CONFIG.nudgeCooldownTurns - 1; i++) {
		check(`suppressed ${i + 1} turn(s) later`, turn(`create page number ${i} for the export flow`), undefined);
	}
	// ...and the next one clears it.
	check("and then allowed again", turn("create one more page for the archive flow") !== undefined, true);
}

console.log("\n--- what never nudges ---");
{
	// Telling a headless agent to ask would spend the turn waiting on nobody, and
	// the tool it would reach for is not offered there either.
	const { turn, tools } = install(false);
	check("no interactive user", turn("build me a settings page with a dark mode toggle"), undefined);
	check("and the tool is not offered", tools(), []);
}
{
	const { turn } = install();
	check("a non-human prompt", turn("build me a settings page with a dark mode toggle", "extension"), undefined);
}
{
	const { turn } = install();
	// Steered text arrives mid-turn and never reaches before_agent_start; if it
	// set the flag it would fire on whatever turn came next instead.
	check("text steered into a running turn", turn("build me a settings page with a dark mode toggle", "interactive", "steer"), undefined);
	check("and it did not arm the next turn either", turn("also tidy up the imports"), undefined);
}

console.log("\n--- the compliance follow-up: message wording ---");
{
	const text = followUpReminder(5);
	check("names the count that tripped it", text.includes("created or edited 5 files"), true);
	check("says to ask now", text.includes("call ask_user NOW"), true);
	check("and gives the fallback", text.includes("state your assumptions in one line and continue"), true);
	check("wrapped as a system reminder, same as the opening nudge", text.startsWith("<system-reminder>\n"), true);
}

console.log("\n--- the compliance follow-up: contract wording ---");
{
	const text = contractFollowUpReminder(5);
	check("names the count that tripped it", text.includes("modified 5 files"), true);
	check("names both compliance paths", text.includes("neither asked a question nor printed an ASSUMPTIONS block"), true);
	check("says to print it now", text.includes("Print it NOW"), true);
	check("and gives the ask_user escape hatch, not a prose fallback", text.includes("use ask_user instead"), true);
	check("does NOT offer followUpReminder's silent fallback", text.includes("state your assumptions in one line and continue"), false);
	check("wrapped as a system reminder, same as the opening nudge", text.startsWith("<system-reminder>\n"), true);
}

console.log("\n--- the compliance follow-up: counter and latch ---");
{
	// Mutations before any nudge has gone out are not a backstop for anything —
	// there is nothing yet that the nudge could have been ignored.
	const { call, sent } = install();
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("mutations before any nudge do not arm the follow-up", sent.length, 0);
}
{
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("one mutation short of the threshold stays quiet", sent.length, 0);
	call("edit"); // the Nth mutation — write and edit both count as a mutation
	check("edit counts the same as write", sent.length, 1);
	check("under its own type", sent[0]?.customType, FOLLOWUP_ENTRY_TYPE);
	check("with the count that tripped it", sent[0]?.content, followUpReminder(CONFIG.followUp.afterMutations));
	check("hidden, same as the opening nudge", sent[0]?.display, false);
	check("delivered as a follow-up while the agent is mid-run", sent[0]?.options, { deliverAs: "followUp" });
}
{
	// A lookup tool is neither a mutation nor an ask_user call, so it moves
	// neither counter — a session that only reads never trips this.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations * 2; i++) call("read");
	check("reads and other lookups never trip it", sent.length, 0);
}
{
	// One-shot latch: it fires once per arming, not on every mutation past the
	// threshold — the whole point of "latch" rather than a plain counter.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations * 4; i++) call("write");
	check("it fires exactly once, however far past the threshold mutations go", sent.length, 1);
}
{
	// An actual ask_user call re-arms the latch: the count starts over, and a
	// fresh run of mutations can trip the reminder again.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("fires the first time", sent.length, 1);
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("re-armed, but not yet back at the threshold", sent.length, 1);
	call("write");
	check("and it fires again once the new count reaches it", sent.length, 2);
}
{
	// The reset is not only a post-delivery thing: an ask_user call clears
	// mutations counted before the latch ever tripped, too.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	call("write");
	call("write");
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("the mutations before ask_user do not carry over", sent.length, 0);
	call("write");
	check("only the mutations since the ask_user call count toward it", sent.length, 1);
}
{
	// No UI, no one to hand the reminder to. In practice this never arises —
	// the opening nudge is gated on isAvailable(ctx), so nudgeHasFired can only
	// become true when hasUI already was — but the tool_call handler carries
	// its own guard rather than depending on that invariant holding forever.
	const { turn, call, sent } = install(false);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("headless: nothing to send", sent.length, 0);
}
{
	// Once the agent has actually gone idle, sendMessage is told to trigger a
	// fresh turn rather than queue a follow-up — the same idiom stalled-turn
	// uses to re-enter the loop (pi's sendMessage tests deliverAs before
	// triggerTurn, so this is the branch that actually fires when nothing is
	// left mid-run to deliver into).
	const { turn, call, sent } = install(true, true);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("triggerTurn when idle", sent[0]?.options, { triggerTurn: true });
}

console.log("\n--- the compliance follow-up: contract re-arm schedule + cap ---");
{
	// The first firing is at the same threshold as socratic; the schedule only
	// diverges once it does not stop there.
	const { turn, call, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("one mutation short of the first threshold stays quiet", sent.length, 0);
	call("write");
	check("fires at afterMutations, same as socratic", sent.length, 1);
	check("with contract wording", sent[0]?.content, contractFollowUpReminder(CONFIG.followUp.afterMutations));

	// Unlike socratic, further mutations past the first threshold DO fire
	// again — at afterMutations + rearmMutations, not immediately.
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("one short of the second threshold stays quiet", sent.length, 1);
	call("write");
	check("fires a second time at the rearm threshold", sent.length, 2);
	check(
		"naming the mutation count that actually tripped it",
		sent[1]?.content,
		contractFollowUpReminder(CONFIG.followUp.afterMutations + CONFIG.followUp.rearmMutations),
	);

	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("one short of the third threshold stays quiet", sent.length, 2);
	call("write");
	check("fires a third time", sent.length, 3);

	// The cap: maxFollowUps have now fired, and no further mutation count,
	// however large, buys a fourth — this is what keeps a persistently silent
	// model from turning into spam.
	for (let i = 0; i < CONFIG.followUp.rearmMutations * 5; i++) call("write");
	check(`never exceeds the cap of ${CONFIG.followUp.maxFollowUps}`, sent.length, CONFIG.followUp.maxFollowUps);
}

console.log("\n--- the compliance follow-up: contract satisfaction ---");
{
	// An ask_user call is compliance for contract style too — and this test
	// rides the schedule all the way to the cap before satisfying it, to
	// prove satisfaction resets the whole SCHEDULE, not just the mutation
	// count (existing re-arm-on-ask semantics preserved, per style.ts). This
	// is also this test's FIRST-EVER compliance, so per Finding 1's fix the
	// next arm's first threshold is rearmMutations, not afterMutations — see
	// the "post-compliance threshold" section below for that property in
	// isolation.
	const { turn, call, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	check("the cap is reached", sent.length, CONFIG.followUp.maxFollowUps);
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("re-armed, but not yet back at the (now-elevated) first threshold", sent.length, CONFIG.followUp.maxFollowUps);
	call("write");
	check("an ask_user call re-arms the full schedule, not just the mutation count", sent.length, CONFIG.followUp.maxFollowUps + 1);
	check(
		"at rearmMutations now that compliance has happened once — never afterMutations again",
		sent[CONFIG.followUp.maxFollowUps]?.content,
		contractFollowUpReminder(CONFIG.followUp.rearmMutations),
	);
}
{
	// The other compliance path: a printed ASSUMPTIONS block, with no
	// ask_user call at all. The FIRST firing here is still at afterMutations —
	// no compliance has happened yet at that point — but the ASSUMPTIONS block
	// itself is this test's first-ever compliance, so the arm after it is held
	// to rearmMutations, same as an ask_user call would be.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("fires once, at afterMutations before any compliance has happened", sent.length, 1);
	assistant("Continuing.\n\nASSUMPTIONS:\n1. Using the demo fixture, not the real API — no credentials configured.");
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("an ASSUMPTIONS block re-arms it just like ask_user would", sent.length, 1);
	call("write");
	check("and a fresh run of mutations trips it again, at the now-elevated rearm threshold", sent.length, 2);
	check(
		"naming rearmMutations, not afterMutations",
		sent[1]?.content,
		contractFollowUpReminder(CONFIG.followUp.rearmMutations),
	);
}
{
	// Preemptive compliance: an ASSUMPTIONS block printed before the
	// follow-up has ever fired still resets the mutation count — the same
	// "not only a post-delivery thing" behaviour an ask_user call already has.
	// This is this test's first-ever compliance too, so the threshold it
	// re-arms to is already the elevated one.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	call("write");
	call("write");
	assistant("ASSUMPTIONS: none — the request has no open decisions.");
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("the mutations before the block do not carry over", sent.length, 0);
	call("write");
	check("only the mutations since the block count toward it, at the now-elevated rearm threshold", sent.length, 1);
}

console.log("\n--- the compliance follow-up: post-compliance threshold never reverts to afterMutations (Finding 1) ---");
{
	// The exact reproduced false accusation: a reply that prints ASSUMPTIONS
	// and, in that SAME reply, goes on to make several tool calls.
	// pi-agent-core fires message_end for an assistant message before that
	// same message's own tool calls execute, so compliance registers (and the
	// schedule resets) before those calls are counted. Before this fix, the
	// reset threshold was afterMutations (5) — lower than 6 — so this exact
	// shape tripped a false accusation within the very turn that complied.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	assistant("ASSUMPTIONS:\n1. Using the demo fixture, not the real API — no credentials configured.");
	for (let i = 0; i < 6; i++) call("write");
	check("printing the block then mutating 6 files in the same turn does not fire", sent.length, 0);
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	check("but enough further mutations still eventually fire", sent.length, 1);
	check("at the rearm threshold, not afterMutations", sent[0]?.content, contractFollowUpReminder(CONFIG.followUp.rearmMutations));
}
{
	// The property holds across a SECOND arm too, not just the one right after
	// the first-ever compliance: afterMutations is a one-time grace period for
	// the whole session, not something a compliant model keeps earning back
	// each time it complies.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	assistant("ASSUMPTIONS: none — the request has no open decisions.");
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	check("first arm after the first compliance fires at rearmMutations", sent.length, 1);
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("a SECOND compliance still does not drop the next arm back to afterMutations", sent.length, 1);
	for (let i = 0; i < CONFIG.followUp.rearmMutations - CONFIG.followUp.afterMutations; i++) call("write");
	check("it only fires once the still-elevated rearm threshold is reached", sent.length, 2);
}
{
	// Socratic sessions are unaffected by an ASSUMPTIONS-shaped message: the
	// wording that mentions this marker was never offered to them, so a
	// coincidental match must not silently satisfy a gate they were never
	// given.
	const { turn, call, assistant, sent } = install(true, false, ANTHROPIC_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	assistant("ASSUMPTIONS:\n1. This should not matter for a socratic session.");
	call("write");
	check("the socratic follow-up still fires at its own threshold, untouched", sent.length, 1);
	check("with the socratic wording", sent[0]?.content, followUpReminder(CONFIG.followUp.afterMutations));
}

console.log("\n--- the compliance follow-up: content blocks scanned for the marker independently (Finding 5) ---");
{
	// A marker that appears ONLY inside a fenced quote must not register, even
	// when that quote is delivered as its own separate content block following
	// unrelated prose — the fence guard (hasAssumptionsBlock) has to apply
	// within each block index.ts hands it, not just within a single big string.
	const { turn, call, assistantBlocks, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	assistantBlocks(["Here's the gate as I understand it:", "```\nASSUMPTIONS:\n1. quoted from the nudge, not printed by me\n```"]);
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("a fenced quote in its own content block does not register as compliance", sent.length, 0);
	call("write");
	check("so the follow-up still fires at the ordinary threshold", sent.length, 1);
}
{
	// A genuine block, delivered as its own separate content block following
	// unrelated prose in an earlier block, is still detected — index.ts must
	// look at every text block for the marker, not only the first or the last.
	const { turn, call, assistantBlocks, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	assistantBlocks(["Sure, let's go.", "ASSUMPTIONS:\n1. Using the demo fixture — no credentials configured."]);
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("a genuine block delivered separately from other prose still registers as compliance", sent.length, 0);
	call("write");
	check("...confirmed by the now-elevated rearm threshold applying", sent.length, 1);
}

console.log("\n--- the compliance follow-up: aborted/errored messages do not register compliance (Finding 6) ---");
{
	// pi-agent-core finalizes message_end with the PARTIAL message on user
	// abort (Escape) and on a stream error — stopReason "aborted" or "error"
	// either way. Escape-during-"ASSUMPTIONS: none" must not silently satisfy
	// the gate for the rest of the run.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("fires once", sent.length, 1);
	assistant("ASSUMPTIONS:\n1. Using the demo fixture — no credentials configured.", "aborted");
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("an aborted message's ASSUMPTIONS block does not register as compliance", sent.length, 1);
	call("write");
	// Since it never registered, contractHasCompliedOnce is still false, so the
	// SECOND firing is still at the UNCOMPLIED schedule (afterMutations +
	// rearmMutations), not the elevated one compliance would have produced —
	// confirming the abort did not just fail to register, but genuinely left
	// the schedule untouched.
	check("so the follow-up fires again at the ordinary (uncomplied) rearm threshold", sent.length, 2);
	check(
		"naming the uncomplied schedule's threshold",
		sent[1]?.content,
		contractFollowUpReminder(CONFIG.followUp.afterMutations + CONFIG.followUp.rearmMutations),
	);
}
{
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	assistant("ASSUMPTIONS:\n1. Using the demo fixture — no credentials configured.", "error");
	for (let i = 0; i < CONFIG.followUp.afterMutations - 1; i++) call("write");
	check("an errored message's ASSUMPTIONS block does not register as compliance either", sent.length, 1);
}
{
	// A normal completion (the implicit default in every other test in this
	// file) still registers — this pins that the guard is specific to
	// aborted/error, not a regression that silences compliance altogether.
	const { turn, call, assistant, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	assistant("ASSUMPTIONS:\n1. Using the demo fixture — no credentials configured.", "stop");
	for (let i = 0; i < CONFIG.followUp.rearmMutations - 1; i++) call("write");
	check("a normally-completed message's block still registers as compliance", sent.length, 1);
}

console.log("\n--- the compliance follow-up: distinct files, not calls ---");
{
	// Five edits to the same file is one file still unchecked against the
	// opening questions, not five — the count that trips this and the count
	// the message names must both be distinct files, not tool calls.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	for (let i = 0; i < CONFIG.followUp.afterMutations * 3; i++) call("edit", "src/app.ts");
	check("many edits to one file never trip it", sent.length, 0);
}
{
	// Mixing repeat edits to one file with fresh ones: only the distinct paths
	// count toward the threshold.
	const { turn, call, sent } = install();
	turn("build me a settings page with a dark mode toggle");
	call("write", "a.ts");
	call("edit", "a.ts"); // same file again — still just one distinct file
	call("write", "b.ts");
	call("write", "c.ts");
	call("write", "d.ts");
	check("four distinct files is one short", sent.length, 0);
	call("write", "e.ts");
	check("the fifth distinct file trips it", sent.length, 1);
	check("names the distinct file count, not the call count", sent[0]?.content, followUpReminder(CONFIG.followUp.afterMutations));
}

console.log("\n--- there is no off switch ---");
{
	// The point of the whole change: no settings block can suppress any of this.
	// A stray `askUser` block on disk must be inert, not honoured.
	writeFileSync(
		join(AGENT, "settings.json"),
		JSON.stringify({ askUser: { enabled: false, openingNudge: false, nudgeCooldownTurns: 9999 } }),
	);
	const { turn, tools } = install();
	check("a disabling settings block is ignored", tools(), ["ask_user"]);
	check("and the nudge still fires", turn("build me a settings page with a dark mode toggle") !== undefined, true);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
