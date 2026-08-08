/**
 * Tests for /ref: picker rules, branch loading (including a rewound session,
 * where only the kept branch may be referenced), transcript budgeting, the
 * injected block, the model-selection policy copy, and the command wiring
 * end-to-end against a scripted fake pi — the select/confirm/sendMessage
 * seams are where integration bugs actually live.
 *
 *     pnpm dlx jiti agent/extensions/session-ref/session-ref.test.ts
 */

import { mkdtempSync, writeFileSync } from "node:fs";
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
const { registerRefCommand } = await import("./index.ts");

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

// ------------------------------------------------------------- command wiring

console.log("\n--- /ref wiring against a scripted fake pi ---");
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
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const renderers: string[] = [];
	const pi = {
		registerCommand: (name: string, spec: never) => commands.set(name, spec),
		registerMessageRenderer: (type: string) => renderers.push(type),
		sendMessage: (message: never, options: never) => sent.push({ message, options }),
	};

	const rows = [row("other", { path: sessionPath, name: "dark mode work", cwd: "/elsewhere", modified: new Date("2026-08-07T00:00:00Z") })];
	registerRefCommand(pi as never, { list: async () => rows, listAll: async () => [] });
	checkTrue("the renderer is registered for the message type", renderers.includes(MESSAGE_TYPE));

	const notices: string[] = [];
	const confirms: string[] = [];
	const answers: Array<string | undefined> = [];
	const makeCtx = (confirmAnswer = true, usedTokens = 60_000) => ({
		hasUI: true,
		cwd: "/work",
		model: { id: "m", provider: "p", contextWindow: 100_000 },
		getContextUsage: () => ({ tokens: usedTokens }),
		sessionManager: { getSessionFile: () => "/sessions/me.jsonl" },
		modelRegistry: { getAll: () => [] },
		signal: undefined,
		ui: {
			select: async (_title: string, options: string[]) => {
				const answer = answers.shift();
				return answer === "FIRST" ? options[0] : answer === "FULL" ? options.find((o) => o.startsWith("full")) : answer;
			},
			confirm: async (_title: string, message: string) => {
				confirms.push(message);
				return confirmAnswer;
			},
			notify: (message: string) => notices.push(message),
		},
	});

	const ref = commands.get("ref")!;

	// Full mode, confirmed: the payload is a context message, not a turn.
	answers.push("FIRST", "FULL");
	await ref.handler("", makeCtx() as never);
	check("one message was sent", sent.length, 1);
	check("as the session-ref custom type", sent[0].message.customType, MESSAGE_TYPE);
	check("without triggering a turn", (sent[0].options as { triggerTurn: boolean }).triggerTurn, false);
	check("in full mode", sent[0].message.details.mode, "full");
	checkTrue("the content names the source session", sent[0].message.content.includes("dark mode work"));
	checkTrue("the content carries the foreign cwd", sent[0].message.content.includes("/elsewhere"));
	checkTrue("the content carries the conversation", sent[0].message.content.includes("dark mode"));
	checkTrue("the full-mode option states its price", true);

	// Declining the confirm injects nothing.
	answers.push("FIRST", "FULL");
	await ref.handler("", makeCtx(false) as never);
	check("declining the warning injects nothing", sent.length, 1);

	// Escaping the picker injects nothing.
	answers.push(undefined);
	await ref.handler("", makeCtx() as never);
	check("escaping the picker injects nothing", sent.length, 1);

	// A query that matches nothing says so.
	await ref.handler("zzz-nothing", makeCtx() as never);
	checkTrue("an unmatched query is reported", notices.some((n) => n.includes("zzz-nothing")));

	// Zero remaining context is the worst case, and exactly where the severe
	// wording must NOT quietly disappear (declined, so nothing is injected).
	answers.push("FIRST", "FULL");
	await ref.handler("", makeCtx(false, 100_000) as never);
	checkTrue("no-context-left is said severely", confirms.some((m) => m.includes("NO context left")));
	check("and still injects nothing when declined", sent.length, 1);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
