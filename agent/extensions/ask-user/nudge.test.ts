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
 * CONTRACT_NUDGE / contractFollowUpReminder's wording, the wiring that picks
 * between the two styles and re-arms the contract follow-up on a schedule,
 * and that no text the model reads tells it what to write about its
 * assumptions.
 *
 * Run: jiti agent/extensions/ask-user/nudge.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "ask-nudge-test-"));
process.on("exit", () => rmSync(ROOT, { recursive: true, force: true }));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { CONTRACT_NUDGE, contractFollowUpReminder, followUpReminder, OPENING_NUDGE, opensWork, systemReminder } =
	await import("./nudge.ts");
const { CONFIG, FOLLOWUP_ENTRY_TYPE, NUDGE_ENTRY_TYPE, TOOL_NAME } = await import("./config.ts");
const { ASK_USER_DESCRIPTION, ASK_USER_GUIDELINES, ASK_USER_SNIPPET } = await import("./guidance.ts");
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

console.log("\n--- no text tells the model what to write about its assumptions ---");
// Extensions leave the model's output alone, tone aside: no ASSUMPTIONS block,
// no line saying what it assumed, and no rule against one either. Every nudge,
// reminder and guidance text is here.
for (const [label, text] of [
	["OPENING_NUDGE", OPENING_NUDGE],
	["CONTRACT_NUDGE", CONTRACT_NUDGE],
	["followUpReminder", followUpReminder(5)],
	["contractFollowUpReminder", contractFollowUpReminder(5)],
	["the tool description", ASK_USER_DESCRIPTION],
	["the snippet", ASK_USER_SNIPPET],
	["the guidelines", ASK_USER_GUIDELINES.join("\n")],
] as const) {
	check(`${label}: no ASSUMPTIONS block`, /ASSUMPTIONS/.test(text), false);
	check(`${label}: no "say what you assumed"`, /what you are assuming|what you assumed|state your assumptions|state the assumption/i.test(text), false);
	check(`${label}: no rule about "your assumptions"`, /your assumptions/i.test(text), false);
}

console.log("\n--- CONTRACT_NUDGE: wording ---");
// ONE call, not "ask when in doubt" — and only for a decision nothing settles,
// or "file and module layout" alone would make every build request a question.
check("names ask_user, once", CONTRACT_NUDGE.includes("Call ask_user ONCE"), true);
check("a decision qualifies only when nothing settles it", CONTRACT_NUDGE.includes("cannot settle from the request, the codebase, or an obvious default"), true);
check("says the gate re-applies mid-task", CONTRACT_NUDGE.includes("MID-TASK"), true);
for (const category of ["data source", "schema", "framework/library/dependency", "layout", "scope boundaries", "materially different readings"]) {
	check(`names the "${category}" category`, CONTRACT_NUDGE.includes(category), true);
}
check("wrapped the same way as OPENING_NUDGE", systemReminder(CONTRACT_NUDGE), `<system-reminder>\n${CONTRACT_NUDGE}\n</system-reminder>`);

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
	rmSync(dir, { recursive: true, force: true });
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
		events: { on: () => () => {}, emit: () => {} },
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
	return { handlers, turn, call, tools: () => tools, sent, ctx };
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
	check("and says to continue otherwise", text.includes("otherwise continue"), true);
	check("wrapped as a system reminder, same as the opening nudge", text.startsWith("<system-reminder>\n"), true);
}

console.log("\n--- the compliance follow-up: contract wording ---");
{
	const text = contractFollowUpReminder(5);
	check("names the count that tripped it", text.includes("modified 5 files"), true);
	check("says to ask now", text.includes("use ask_user NOW"), true);
	// Compaction can drop CONTRACT_NUDGE before this fires, so it names the kinds again.
	check("names the decision kinds again", text.includes("data source"), true);
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
console.log("\n--- the compliance follow-up: post-compliance threshold never reverts to afterMutations (Finding 1) ---");
{
	// A model that asks, then builds 6 files on the answers: the reset
	// threshold must not drop back to afterMutations (5), or asking would buy
	// a reminder sooner than never asking does.
	const { turn, call, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	call(TOOL_NAME);
	for (let i = 0; i < 6; i++) call("write");
	check("asking then mutating 6 files does not fire", sent.length, 0);
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	check("but enough further mutations still eventually fire", sent.length, 1);
	check("at the rearm threshold, not afterMutations", sent[0]?.content, contractFollowUpReminder(CONFIG.followUp.rearmMutations));
}
{
	// The property holds across a SECOND arm too, not just the one right after
	// the first-ever compliance: afterMutations is a one-time grace period for
	// the whole session, not something a compliant model keeps earning back
	// each time it complies.
	const { turn, call, sent } = install(true, false, OPENAI_MODEL);
	turn("build me a settings page with a dark mode toggle");
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.rearmMutations; i++) call("write");
	check("first arm after the first compliance fires at rearmMutations", sent.length, 1);
	call(TOOL_NAME);
	for (let i = 0; i < CONFIG.followUp.afterMutations; i++) call("write");
	check("a SECOND compliance still does not drop the next arm back to afterMutations", sent.length, 1);
	for (let i = 0; i < CONFIG.followUp.rearmMutations - CONFIG.followUp.afterMutations; i++) call("write");
	check("it only fires once the still-elevated rearm threshold is reached", sent.length, 2);
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
