/**
 * Tests for session-ref: picker rules, branch loading (including a rewound
 * session, where only the kept branch may be referenced), transcript
 * budgeting, the injected block, the model-selection policy copy, the `#`
 * marker and its trigger rules, and the whole autocomplete-to-submit path
 * end-to-end against a scripted fake pi — the completion/confirm/sendMessage
 * seams are where integration bugs actually live.
 *
 *     pnpm dlx jiti agent/extensions/session-ref/session-ref.test.ts
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
const checkTrue = (label: string, got: boolean) => check(label, got, true);

const { CONFIG, MESSAGE_TYPE } = await import("./config.ts");
const { pickable, matches, label, loadBranchEntries } = await import("./sessions.ts");
const { buildSections, buildTranscript } = await import("./transcript.ts");
const { referenceBlock } = await import("./prompts.ts");
const { selectModel } = await import("./model.ts");
const { registerSessionRef } = await import("./index.ts");
const { findMarkers, markerText, replaceMarkers, safeName, spokenName } = await import("./marker.ts");
const { triggerAt, displayNames, withRefCompletions } = await import("./autocomplete.ts");

// ------------------------------------------------------------------ picker rules

console.log("--- picker rules ---");
const row = (id: string, over: Partial<Parameters<typeof pickable>[0][number]> = {}) => ({
	path: `/sessions/${id}.jsonl`,
	id,
	cwd: "/work",
	modified: new Date("2026-08-01T00:00:00Z"),
	messageCount: 4,
	firstMessage: `first message of ${id}`,
	allMessagesText: `all text of ${id}`,
	...over,
});

{
	const rows = [
		row("old", { modified: new Date("2026-07-01T00:00:00Z") }),
		row("current"),
		row("empty", { messageCount: 0 }),
		row("new", { modified: new Date("2026-08-05T00:00:00Z") }),
	];
	const picked = pickable(rows, "/sessions/current.jsonl");
	check("current and empty sessions are excluded", picked.map((r) => r.id), ["new", "old"]);
	check("no current file excludes nothing extra", pickable(rows, undefined).map((r) => r.id), ["new", "current", "old"]);

	const many = Array.from({ length: 30 }, (_, i) => row(`s${i}`));
	check("rows are capped for the picker", pickable(many, undefined).length, CONFIG.maxPickerRows);

	// The review's catch: the query must filter BEFORE the cap, or a search
	// can never reach anything the capped list would not already show.
	const buried = [
		...Array.from({ length: 25 }, (_, i) => row(`recent${i}`, { modified: new Date(`2026-08-${String(i + 1).padStart(2, "0")}T00:00:00Z`) })),
		row("needle", { name: "darkmode work", modified: new Date("2026-01-01T00:00:00Z") }),
	];
	check("a query reaches past the cap", pickable(buried, undefined, "darkmode").map((r) => r.id), ["needle"]);
}

{
	checkTrue("matches by name", matches(row("x", { name: "Provider Refactor" }), "refactor"));
	checkTrue("matches by first message", matches(row("x"), "FIRST MESSAGE"));
	checkTrue("matches by id", matches(row("abcdef123"), "abcdef"));
	checkTrue("matches by any message text", matches(row("x"), "all text"));
	checkTrue("empty query matches everything", matches(row("x"), "  "));
	check("no match is honest", matches(row("x"), "zzz-nope"), false);

	const l = label(row("x", { name: "My  Session\nName" }), 2);
	checkTrue("label collapses whitespace and shows index", l.startsWith("3. My Session Name"));
	checkTrue("label carries date and count", l.includes("2026-08-01") && l.includes("4 msgs"));
	checkTrue("a long title is clipped", label(row("x", { name: "y".repeat(100) }), 0).length < 100);
}

// ------------------------------------------------------- loading a rewound session

console.log("\n--- loadBranchEntries follows the branch pi would resume ---");
{
	const dir = mkdtempSync(join(tmpdir(), "session-ref-"));
	const path = join(dir, "s.jsonl");
	const entry = (id: string, parentId: string | null, role: string, text: string) =>
		JSON.stringify({ type: "message", id, parentId, timestamp: "2026-08-01T00:00:00Z", message: { role, content: [{ type: "text", text }] } });
	// A(user) -> B(assistant) -> C(user, abandoned by a rewind) ; D(user) forked from B.
	writeFileSync(
		path,
		[
			JSON.stringify({ type: "session", version: 3, id: "s", timestamp: "2026-08-01T00:00:00Z", cwd: "/work" }),
			entry("A", null, "user", "start here"),
			entry("B", "A", "assistant", "did the thing"),
			entry("C", "B", "user", "ABANDONED FORK"),
			entry("D", "B", "user", "kept branch"),
		].join("\n"),
	);

	const texts = buildSections(loadBranchEntries(path) as never);
	checkTrue("the kept branch is present", texts.join(" ").includes("kept branch"));
	check("the abandoned fork is not", texts.join(" ").includes("ABANDONED"), false);
	checkTrue("the shared prefix is present", texts.join(" ").includes("start here"));
	check("an empty file loads as nothing", loadBranchEntries(join(dir, "missing.jsonl")).length, 0);

	// A v1 file has no id/parentId; without pi's migration the branch walk
	// would end at the last entry and the conversation collapse to one line.
	const v1 = join(dir, "v1.jsonl");
	writeFileSync(
		v1,
		[
			JSON.stringify({ type: "session", id: "old", timestamp: "2025-01-01T00:00:00Z", cwd: "/work" }),
			JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "first line" }] } }),
			JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "second line" }] } }),
		].join("\n"),
	);
	const migrated = buildSections(loadBranchEntries(v1) as never);
	check("an old-format file keeps its whole conversation", migrated.length, 2);
	checkTrue("in order", migrated[0].includes("first line") && migrated[1].includes("second line"));
}

// ------------------------------------------------------------- transcript budget

console.log("\n--- transcript budgeting ---");
{
	const msg = (role: string, text: string) => ({ type: "message", message: { role, content: [{ type: "text", text }] } });
	const entries = [msg("user", "a".repeat(100)), msg("assistant", "b".repeat(100)), msg("user", "c".repeat(100))];

	const roomy = buildTranscript(entries as never, 10_000);
	check("everything fits when the budget is roomy", roomy.dropped, 0);

	const tight = buildTranscript(entries as never, 250);
	checkTrue("the oldest drops first", tight.dropped > 0 && tight.text.includes("c".repeat(100)));
	checkTrue("and the drop is announced in the text", tight.text.includes("omitted"));
	check("a" + " never survives over c", tight.text.includes("a".repeat(100)), false);
	check("fitting whole is not clipping", tight.clipped, false);

	// The review's catch: the budget is a CAP. A single oversized final
	// message must not sail through it — its tail is kept, behind a notice.
	const huge = [msg("user", "small"), msg("assistant", "z".repeat(10_000))];
	const capped = buildTranscript(huge as never, 400);
	checkTrue("an oversized final message is cut to the budget", capped.text.length < 600);
	checkTrue("keeping its tail", capped.text.endsWith("z".repeat(50)));
	checkTrue("and saying it was cut", capped.clipped && capped.text.includes("cut to fit"));
	check("a zero budget keeps only the notice", buildTranscript(huge as never, 0).text.includes("z"), false);

	// A compacted session's branch starts with the summary standing in for
	// everything before it — dropping that would silently begin mid-story.
	const compacted = [
		{ type: "compaction", summary: "Earlier: built the provider map." },
		msg("user", "now add levels"),
		{ type: "custom_message", content: [{ type: "text", text: "memory block" }] },
	];
	const flat = buildTranscript(compacted as never, 10_000);
	checkTrue("a compaction summary is carried", flat.text.includes("Summary of earlier work: Earlier: built the provider map."));
	checkTrue("an injected custom message is carried", flat.text.includes("Context: memory block"));
}

// ---------------------------------------------------------------- injected block

console.log("\n--- the injected block ---");
{
	const block = referenceBlock(
		{ name: "provider work", id: "0123456789ab", date: "2026-08-07", cwd: "/work/pi", mode: "summary" },
		"Goal: things.",
	);
	checkTrue("names the session", block.includes("provider work"));
	checkTrue("carries provenance", block.includes("01234567") && block.includes("2026-08-07") && block.includes("/work/pi"));
	checkTrue("guards against instruction bleed", block.includes("not requests to act"));
	checkTrue("carries the body", block.includes("Goal: things."));
	checkTrue("states the mode", block.includes("summary"));
}

// -------------------------------------------------------- model selection policy

console.log("\n--- selectModel: the recap policy, copied ---");
{
	const M = (provider: string, id: string) => ({ provider, id, name: id, contextWindow: 200_000 });
	const MODELS = [M("openai-codex", "gpt-5.6-luna"), M("anthropic", "claude-sonnet-5")];
	const session = M("qoder", "ultimate");
	const dirWith = (settings: unknown) => {
		const dir = mkdtempSync(join(tmpdir(), "session-ref-select-"));
		writeFileSync(join(dir, "settings.json"), JSON.stringify(settings));
		return dir;
	};
	const picked = (r: { ok: true; model: { provider: string; id: string } } | { ok: false }) =>
		r.ok ? `${r.model.provider}/${r.model.id}` : "ERR";

	const roleMap = dirWith({ models: { active: "a", providers: { a: { cheap: "openai-codex/gpt-5.6-luna" } } } });
	const bare = dirWith({});
	check("the cheap role is the default", picked(selectModel(undefined, session, MODELS, roleMap)), "openai-codex/gpt-5.6-luna");
	check("no role map -> session model", picked(selectModel(undefined, session, MODELS, bare)), "qoder/ultimate");
	check("an explicit miss fails, never falls back", picked(selectModel("nope", session, MODELS, roleMap)), "ERR");
	check("nothing anywhere is the only failure", selectModel(undefined, undefined, MODELS, bare).ok, false);
}

// -------------------------------------------------------------- marker syntax

console.log("\n--- the #[Name] marker ---");
{
	check("one hash is a summary", markerText("summary", "dark mode"), "#[dark mode]");
	check("two hashes are the full transcript", markerText("full", "dark mode"), "##[dark mode]");

	check("brackets cannot end a name early", safeName("a ] b [ c"), "a b c");
	check("newlines collapse", safeName("a\nb"), "a b");
	check("a leading hash would read as another marker", safeName("#tag work"), "tag work");
	check("a name of nothing still makes a matchable marker", safeName("[]"), "session");
	check("long names are clipped", safeName("x".repeat(90)).length, 64);

	const found = findMarkers('fix #[one] like ##[two] did');
	check("both modes are found", found.map((m) => `${m.mode}:${m.name}`), ["summary:one", "full:two"]);
	check("three hashes are prose, not a mode", findMarkers("### [heading]").length, 0);
	check("a hash mid-word does not start one", findMarkers("issue#[one]").length, 0);
	check("a marker at the very start is found", findMarkers("#[one] first").length, 1);

	check(
		"replacement runs right to left, so offsets stay good",
		replaceMarkers("a #[one] b ##[two] c", (m) => spokenName(m)),
		'a "one" b "two" c',
	);
	check(
		"an unresolved marker can be left exactly as typed",
		replaceMarkers("a #[one] b #[two] c", (m) => (m.name === "one" ? spokenName(m) : m.text)),
		'a "one" b #[two] c',
	);
}

// ------------------------------------------------------------ trigger rules

console.log("\n--- when # opens the list ---");
{
	const hit = (line: string, col = line.length) => {
		const t = triggerAt(line, col);
		return t ? `${t.mode}:${t.query}` : "none";
	};
	check("at the start of a line", hit("#dark"), "summary:dark");
	check("after a space, mid-sentence", hit("fix it like #dark"), "summary:dark");
	check("two hashes ask for the full transcript", hit("fix it like ##dark"), "full:dark");
	check("a bare hash opens the whole list", hit("#"), "summary:");
	check("a hash inside a word is not a trigger", hit("issue#dark"), "none");
	check("a half-typed marker does not reopen the list", hit("#[dar"), "none");
	check("nor does the cursor sitting after a finished one", hit("#[dark mode]"), "none");
	check("the cursor's column is what counts, not the line", hit("#dark mode", 5), "summary:dark");
}

// ------------------------------------------------------------- unique names

console.log("\n--- names in the popup, ids in the marker ---");
{
	const at = (id: string, name: string, day: string) => row(id, { name, modified: new Date(`2026-08-${day}T00:00:00Z`) });
	check("distinct names are left alone", displayNames([at("a", "one", "01"), at("b", "two", "02")]), ["one", "two"]);
	check("a repeat takes its date, for the human reading the list", displayNames([at("a", "dup", "01"), at("b", "dup", "02")]), ["dup 2026-08-01", "dup 2026-08-02"]);
	{
		// The bug this replaced: safeName() re-clipped to 64 and ate the suffix.
		const long = "x".repeat(70);
		const names = displayNames([at("aaaaaaaa", long, "01"), at("bbbbbbbb", long, "01")]);
		check("a long repeat still gets its suffix", names[0].endsWith("2026-08-01"), true);
		check("even though the base was clipped to 64", names[0].length, 64 + 11);
	}
	{
		// Identical display names are no longer a correctness problem, because
		// the marker carries the id.
		const rows = [at("aaaaaaaa", "dup", "01"), at("bbbbbbbb", "dup", "01")];
		const names = displayNames(rows);
		check("two same-day repeats can share a label", names[0], names[1]);
		const m0 = markerText("summary", names[0], rows[0].id);
		const m1 = markerText("summary", names[1], rows[1].id);
		checkTrue("but never a marker", m0 !== m1);
		check("and each names its own session", [findMarkers(m0)[0].id, findMarkers(m1)[0].id], ["aaaaaaaa", "bbbbbbbb"]);
	}
}

// -------------------------------------------------- the provider, stacked

console.log("\n--- the # provider over pi's own ---");
{
	const delegated: string[] = [];
	const base = {
		triggerCharacters: ["@"],
		getSuggestions: async () => {
			delegated.push("getSuggestions");
			return { items: [{ value: "@file.ts", label: "file.ts" }], prefix: "@fi" };
		},
		applyCompletion: (lines: string[]) => {
			delegated.push("applyCompletion");
			return { lines, cursorLine: 0, cursorCol: 0 };
		},
		shouldTriggerFileCompletion: () => true,
	};
	// Real session ids, because the marker carries eight characters of one.
	const rows = [row("0a3f1c2b9d", { name: "dark mode work" }), row("7e54cc11ab", { name: "parser rewrite" })];
	const provider = withRefCompletions(base as never, { rows: async () => rows });

	check("pi's own trigger characters survive", provider.triggerCharacters, ["@", "#"]);

	const opts = { signal: new AbortController().signal };
	const mine = await provider.getSuggestions(["fix like #da"], 0, 12, opts);
	check("a # token is answered here", mine?.items.map((i) => i.value), ["#[dark mode work·0a3f1c2b]", "#[parser rewrite·7e54cc11]"]);
	check("the prefix is the whole token, hashes included", mine?.prefix, "#da");
	check("the marker names the session, not just its label", findMarkers(mine!.items[0].value)[0].id, "0a3f1c2b");
	check("an @ token is handed straight down", (await provider.getSuggestions(["see @fi"], 0, 7, opts))?.prefix, "@fi");
	checkTrue("and the inner provider really ran", delegated.includes("getSuggestions"));

	const full = await provider.getSuggestions(["fix like ##da"], 0, 13, opts);
	check("two hashes offer full-transcript markers", full?.items[0].value, "##[dark mode work·0a3f1c2b]");
	checkTrue("and say so in the row", full?.items[0].description?.includes("full transcript") === true);

	const applied = provider.applyCompletion(["fix like #da"], 0, 12, { value: "#[dark mode work]", label: "x" }, "#da");
	check("the marker replaces the token", applied.lines[0], "fix like #[dark mode work] ");
	check("and the cursor lands after it", applied.cursorCol, applied.lines[0].length);

	const mid = provider.applyCompletion(["a #da b"], 0, 5, { value: "#[dark mode work]", label: "x" }, "#da");
	check("mid-sentence insertion keeps the tail", mid.lines[0], "a #[dark mode work] b");

	provider.applyCompletion(["see @fi"], 0, 7, { value: "@file.ts", label: "x" }, "@fi");
	checkTrue("a file completion is still the inner provider's job", delegated.includes("applyCompletion"));
	check("and a # token never opens the file picker", provider.shouldTriggerFileCompletion?.(["a #da"], 0, 5), false);
	check("while everything else still can", provider.shouldTriggerFileCompletion?.(["a @fi"], 0, 5), true);
}

// ------------------------------------------------------- autocomplete to submit

console.log("\n--- # to submit, against a scripted fake pi ---");
{
	// A branched session on disk, so the wiring test exercises the real loader.
	const dir = mkdtempSync(join(tmpdir(), "session-ref-wire-"));
	const sessionPath = join(dir, "other.jsonl");
	writeFileSync(
		sessionPath,
		[
			JSON.stringify({ type: "session", version: 3, id: "other", timestamp: "2026-08-01T00:00:00Z", cwd: "/elsewhere" }),
			JSON.stringify({ type: "message", id: "A", parentId: null, timestamp: "2026-08-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text: "please add dark mode" }] } }),
			JSON.stringify({ type: "message", id: "B", parentId: "A", timestamp: "2026-08-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "added a theme toggle" }] } }),
		].join("\n"),
	);

	const sent: Array<{ message: { customType: string; content: string; display: boolean; details: { mode: string; name: string } }; options: unknown }> = [];
	const hooks = new Map<string, (event: unknown, ctx: unknown) => Promise<unknown>>();
	const renderers: string[] = [];
	const pi = {
		on: (event: string, handler: never) => hooks.set(event, handler),
		registerMessageRenderer: (type: string) => renderers.push(type),
		sendMessage: (message: never, options: never) => sent.push({ message, options }),
		events: { emit: () => {} },
	};

	const rows = [row("other", { path: sessionPath, name: "dark mode work", cwd: "/elsewhere", modified: new Date("2026-08-07T00:00:00Z") })];
	registerSessionRef(pi as never, { list: async () => rows, listAll: async () => [] });
	checkTrue("the renderer is registered for the message type", renderers.includes(MESSAGE_TYPE));
	checkTrue("session_start and input are both hooked", hooks.has("session_start") && hooks.has("input"));

	const notices: string[] = [];
	const confirms: string[] = [];
	let stacked = 0;
	const makeCtx = (over: { confirm?: boolean; used?: number; hasUI?: boolean } = {}) => ({
		hasUI: over.hasUI ?? true,
		cwd: "/work",
		model: { id: "m", provider: "p", contextWindow: 100_000 },
		getContextUsage: () => ({ tokens: over.used ?? 60_000 }),
		sessionManager: { getSessionFile: () => "/sessions/me.jsonl" },
		// No credentials in a test, so the summary path fails at the seam it
		// really fails at rather than being stubbed out of existence.
		modelRegistry: { getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "no api key here" }) },
		signal: undefined,
		ui: {
			addAutocompleteProvider: () => {
				stacked++;
			},
			confirm: async (_title: string, message: string) => {
				confirms.push(message);
				return over.confirm ?? true;
			},
			notify: (message: string) => notices.push(message),
		},
	});

	const start = hooks.get("session_start")!;
	const input = hooks.get("input")!;

	await start({}, makeCtx() as never);
	check("the provider is stacked once", stacked, 1);
	await start({}, makeCtx() as never);
	check("and never again, however many sessions start", stacked, 1);

	// Text with no marker is not this extension's business at all.
	check("a plain prompt passes straight through", await input({ text: "just do the thing" }, makeCtx() as never), { action: "continue" });

	// ## confirmed: the reference is injected and the sentence keeps the name.
	const submitted = (await input({ text: 'fix it like ##[dark mode work] did' }, makeCtx() as never)) as { action: string; text: string };
	check("the prompt is rewritten", submitted, { action: "transform", text: 'fix it like "dark mode work" did' });
	check("one message was sent", sent.length, 1);
	check("as the session-ref custom type", sent[0].message.customType, MESSAGE_TYPE);
	check("without triggering a turn", (sent[0].options as { triggerTurn: boolean }).triggerTurn, false);
	check("in full mode", sent[0].message.details.mode, "full");
	checkTrue("the content names the source session", sent[0].message.content.includes("dark mode work"));
	checkTrue("the content carries the foreign cwd", sent[0].message.content.includes("/elsewhere"));
	checkTrue("the content carries the conversation", sent[0].message.content.includes("dark mode"));

	// Declining leaves the prompt alone rather than half-doing it.
	const declined = await input({ text: 'like ##[dark mode work]' }, makeCtx({ confirm: false }) as never);
	check("declining injects nothing", sent.length, 1);
	check("and leaves the marker exactly as typed", declined, { action: "continue" });

	// Zero remaining context is the worst case, and exactly where the severe
	// wording must NOT quietly disappear.
	await input({ text: '##[dark mode work]' }, makeCtx({ confirm: false, used: 100_000 }) as never);
	checkTrue("no-context-left is said severely", confirms.some((m) => m.includes("NO context left")));

	// A full transcript cannot be priced without a UI, so it is not injected.
	const headless = await input({ text: '##[dark mode work]' }, makeCtx({ hasUI: false }) as never);
	check("a full ref needs a UI to price it", headless, { action: "continue" });
	check("and injects nothing without one", sent.length, 1);

	// A marker naming nothing is left alone, not silently dropped.
	const unknown = await input({ text: 'like #[no such session] please' }, makeCtx() as never);
	check("an unresolvable marker passes through untouched", unknown, { action: "continue" });
	check("and injects nothing", sent.length, 1);

	// Summary mode says what it is doing before the model call, then reports
	// the failure honestly when there is no model to make it with.
	const summary = await input({ text: 'like #[dark mode work]' }, makeCtx() as never);
	checkTrue("the wait is announced", notices.some((n) => n.includes("Summarising")));
	checkTrue("and the reason it failed is reported", notices.some((n) => n.includes("no api key here")));
	check("a failed summary injects nothing", sent.length, 1);
	check("and leaves the prompt as typed", summary, { action: "continue" });
}

// ------------------------------------------------- what the review found

console.log("\n--- resolution after the marker leaves this process ---");
{
	const dir = mkdtempSync(join(tmpdir(), "session-ref-resolve-"));
	const mk = (id: string, text: string) => {
		const p = join(dir, `${id}.jsonl`);
		writeFileSync(
			p,
			[
				JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-08-01T00:00:00Z", cwd: "/elsewhere" }),
				JSON.stringify({ type: "message", id: "A", parentId: null, timestamp: "2026-08-01T00:00:00Z", message: { role: "user", content: [{ type: "text", text }] } }),
				JSON.stringify({ type: "message", id: "B", parentId: "A", timestamp: "2026-08-01T00:00:01Z", message: { role: "assistant", content: [{ type: "text", text: "ok" }] } }),
			].join("\n"),
		);
		return p;
	};

	// Twenty local sessions all called "dup", plus one in another project: every
	// class of marker the old name-only fallback could not resolve.
	const local = Array.from({ length: 20 }, (_, i) =>
		row(`local${String(i).padStart(4, "0")}`, { path: mk(`local${String(i).padStart(4, "0")}`, "dup work"), name: "dup", modified: new Date(`2026-07-${String(i + 1).padStart(2, "0")}T00:00:00Z`) }),
	);
	const far = row("faraway99", { path: mk("faraway99", "another project"), name: "over there", cwd: "/other", modified: new Date("2026-06-01T00:00:00Z") });

	const sent: any[] = [];
	const hooks = new Map<string, any>();
	const pi = {
		on: (e: string, h: never) => hooks.set(e, h),
		registerMessageRenderer: () => {},
		sendMessage: (m: never, o: never) => sent.push({ m, o }),
		events: { emit: () => {} },
	};
	let listCalls = 0;
	let listAllCalls = 0;
	registerSessionRef(pi as never, {
		list: async () => {
			listCalls++;
			return local;
		},
		listAll: async () => {
			listAllCalls++;
			return [...local, far];
		},
	});

	const notices: string[] = [];
	const ctx: any = {
		hasUI: true,
		cwd: "/work",
		model: { id: "m", provider: "p", contextWindow: 100_000 },
		getContextUsage: () => ({ tokens: 10_000 }),
		sessionManager: { getSessionFile: () => "/sessions/me.jsonl" },
		modelRegistry: { getAll: () => [], getApiKeyAndHeaders: async () => ({ ok: false, error: "no key" }) },
		signal: undefined,
		ui: {
			addAutocompleteProvider: () => {},
			confirm: async () => true,
			notify: (m: string) => notices.push(m),
		},
	};
	const input = hooks.get("input")!;
	await hooks.get("session_start")!({}, ctx);

	// The oldest of twenty same-named sessions: past maxPickerRows, and its name
	// is ambiguous. Only the id can answer.
	const oldest = local[0];
	const out = await input({ text: `like ##[dup·${oldest.id.slice(0, 8)}]` }, ctx);
	check("an id resolves past the picker cap and through a duplicate name", (out as any).action, "transform");
	check("and injects exactly that session", sent.length, 1);
	checkTrue("the right one", sent[0].m.content.includes(oldest.id.slice(0, 8)));

	// Another project's session: the old fallback only looked in cwd.
	const cross = await input({ text: `##[over there·${far.id.slice(0, 8)}]` }, ctx);
	check("an id reaches another project", (cross as any).action, "transform");
	check("two references now", sent.length, 2);

	// A name that matches twenty rows is still refused rather than guessed.
	const ambiguous = await input({ text: "like #[dup] did" }, ctx);
	check("an ambiguous hand-typed name resolves to nothing", ambiguous, { action: "continue" });
	check("and injects nothing", sent.length, 2);

	// An id nobody has.
	const nobody = await input({ text: "##[dup·deadbeef]" }, ctx);
	check("an unknown id injects nothing", nobody, { action: "continue" });

	// Headless: the summary path used to make a billed model call with every
	// notice discarded.
	const before = sent.length;
	const headless = await input({ text: `#[dup·${oldest.id.slice(0, 8)}]` }, { ...ctx, hasUI: false });
	check("without a UI, no marker is acted on at all", headless, { action: "continue" });
	check("and nothing is injected", sent.length, before);

	// Listing is cached: the provider is on the typing hot path.
	const callsBefore = listCalls;
	await input({ text: `#[dup·${oldest.id.slice(0, 8)}]` }, ctx);
	await input({ text: `#[dup·${oldest.id.slice(0, 8)}]` }, ctx);
	checkTrue("repeated resolution reuses the cached listing", listCalls - callsBefore <= 1);
	rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
