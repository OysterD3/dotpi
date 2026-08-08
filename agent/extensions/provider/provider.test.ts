/**
 * Tests for the provider role map.
 *
 *     pnpm dlx jiti agent/extensions/provider/provider.test.ts
 *
 * Two things carry the weight. `resolveRole` is copied into six other
 * extensions, so its fallback behaviour is the contract they all depend on —
 * anything unusable must return the reference untouched, because that is what
 * every one of those settings meant before roles existed. And `writeActive`
 * rewrites settings.json, the one file that loses your whole configuration if a
 * write goes wrong.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBlock, planSwitch, profileFor, resolveRole, splitThinking } from "./roles.ts";
import { readSettings, writeActive } from "./settings.ts";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function agentDirWith(settings: unknown): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
	writeFileSync(join(dir, "settings.json"), typeof settings === "string" ? settings : JSON.stringify(settings, null, 2));
	return dir;
}

const BLOCK = {
	models: {
		active: "openai",
		providers: {
			openai: { session: "openai-codex/gpt-5.6-sol", cheap: "openai-codex/gpt-5.4-mini" },
			anthropic: { session: "anthropic/claude-opus-4-5", cheap: "anthropic/claude-haiku-4-5", extra: "anthropic/x" },
		},
	},
};

// ---------------------------------------------------------------------------
console.log("\nresolveRole — the contract the other six extensions copy");

{
	const dir = agentDirWith(BLOCK);
	eq("a role maps through the active profile", resolveRole("cheap", dir), "openai-codex/gpt-5.4-mini");
	eq("and so does the session role", resolveRole("session", dir), "openai-codex/gpt-5.6-sol");
	// The whole point: same role name, different answer.
	const swapped = agentDirWith({ models: { ...BLOCK.models, active: "anthropic" } });
	eq("switching active switches the answer", resolveRole("cheap", swapped), "anthropic/claude-haiku-4-5");

	// A concrete reference must survive untouched, or every existing config breaks.
	eq("a literal reference passes through", resolveRole("openai-codex/gpt-5.6-luna", dir), "openai-codex/gpt-5.6-luna");
	eq("an undefined role passes through", resolveRole("nonesuch", dir), "nonesuch");
	eq("a role only the OTHER profile defines passes through", resolveRole("extra", dir), "extra");
}

// ---------------------------------------------------------------------------
console.log("resolveRole — every failure returns the reference unchanged");

// This is the property that lets the feature be absent or broken without
// breaking model resolution anywhere.
eq("no settings file", resolveRole("cheap", join(tmpdir(), "pi-provider-absent-xyz")), "cheap");
eq("unparseable settings", resolveRole("cheap", agentDirWith("{ not json")), "cheap");
eq("no models block", resolveRole("cheap", agentDirWith({ theme: "x" })), "cheap");
eq("models is not an object", resolveRole("cheap", agentDirWith({ models: "nope" })), "cheap");
eq("no active set", resolveRole("cheap", agentDirWith({ models: { providers: BLOCK.models.providers } })), "cheap");
eq("active names no profile", resolveRole("cheap", agentDirWith({ models: { active: "ghost", providers: {} } })), "cheap");
eq("providers is not an object", resolveRole("cheap", agentDirWith({ models: { active: "a", providers: 7 } })), "cheap");
eq("the role maps to a non-string", resolveRole("cheap", agentDirWith({ models: { active: "a", providers: { a: { cheap: 7 } } } })), "cheap");
eq("the role maps to blank", resolveRole("cheap", agentDirWith({ models: { active: "a", providers: { a: { cheap: "  " } } } })), "cheap");

// ---------------------------------------------------------------------------
console.log("splitThinking — a trailing :level splits, anything else is the id");

{
	for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const split = splitThinking(`anthropic/claude-opus-5:${level}`);
		eq(`:${level} splits`, split.thinking, level);
		eq(`and leaves the reference bare`, split.reference, "anthropic/claude-opus-5");
	}

	// Ids with colons are real — OpenRouter ships them — so an unknown suffix
	// must stay part of the id, not vanish.
	eq("an unknown suffix stays put", splitThinking("openrouter/deepseek-chat:free").reference, "openrouter/deepseek-chat:free");
	check("and carries no level", splitThinking("openrouter/deepseek-chat:free").thinking === undefined);
	eq("only the LAST colon is the seam", splitThinking("openrouter/model:free:high").reference, "openrouter/model:free");
	eq("with the level split off", splitThinking("openrouter/model:free:high").thinking, "high");

	eq("no suffix passes through", splitThinking("openai-codex/gpt-5.6-sol").reference, "openai-codex/gpt-5.6-sol");
	eq("the level is case-insensitive", splitThinking("a/b:HIGH").thinking, "high");
	eq("and whitespace-tolerant", splitThinking("a/b: high").thinking, "high");
	eq("a lone :level is not a reference to split", splitThinking(":high").reference, ":high");
	eq("an empty base refuses to split", splitThinking(" :high").reference, " :high");
}

// ---------------------------------------------------------------------------
console.log("parseBlock — one bad entry does not cost the rest");

{
	const { block, warnings } = parseBlock({
		models: {
			active: "openai",
			providers: {
				openai: { session: "a/b", broken: 7 },
				bad: "not an object",
			},
		},
	});
	eq("the good role survives", block.providers.openai?.session, "a/b");
	check("the bad one is dropped", block.providers.openai?.broken === undefined);
	check("and named", warnings.some((w) => w.includes("openai.broken")), warnings.join(" | "));
	check("a malformed profile is named too", warnings.some((w) => w.includes("providers.bad")), warnings.join(" | "));

	eq("no block is not a warning", parseBlock({ theme: "x" }).warnings.length, 0);
	check("a non-object block is", parseBlock({ models: [] }).warnings.length > 0);
	eq("profileFor with no active", profileFor(parseBlock(BLOCK).block, undefined), undefined);
}

// ---------------------------------------------------------------------------
console.log("planSwitch — says what changes before anything is written");

{
	const { block } = parseBlock(BLOCK);
	const plan = planSwitch(block, "anthropic");
	check("a known profile plans", !("error" in plan));
	if (!("error" in plan)) {
		eq("the session role is carried out", plan.session, "anthropic/claude-opus-4-5");
		check("every role in the target is reported", plan.moved.map((m) => m.role).includes("cheap"));
		check("with where it came from", plan.moved.find((m) => m.role === "cheap")?.from === "openai-codex/gpt-5.4-mini");
		eq("nothing is dropped going this way", plan.dropped.length, 0);
	}

	// The failure the report exists for: a role the target does not define stops
	// being a role and starts being read as a literal model reference.
	const back = planSwitch(parseBlock({ models: { ...BLOCK.models, active: "anthropic" } }).block, "openai");
	check("going back drops the role only anthropic had", !("error" in back) && back.dropped.includes("extra"));

	const unknown = planSwitch(block, "ghost");
	check("an unknown profile is an error", "error" in unknown);
	check("that lists what exists", "error" in unknown && unknown.error.includes("anthropic"), JSON.stringify(unknown));
	check(
		"and an empty map says so differently",
		(() => {
			const empty = planSwitch({ providers: {} }, "x");
			return "error" in empty && empty.error.includes("No provider profiles");
		})(),
	);
}

// ---------------------------------------------------------------------------
console.log("writeActive — preserves everything it does not own");

{
	const dir = agentDirWith({
		theme: "one-dark-pro",
		defaultProvider: "openai-codex",
		defaultModel: "gpt-5.6-sol",
		permissions: { defaultMode: "auto", deny: ["Read(**/.env)"] },
		models: BLOCK.models,
	});

	const result = writeActive(dir, "anthropic", "anthropic/claude-opus-4-5");
	check("the write succeeds", result.ok, JSON.stringify(result));

	const after = readSettings(dir);
	eq("active moved", (after.models as { active: string }).active, "anthropic");
	eq("the session provider followed", after.defaultProvider, "anthropic");
	eq("and the session model", after.defaultModel, "claude-opus-4-5");

	// The reason the writer merges over the parsed file instead of serialising
	// its own schema: everything else in settings.json belongs to pi or to
	// another extension, and must come back untouched.
	eq("the theme survives", after.theme, "one-dark-pro");
	eq("the permissions block survives whole", JSON.stringify(after.permissions), JSON.stringify({ defaultMode: "auto", deny: ["Read(**/.env)"] }));
	eq("and the profiles are still there", Object.keys((after.models as { providers: object }).providers).length, 2);

	// A bare id says nothing about whose model it is, so defaultProvider must not
	// be rewritten — pointing the old provider at a new model id would break it.
	const bare = agentDirWith({ defaultProvider: "openai-codex", defaultModel: "old", models: BLOCK.models });
	writeActive(bare, "anthropic", "just-an-id");
	eq("a bare id leaves defaultProvider alone", readSettings(bare).defaultProvider, "openai-codex");
	eq("but still moves defaultModel", readSettings(bare).defaultModel, "just-an-id");

	// Switching with no session role must not invent one.
	const noSession = agentDirWith({ defaultModel: "keep", models: { active: "a", providers: { a: {}, b: {} } } });
	writeActive(noSession, "b", undefined);
	eq("no session role, no change to defaultModel", readSettings(noSession).defaultModel, "keep");
	eq("but active still moves", (readSettings(noSession).models as { active: string }).active, "b");
}

// ---------------------------------------------------------------------------
console.log("writeActive — a thinking level persists, its absence changes nothing");

{
	// The level rides along with the model because pi reads them as separate
	// keys: a suffixed defaultModel would name a model that does not exist.
	const dir = agentDirWith({ defaultThinkingLevel: "max", models: BLOCK.models });
	writeActive(dir, "anthropic", "anthropic/claude-opus-4-5", "high");
	eq("the level is written", readSettings(dir).defaultThinkingLevel, "high");
	eq("next to the split model", readSettings(dir).defaultModel, "claude-opus-4-5");

	// A profile that states no level must not clobber the one the user set by
	// hand — that is the same "absent means untouched" rule as everything else.
	const silent = agentDirWith({ defaultThinkingLevel: "max", models: BLOCK.models });
	writeActive(silent, "anthropic", "anthropic/claude-opus-4-5");
	eq("no level leaves defaultThinkingLevel alone", readSettings(silent).defaultThinkingLevel, "max");

	const never = agentDirWith({ models: BLOCK.models });
	writeActive(never, "anthropic", "anthropic/claude-opus-4-5");
	check("and does not invent one", readSettings(never).defaultThinkingLevel === undefined);
}

// ---------------------------------------------------------------------------
console.log("writeActive — refuses rather than clobbering");

{
	// An unreadable settings.json is a file with a typo in it. Starting fresh
	// would throw away everything the user has configured.
	const broken = agentDirWith("{ this is not json");
	const result = writeActive(broken, "anthropic", undefined);
	check("a malformed file is refused", !result.ok);
	eq("and left exactly as it was", readFileSync(join(broken, "settings.json"), "utf8"), "{ this is not json");

	const missing = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
	check("a missing file is refused too", !writeActive(missing, "anthropic", undefined).ok);

	const notAnObject = agentDirWith([1, 2, 3]);
	check("and so is a non-object", !writeActive(notAnObject, "anthropic", undefined).ok);
}

// ---------------------------------------------------------------------------
console.log("readSettings");

{
	eq("a missing file reads as empty", Object.keys(readSettings(mkdtempSync(join(tmpdir(), "pi-provider-test-")))).length, 0);
	eq("so does a broken one", Object.keys(readSettings(agentDirWith("{{{"))).length, 0);
	const nested = mkdtempSync(join(tmpdir(), "pi-provider-test-"));
	mkdirSync(join(nested, "sub"));
	eq("and a directory with no settings at all", Object.keys(readSettings(nested)).length, 0);
}

// ---------------------------------------------------------------------------
console.log("the copies have not drifted");

// resolveRole is duplicated into every extension that resolves a model, because
// they install independently and cannot import across boundaries. Duplication
// is the accepted cost here; SILENT duplication is not. If someone fixes a bug
// in one copy, this says which others still have it.
{
	const here = new URL(".", import.meta.url).pathname;
	const extensions = new URL("../", import.meta.url).pathname;
	const body = (source: string, name: string): string | undefined => {
		const start = source.indexOf(`export function ${name}(`);
		if (start === -1) return undefined;
		const end = source.indexOf("\n}", start);
		return end === -1 ? undefined : source.slice(start, end + 2).replace(/\s+/g, " ").trim();
	};

	const source = readFileSync(join(here, "roles.ts"), "utf8");
	for (const name of ["resolveRole", "splitThinking"]) {
		const original = body(source, name);
		check(`the original ${name} is findable`, original !== undefined);

		for (const copy of [
			"goal/model.ts",
			"recap/model.ts",
			"permissions/model.ts",
			"advisor/models.ts",
			"ultracode/models.ts",
			"subagents/models.ts",
		]) {
			const path = join(extensions, copy);
			if (!existsSync(path)) {
				console.log(`  SKIP  ${copy} is not installed`);
				continue;
			}
			const found = body(readFileSync(path, "utf8"), name);
			check(`${copy} still has a copy of ${name}`, found !== undefined);
			if (found !== undefined) eq(`${copy} matches the original ${name}`, found, original);
		}
	}
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
