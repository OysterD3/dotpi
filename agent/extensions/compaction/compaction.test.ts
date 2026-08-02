/**
 * Tests for the compaction extension: settings parsing, the steering text, and
 * the decision itself against a fake compact().
 *
 * The load-bearing assertions are the fallback ones. Compaction fires when the
 * context is nearly full, so an extension that can fail to return a summary AND
 * fail to let pi make one would strand the session at the limit. Every failure
 * path is therefore asserted to return undefined, which is pi's signal to run
 * its own.
 *
 * Run: jiti agent/extensions/compaction/compaction.test.ts
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "compaction-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { DEFAULT_SETTINGS, resolveSettings } = await import("./config.ts");
const { compactionInstructions, steeringInstructions } = await import("./instructions.ts");
const { steerCompaction } = await import("./steer.ts");
type CompactFn = import("./steer.ts").CompactFn;
const { shouldTrigger } = await import("./threshold.ts");
const { loadSettings } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

// ------------------------------------------------------------------ settings

console.log("--- settings ---");
// Asked for explicitly: compaction fires at 80% of the window, and no hard
// token ceiling is imposed, because a fixed budget cuts work short and costs
// output quality. Both are pinned here so a later tidy-up cannot drift them.
check("compaction fires at 80% by default", DEFAULT_SETTINGS.compactAtPercent, 80);
check("no hard token ceiling by default", DEFAULT_SETTINGS.compactAtTokens, 0);
check("absent block -> defaults", resolveSettings(undefined), DEFAULT_SETTINGS);
check("non-object -> defaults", resolveSettings("nope"), DEFAULT_SETTINGS);
check("steer can be turned off", resolveSettings({ steer: false }).steer, false);
check("thinking is applied", resolveSettings({ thinking: "minimal" }).thinking, "minimal");
check("maxWords is applied", resolveSettings({ maxWords: 250 }).maxWords, 250);

// A typo must not reach the provider, and must not take the other keys with it.
check("unknown thinking falls back", resolveSettings({ thinking: "enormous" }).thinking, DEFAULT_SETTINGS.thinking);
check(
	"one bad key leaves the others alone",
	resolveSettings({ thinking: "enormous", maxWords: 300, steer: false }),
	{ ...DEFAULT_SETTINGS, steer: false, maxWords: 300 },
);
check("negative maxWords falls back", resolveSettings({ maxWords: -5 }).maxWords, DEFAULT_SETTINGS.maxWords);
check("non-numeric maxWords falls back", resolveSettings({ maxWords: "lots" }).maxWords, DEFAULT_SETTINGS.maxWords);
// Fractions. count() used to range-check the RAW value and floor afterwards, so
// everything in (0, 1) passed the guard and landed on 0 — which for the two
// thresholds means "disabled" and for maxWords is the value allowZero:false is
// there to reject. 0.8 is not a hypothetical: it is the obvious way to write
// "80%", and it silently switched auto-compaction off for the whole session.
check("a fractional percent does not disable compaction", resolveSettings({ compactAtPercent: 0.8 }).compactAtPercent, DEFAULT_SETTINGS.compactAtPercent);
check("nor does a fractional token cap", resolveSettings({ compactAtTokens: 0.4 }).compactAtTokens, DEFAULT_SETTINGS.compactAtTokens);
check("a fractional maxWords does not become zero", resolveSettings({ maxWords: 0.5 }).maxWords, DEFAULT_SETTINGS.maxWords);
// Flooring still applies to values that are genuinely in range.
check("in-range values still floor", resolveSettings({ compactAtPercent: 80.9 }).compactAtPercent, 80);
// And an explicit 0 still means "off" for the thresholds.
check("explicit zero still disables the percent trigger", resolveSettings({ compactAtPercent: 0 }).compactAtPercent, 0);

// pi reads enabled/reserveTokens/keepRecentTokens out of this same block. Those
// are pi's, and must survive being read by us — if resolveSettings ever grew a
// whitelist that dropped them, the block would still parse and pi's tuning
// would silently stop applying.
const shared = { enabled: true, reserveTokens: 20000, keepRecentTokens: 30000, thinking: "low" };
check("pi's own keys in the block are ignored, not rejected", resolveSettings(shared).thinking, "low");

console.log("\n--- settings from disk ---");
writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ compaction: { maxWords: 400, thinking: "off" } }));
check("read from settings.json", loadSettings(AGENT), { ...DEFAULT_SETTINGS, thinking: "off", maxWords: 400 });
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unparsable settings -> defaults", loadSettings(AGENT), DEFAULT_SETTINGS);

// ------------------------------------------------------------- instructions

console.log("\n--- steering text ---");
const steering = steeringInstructions(700);
check("states the budget", steering.includes("under 700 words"), true);
check("names the append-only failure", steering.includes("longer than the one it replaces"), true);
// Both halves matter. A prompt that only says "be shorter" gets shorter by
// dropping the expensive-to-recover things.
check("says what to drop", steering.includes("Compress or drop entirely:"), true);
check("says what to keep", steering.includes("Keep, and keep exact:"), true);
check("protects the user's own constraints", steering.includes("constraint, preference or correction"), true);
check("protects paths and errors", steering.includes("error strings that are still live"), true);

const merged = compactionInstructions(500, "focus on the parser rewrite");
check("user instructions are kept", merged.includes("focus on the parser rewrite"), true);
// pi appends this whole string after its own prompt, and later text reads as
// the operative instruction. The user's must therefore come last, not ours.
check(
	"and come last, so they win",
	merged.indexOf("focus on the parser rewrite") > merged.indexOf("Keep, and keep exact:"),
	true,
);
check("no user instructions -> steering alone", compactionInstructions(500), steeringInstructions(500));
check("blank user instructions are not merged", compactionInstructions(500, "   "), steeringInstructions(500));

// -------------------------------------------------------------- the decision

console.log("\n--- steering the call ---");

const SETTINGS = { steer: true, thinking: "low" as const, maxWords: 700 };
const okRegistry = {
	getApiKeyAndHeaders: async () => ({ ok: true as const, apiKey: "k", headers: { h: "1" }, env: { E: "2" } }),
};
const liveEvent = () => ({ preparation: { firstKeptEntryId: "abc" }, signal: new AbortController().signal });

let seen: unknown[] = [];
const recording: CompactFn = async (...args: unknown[]) => {
	seen = args;
	return { summary: "a summary", firstKeptEntryId: "abc", tokensBefore: 1000 };
};

const result = await steerCompaction(liveEvent(), { model: { id: "m" }, modelRegistry: okRegistry }, SETTINGS, recording);
check("a summary is returned to pi", (result as { compaction?: { summary?: string } })?.compaction?.summary, "a summary");
check("preparation is passed through untouched", seen[0], { firstKeptEntryId: "abc" });
check("api key and headers are passed", [seen[2], seen[3]], ["k", { h: "1" }]);
check("env is passed", seen[8], { E: "2" });
// The whole reason this extension exists: pi would have passed the session's
// level here, which on this machine is "max".
check("the CONFIGURED thinking level is used, not the session's", seen[6], "low");
check("the steering text is what pi is asked to focus on", String(seen[4]).includes("Compress or drop entirely:"), true);

const withUser = await steerCompaction(
	{ ...liveEvent(), customInstructions: "keep the migration plan" },
	{ model: { id: "m" }, modelRegistry: okRegistry },
	SETTINGS,
	recording,
);
check("a /compact instruction survives", String(seen[4]).includes("keep the migration plan"), true);
check("and still produces a compaction", (withUser as { compaction?: unknown })?.compaction !== undefined, true);

console.log("\n--- every failure falls back to pi ---");

const unreached: CompactFn = async () => {
	throw new Error("compact() should not have been called");
};

check(
	"no model -> pi's own compaction",
	await steerCompaction(liveEvent(), { model: undefined, modelRegistry: okRegistry }, SETTINGS, unreached),
	undefined,
);
check(
	"no api key -> pi's own compaction",
	await steerCompaction(
		liveEvent(),
		{ model: { id: "m" }, modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: false as const, error: "no key" }) } },
		SETTINGS,
		unreached,
	),
	undefined,
);
check(
	"a throwing compact() -> pi's own compaction",
	await steerCompaction(
		liveEvent(),
		{ model: { id: "m" }, modelRegistry: okRegistry },
		SETTINGS,
		async () => {
			throw new Error("provider exploded");
		},
	),
	undefined,
);
check(
	"a rejecting registry -> pi's own compaction",
	await steerCompaction(
		liveEvent(),
		{
			model: { id: "m" },
			modelRegistry: {
				getApiKeyAndHeaders: async () => {
					throw new Error("registry exploded");
				},
			},
		},
		SETTINGS,
		unreached,
	),
	undefined,
);
check(
	"an empty result -> pi's own compaction",
	await steerCompaction(liveEvent(), { model: { id: "m" }, modelRegistry: okRegistry }, SETTINGS, async () => undefined),
	undefined,
);

// A cancelled compaction can still resolve — the abort races the provider. If
// the summary were handed back anyway, pi would write into the session the very
// thing the user just cancelled.
const aborted = new AbortController();
check(
	"a cancelled compaction is not handed back",
	await steerCompaction(
		{ preparation: {}, signal: aborted.signal },
		{ model: { id: "m" }, modelRegistry: okRegistry },
		SETTINGS,
		async () => {
			aborted.abort();
			return { summary: "raced in", firstKeptEntryId: "abc", tokensBefore: 1 };
		},
	),
	undefined,
);

// ----------------------------------------------------------------- threshold

console.log("\n--- when to compact ---");
const BOTH = { compactAtPercent: 80, compactAtTokens: 200_000 };
const PCT = { compactAtPercent: 80, compactAtTokens: 0 };
const ABS = { compactAtPercent: 0, compactAtTokens: 200_000 };
const OFF = { compactAtPercent: 0, compactAtTokens: 0 };

check("under both -> no", shouldTrigger({ tokens: 100_000, percent: 10 }, BOTH), false);
check("over the percent -> yes", shouldTrigger({ tokens: 100_000, percent: 81 }, PCT), true);
check("exactly at the percent -> yes", shouldTrigger({ tokens: 100_000, percent: 80 }, PCT), true);
check("just under -> no", shouldTrigger({ tokens: 100_000, percent: 79 }, PCT), false);
check("over the token cap -> yes", shouldTrigger({ tokens: 200_000, percent: 20 }, ABS), true);
// The case that motivates the absolute cap: a million-token window means 20% is
// already 200k of context being re-read every turn, and the percent trigger is
// nowhere near firing.
check("a big window hides a big context from the percent trigger", shouldTrigger({ tokens: 200_000, percent: 20 }, PCT), false);
check("but the token cap still catches it", shouldTrigger({ tokens: 200_000, percent: 20 }, BOTH), true);
check("both disabled -> never", shouldTrigger({ tokens: 999_999, percent: 99 }, OFF), false);

// pi reports null right after a compaction, before the next response has been
// measured. Treating null as 0 would be harmless; treating it as "over" would
// compact in a loop on an empty context.
check("unknown tokens do not trigger", shouldTrigger({ tokens: null, percent: null }, BOTH), false);
check("unknown tokens with a known percent still use the percent", shouldTrigger({ tokens: null, percent: 80 }, BOTH), true);
check("no reading at all -> no", shouldTrigger(undefined, BOTH), false);

// -------------------------------------------------------------------- wiring

console.log("\n--- wiring ---");
const { default: register } = await import("./index.ts");

// Settings are read inside register(), not at import, so each case just
// rewrites the file first.
type Handlers = Map<string, (event: unknown, ctx: unknown) => unknown>;
function install(block: Record<string, unknown>): Handlers {
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ compaction: block }));
	const handlers: Handlers = new Map();
	register({ on: (event: string, handler: never) => handlers.set(event, handler) } as never);
	return handlers;
}

check("everything off registers nothing", [...install({ steer: false, compactAtPercent: 0, compactAtTokens: 0 }).keys()], []);
// The two halves are independently switchable: turning off the summary steering
// must not also turn off the trigger that makes compaction happen at all.
check(
	"steer:false keeps the trigger",
	[...install({ steer: false }).keys()].sort(),
	["agent_settled", "session_compact"],
);
check(
	"threshold off keeps the steering",
	[...install({ compactAtPercent: 0, compactAtTokens: 0 }).keys()],
	["session_before_compact"],
);
check(
	"defaults register both",
	[...install({}).keys()].sort(),
	["agent_settled", "session_before_compact", "session_compact"],
);
// The hook NAME is the bug this suite missed. turn_end is emitted from inside
// _runAgentPrompt, so ctx.isIdle() is false on every one of them and the
// threshold never fired; agent_settled runs after the flag is cleared.
check("the threshold rides agent_settled, never turn_end", install({}).has("turn_end"), false);

console.log("\n--- the trigger does not re-fire while compacting ---");
const handlers = install({ compactAtTokens: 100 });
let compactCalls = 0;
const overThreshold = {
	// True because agent_settled clears _isAgentRunActive on its first line —
	// unlike turn_end, where this was always false and silently killed the whole
	// feature while this suite printed ALL PASS.
	isIdle: () => true,
	getContextUsage: () => ({ tokens: 500, contextWindow: 1000, percent: 50 }),
	compact: () => {
		compactCalls++;
	},
};
handlers.get("agent_settled")?.(undefined, overThreshold);
check("over the cap -> one compaction asked for", compactCalls, 1);
// ctx.compact() returns immediately, so the next turn_end sees the same
// over-threshold reading. Without the guard this asks again, and again.
handlers.get("agent_settled")?.(undefined, overThreshold);
check("still compacting -> not asked again", compactCalls, 1);
handlers.get("session_compact")?.(undefined, overThreshold);
handlers.get("agent_settled")?.(undefined, overThreshold);
check("after it lands -> free to ask again", compactCalls, 2);

// Mid-run is the wrong moment: compaction rewrites the branch. Kept as a
// belt-and-braces assertion — on agent_settled the run is over by construction.
compactCalls = 0;
const busy = { ...overThreshold, isIdle: () => false };
install({ compactAtTokens: 100 }).get("agent_settled")?.(undefined, busy);
check("not while the agent is busy", compactCalls, 0);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
