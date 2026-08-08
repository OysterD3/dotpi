/**
 * Unit coverage for the /recap pure logic: model reference resolution, the
 * transcript builder and its turn counting, the auto-on-return gate, the
 * settings loader, and render helpers.
 *
 * Run it after editing this extension:
 *     pnpm dlx jiti agent/extensions/recap/recap.test.ts
 *
 * pi only auto-loads `index.ts` from an extension folder, so this file sits here
 * harmlessly next to the thing it tests. The network path (the real recap call)
 * lives in recap.live.ts, which is not part of the offline suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG } from "./config.ts";
import { hasPriorRecap, shouldAutoRecap, totalUserTurns, userTurnsSinceLastRecap } from "./gate.ts";
import { resolveModel, selectModel, splitThinking } from "./model.ts";
import { formatIdle } from "./render.ts";
import { loadSettings } from "./settings.ts";
import { buildSections, buildTranscript, countUserTurns } from "./transcript.ts";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------- model.ts

console.log("--- model resolution ---");
const M = (provider: string, id: string, name = id) => ({ provider, id, name, contextWindow: 200_000 });
const MODELS = [
	M("anthropic", "claude-haiku-4-5"),
	M("anthropic", "claude-haiku-4-5-20251001"),
	M("anthropic", "claude-sonnet-5", "Sonnet 5"),
	M("openai-codex", "gpt-5.6-sol"),
	M("openrouter", "claude-haiku-4-5"), // same id, different provider — bare id is ambiguous
	M("openrouter", "deepseek-chat:free"), // a colon that is part of the id, not a level
	M("openrouter", "model:max"), // an id that genuinely ends in a level name
];

const pick = (ref: string) => {
	const r = resolveModel(ref, MODELS);
	return r.ok ? `${r.model.provider}/${r.model.id}` : `ERR`;
};

check("canonical provider/id", pick("openai-codex/gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
check("canonical is case-insensitive", pick("OpenAI-Codex/GPT-5.6-Sol"), "openai-codex/gpt-5.6-sol");
check("provider/id with unique id", pick("anthropic/claude-sonnet-5"), "anthropic/claude-sonnet-5");
check("bare unique id", pick("gpt-5.6-sol"), "openai-codex/gpt-5.6-sol");
check("bare unique id, dated", pick("claude-haiku-4-5-20251001"), "anthropic/claude-haiku-4-5-20251001");
check("bare ambiguous id is an error", resolveModel("claude-haiku-4-5", MODELS).ok, false);
check("qualifying the ambiguous id resolves it", pick("openrouter/claude-haiku-4-5"), "openrouter/claude-haiku-4-5");
check("partial by name", pick("Sonnet"), "anthropic/claude-sonnet-5");
check("partial preferring alias over dated", pick("gpt-5.6"), "openai-codex/gpt-5.6-sol");
check("no match is an error", resolveModel("does-not-exist", MODELS).ok, false);
// The error names the reference so a typo in settings is diagnosable.
const err = resolveModel("nope", MODELS);
check("error mentions the reference", err.ok === false && err.error.includes("nope"), true);

// A role value may end in `:level` (pi's --model syntax). The full reference is
// matched first, so a colon that belongs to the id can never be split away.
check("suffixed reference resolves like the bare one", pick("anthropic/claude-sonnet-5:high"), pick("anthropic/claude-sonnet-5"));
check("suffixed bare id resolves", pick("gpt-5.6-sol:low"), "openai-codex/gpt-5.6-sol");
check("unknown suffix is matched as part of the id", pick("openrouter/deepseek-chat:free"), "openrouter/deepseek-chat:free");
check("an id ending in a level name matches whole, unsplit", pick("openrouter/model:max"), "openrouter/model:max");
const suffixedErr = resolveModel("nope:high", MODELS);
check("suffixed no-match is an error", suffixedErr.ok, false);
check("naming the reference as configured", suffixedErr.ok === false && suffixedErr.error.includes("nope:high"), true);

console.log("\n--- splitThinking ---");
check("a level splits", splitThinking("anthropic/claude-opus-5:high"), { reference: "anthropic/claude-opus-5", thinking: "high" });
check("a non-level suffix stays put", splitThinking("deepseek/deepseek-chat:free"), { reference: "deepseek/deepseek-chat:free" });
check("no colon passes through", splitThinking("anthropic/claude-sonnet-5"), { reference: "anthropic/claude-sonnet-5" });

console.log("\n--- selectModel: cheap role by default, session model when roles are absent ---");
{
	const dirWith = (settings: unknown) => {
		const dir = mkdtempSync(join(tmpdir(), "recap-select-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		return dir;
	};
	const roleMap = dirWith({ models: { active: "a", providers: { a: { cheap: "openai-codex/gpt-5.6-sol" } } } });
	const suffixedMap = dirWith({ models: { active: "a", providers: { a: { cheap: "anthropic/claude-sonnet-5:low" } } } });
	const deadMap = dirWith({ models: { active: "a", providers: { a: { cheap: "gone/away" } } } });
	const noCheap = dirWith({ models: { active: "a", providers: { a: { fast: "openai-codex/gpt-5.6-sol" } } } });
	const bare = dirWith({});
	const session = M("qoder", "ultimate");
	const picked = (r: { ok: true; model: { provider: string; id: string } } | { ok: false }) => (r.ok ? `${r.model.provider}/${r.model.id}` : "ERR");

	// Explicit config is a promise: it resolves or the recap fails, session
	// model or not — a silent stand-in would run the transcript elsewhere.
	check("an explicit model wins", picked(selectModel("gpt-5.6-sol", session, MODELS, roleMap)), "openai-codex/gpt-5.6-sol");
	check("an explicit miss fails, never falls back", picked(selectModel("nope", session, MODELS, roleMap)), "ERR");

	// Unconfigured: the cheap role when a map defines it...
	check("the cheap role is the default", picked(selectModel(undefined, session, MODELS, roleMap)), "openai-codex/gpt-5.6-sol");
	check("a role value's :level strips on the way", picked(selectModel(undefined, session, MODELS, suffixedMap)), "anthropic/claude-sonnet-5");

	// ...and the session model everywhere else. The default configured nothing,
	// so it must break nothing: no map, no cheap role, or a cheap role naming a
	// dead model all degrade to what the session already runs.
	check("no role map -> session model", picked(selectModel(undefined, session, MODELS, bare)), "qoder/ultimate");
	check("no cheap role -> session model", picked(selectModel(undefined, session, MODELS, noCheap)), "qoder/ultimate");
	check("a dead cheap role -> session model", picked(selectModel(undefined, session, MODELS, deadMap)), "qoder/ultimate");
	check("nothing anywhere is the only failure", selectModel(undefined, undefined, MODELS, bare).ok, false);
}

console.log("\n--- transcript ---");
const conversation = [
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "add a cache" }] } },
	{
		type: "message",
		message: {
			role: "assistant",
			content: [
				{ type: "text", text: "Writing it." },
				{ type: "toolCall", name: "edit", arguments: { path: "cache.ts" } },
			],
		},
	},
	{ type: "message", message: { role: "system", content: [{ type: "text", text: "SYSTEM" }] } },
	{ type: "custom", customType: "recap", data: { text: "x" } },
	{ type: "message", message: { role: "user", content: [{ type: "text", text: "now add tests" }] } },
];
const sections = buildSections(conversation as never);
check("only user + assistant", sections.length, 3);
check("tool calls included", sections[1].includes("Tool edit was called"), true);
check("system excluded", sections.join("|").includes("SYSTEM"), false);
check("counts user turns", countUserTurns(conversation as never), 2);

// Budget: a small window drops the oldest first and announces it.
const many = Array.from({ length: 50 }, (_, i) => ({
	type: "message",
	message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text: `msg ${i} ${"x".repeat(200)}` }] },
}));
const tight = buildTranscript(many as never, 2_000); // 2000 * 0.5 * 4 = 4000 chars
check("tight budget drops oldest", tight.dropped > 0, true);
check("keeps the newest", tight.text.includes("msg 49"), true);
check("drops the oldest", tight.text.includes("msg 0 "), false);
check("announces the drop", tight.text.includes("dropped to fit"), true);
const roomy = buildTranscript(conversation as never, 200_000);
check("roomy budget drops nothing", roomy.dropped, 0);
check("empty branch is empty text", buildTranscript([], 200_000).text, "");

console.log("\n--- gate: turn counting ---");
const recapEntry = { type: "custom", customType: "recap" };
const user = { type: "message", message: { role: "user" } };
const asst = { type: "message", message: { role: "assistant" } };
check("total user turns", totalUserTurns([user, asst, user, user] as never), 3);
check("no prior recap", hasPriorRecap([user, asst] as never), false);
check("prior recap detected", hasPriorRecap([user, recapEntry, user] as never), true);
check("turns since last recap", userTurnsSinceLastRecap([user, recapEntry, user, asst, user] as never), 2);
check("turns since recap when none, counts all", userTurnsSinceLastRecap([user, asst, user] as never), 2);
check("turns since counts only after the LAST recap", userTurnsSinceLastRecap([user, recapEntry, user, recapEntry, user] as never), 1);

console.log("\n--- gate: decision ---");
const branch3 = [user, asst, user, asst, user, asst]; // 3 user turns
const baseGate = {
	entries: branch3 as never,
	idleMs: 400_000,
	autoOnReturn: true,
	idleThresholdMs: CONFIG.idleThresholdMs,
	minUserTurns: CONFIG.minUserTurns,
	hasPending: false,
};
check("recaps when everything lines up", shouldAutoRecap(baseGate).recap, true);
check("disabled -> no", shouldAutoRecap({ ...baseGate, autoOnReturn: false }).recap, false);
check("never ran -> no", shouldAutoRecap({ ...baseGate, idleMs: undefined }).recap, false);
check("not away long enough -> no", shouldAutoRecap({ ...baseGate, idleMs: 10_000 }).recap, false);
check("background work pending -> no", shouldAutoRecap({ ...baseGate, hasPending: true }).recap, false);
check("too few turns -> no", shouldAutoRecap({ ...baseGate, entries: [user, asst] as never }).recap, false);
// Recapped one turn ago (< minTurnsSinceLastRecap) -> no; two turns ago -> yes.
check(
	"recapped too recently -> no",
	shouldAutoRecap({ ...baseGate, entries: [user, asst, user, recapEntry, user] as never }).recap,
	false,
);
check(
	"recapped a while ago -> yes",
	shouldAutoRecap({ ...baseGate, entries: [user, asst, user, recapEntry, user, asst, user] as never }).recap,
	true,
);
// The reason is carried for the "no" cases, so behaviour is explainable.
const disabled = shouldAutoRecap({ ...baseGate, autoOnReturn: false });
check("no-decision carries a reason", disabled.recap === false && disabled.reason.length > 0, true);

console.log("\n--- settings loader ---");
const ROOT = mkdtempSync(join(tmpdir(), "recap-"));
const AGENT = join(ROOT, "agent");
const CWD = join(ROOT, "project");
mkdirSync(AGENT, { recursive: true });
mkdirSync(join(CWD, ".pi"), { recursive: true });
const AGENT_SETTINGS = join(AGENT, "settings.json");
const PROJECT_SETTINGS = join(CWD, ".pi", "settings.json");

check("defaults when no file", loadSettings(AGENT, CWD, true).settings, {
	model: undefined,
	autoOnReturn: CONFIG.autoOnReturnDefault,
	idleThresholdMs: CONFIG.idleThresholdMs,
	minUserTurns: CONFIG.minUserTurns,
});

// Unrelated keys are ignored; the recap block is read.
writeFileSync(
	AGENT_SETTINGS,
	JSON.stringify({ theme: "one-dark-pro", recap: { model: "claude-haiku-4-5", autoOnReturn: true, idleThresholdMs: 600_000, minUserTurns: 5 } }),
);
check("reads the recap block", loadSettings(AGENT, CWD, true).settings, {
	model: "claude-haiku-4-5",
	autoOnReturn: true,
	idleThresholdMs: 600_000,
	minUserTurns: 5,
});

// A too-small threshold is floored, not honoured verbatim.
writeFileSync(AGENT_SETTINGS, JSON.stringify({ recap: { idleThresholdMs: 500 } }));
check("tiny threshold floored to 30s", loadSettings(AGENT, CWD, true).settings.idleThresholdMs, 30_000);

// Wrong types warn and fall back to the default.
writeFileSync(AGENT_SETTINGS, JSON.stringify({ recap: { model: 42, autoOnReturn: "yes" } }));
const badTypes = loadSettings(AGENT, CWD, true);
check("bad model type warns", badTypes.warnings.some((w) => w.includes("recap.model")), true);
check("bad bool type warns", badTypes.warnings.some((w) => w.includes("recap.autoOnReturn")), true);
check("bad types keep defaults", badTypes.settings.model, undefined);

// A trusted project can set the model; an untrusted one cannot.
writeFileSync(AGENT_SETTINGS, JSON.stringify({ recap: { autoOnReturn: true } }));
writeFileSync(PROJECT_SETTINGS, JSON.stringify({ recap: { model: "sneaky/model" } }));
check("trusted project model honoured", loadSettings(AGENT, CWD, true).settings.model, "sneaky/model");
const untrusted = loadSettings(AGENT, CWD, false);
check("untrusted project model ignored", untrusted.settings.model, undefined);
check("and warns about it", untrusted.warnings.some((w) => w.includes("not trusted")), true);
// But the user-level autoOnReturn still applies under an untrusted project.
check("user settings still apply", untrusted.settings.autoOnReturn, true);

// Malformed JSON is a warning, not a crash.
writeFileSync(AGENT_SETTINGS, "{ not json");
check("malformed file warns", loadSettings(AGENT, CWD, true).warnings.length > 0, true);
check("malformed file falls back to defaults", loadSettings(AGENT, CWD, true).settings.autoOnReturn, CONFIG.autoOnReturnDefault);

rmSync(ROOT, { recursive: true, force: true });

console.log("\n--- render ---");
check("idle minutes", formatIdle(6 * 60_000), "6m");
check("idle rounds up from seconds", formatIdle(90_000), "2m");
check("idle floors at a minute", formatIdle(5_000), "1m");
check("idle hours", formatIdle(72 * 60_000), "1h 12m");

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
