/**
 * Unit and wiring coverage for the background-shell extension.
 *
 * Run from ~/.pi (so @earendil-works packages resolve):
 *
 *   node --preserve-symlinks --experimental-transform-types agent/extensions/background-shell/background-shell.test.ts
 *
 * --preserve-symlinks matters: ~/.pi/node_modules was populated by bun, which
 * symlinks each package's dist into its cache — realpath'd module URLs land in
 * the cache where the package's own dependencies (chalk, …) do not resolve.
 * (This is also why elapsed.test.ts and goal.test.ts currently fail under
 * their documented runners: anything importing the pi-coding-agent package
 * root needs this flag now.)
 *
 * Real processes are spawned (printf, sleep) — every one is short-lived or
 * killed by the test itself. The agent dir is redirected to a temp directory
 * BEFORE pi is imported, with a refuse-to-run guard, so nothing touches the
 * real settings — and the last check in this file asserts the extension left
 * nothing behind in it, which is the property the whole design turns on.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "background-shell-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { OutputBuffer } = await import("./output.ts");
const { isSettled, killJob, newShellId, resolveShell, ShellRegistry, startShell } = await import("./shells.ts");
const { commandLabel, exitReport, footerLines, runningReminder, statusLabel } = await import("./render.ts");
const { registerShellTools } = await import("./tools.ts");
const { ShellsPanel, showShells } = await import("./tui.ts");
const { CONFIG, RESULT_MESSAGE } = await import("./config.ts");
import type { ShellJob, ShellMeta } from "./shells.ts";

/** The ESC byte, built rather than escaped: source escapes do not survive this file's tooling. */
const ESC = String.fromCharCode(0x1b);

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}

function meta(overrides: Partial<ShellMeta>): ShellMeta {
	return {
		shellId: newShellId(),
		command: "true",
		cwd: ROOT,
		pid: undefined,
		status: "running",
		startedAt: Date.now(),
		...overrides,
	};
}

/** A job with no child behind it — everything but the process is real. */
function job(shellMeta: ShellMeta, capacity: number = CONFIG.bufferBytes): ShellJob {
	return { meta: shellMeta, child: undefined, output: new OutputBuffer(capacity), readOffset: 0, settled: Promise.resolve() };
}

const until = async (label: string, condition: () => boolean, timeoutMs = 8000) => {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

console.log("--- ids ---");
{
	const a = newShellId(1000);
	const b = newShellId(1000);
	check("ids are unique for the same instant", a === b, false);
	check("id shape includes the pid", /^sh-[a-z0-9]{9}-[a-z0-9]+-\d+$/.test(a), true);
	check("id carries this process's pid", a.includes(`-${process.pid.toString(36)}-`), true);
}

console.log("--- output buffer ---");
{
	// Cursor reads: from 0, then from the cursor, then nothing new.
	const out = new OutputBuffer(1024);
	out.append("hello\n");
	const first = out.read(0, 1024);
	check("first read sees everything", first.text, "hello\n");
	out.append("world\n");
	const second = out.read(first.nextOffset, 1024);
	check("second read sees only the new part", second.text, "world\n");
	check("nothing new means empty, cursor stays", out.read(second.nextOffset, 1024), {
		text: "",
		nextOffset: second.nextOffset,
		skipped: 0,
		lastLineStart: second.nextOffset,
	});
	check("lastLineStart is byte-exact after a newline", second.lastLineStart, second.nextOffset);
	check("size is every byte ever written", out.size, 12);

	// A torn multibyte character must not distort the rewind target:
	// lastLineStart is computed from BYTES, where the decoded fragment lies.
	const torn = new OutputBuffer(1024);
	torn.append(Buffer.from([0x63, 0x61, 0x66, 0xc3]));
	const tornRead = torn.read(0, 1024);
	check("torn multibyte line starts at byte 0", tornRead.lastLineStart, 0);
	check("torn read decodes with a replacement char", tornRead.text.length, 4);

	// Firehose: more unread than the cap skips ahead, tail-biased.
	const hose = new OutputBuffer(1024);
	hose.append("x".repeat(90) + "END");
	const capped = hose.read(0, 10);
	check("cap keeps the tail", capped.text, "xxxxxxxEND");
	check("cap reports the skip", capped.skipped, 83);

	// Beyond the ring's capacity the oldest bytes are gone — and a cursor
	// pointing into them reads on from the oldest survivor, saying how much it
	// missed rather than silently resuming mid-stream.
	const ring = new OutputBuffer(8);
	ring.append("0123456789");
	ring.append("abcdef");
	check("ring holds only its capacity", ring.read(0, 1024).text, "6789abcdef".slice(-8));
	check("ring reports evicted bytes as skipped", ring.read(0, 1024).skipped, 8);
	check("ring keeps the absolute cursor space", ring.read(0, 1024).nextOffset, 16);
	check("a cursor inside the ring still reads only what is new", ring.read(14, 1024), {
		text: "ef",
		nextOffset: 16,
		skipped: 0,
		lastLineStart: 14,
	});
	// A single chunk bigger than the whole ring is trimmed by the same path.
	const flood = new OutputBuffer(4);
	flood.append("abcdefghij");
	check("an oversized chunk is trimmed to the ring", flood.read(0, 1024).text, "ghij");

	// Tail drops the torn first line when the window starts mid-stream.
	const lines = new OutputBuffer(1024);
	lines.append("one\ntwo\nthree\n");
	check("tail within window keeps all lines", lines.tail(1024), ["one", "two", "three"]);
	check("tail drops the torn first line", lines.tail(10), ["three"]);

	// …but a single line bigger than the whole window is kept, marked torn,
	// instead of reading as "no output".
	const bigLine = new OutputBuffer(1024);
	bigLine.append("y".repeat(20));
	check("oversized single line survives as a torn fragment", bigLine.tail(10), [`…${"y".repeat(10)}`]);
	check("an empty buffer tails as nothing", new OutputBuffer(1024).tail(1024), []);

	// Raw terminal traffic is sanitized: ANSI stripped, CR frames become lines.
	const noisy = new OutputBuffer(1024);
	noisy.append(`${ESC}[31mred${ESC}[0m\rprog 50%\rprog 100%\n${ESC}[2K${ESC}[1Adone\n`);
	check("ansi stripped and CR treated as line breaks", noisy.tail(1024), ["red", "prog 50%", "prog 100%", "done"]);

	// Colon-form SGR and <=>-parameter CSIs are legal and must strip whole,
	// not leave their bodies behind once the control-strip eats the ESC.
	const colon = new OutputBuffer(1024);
	colon.append(`${ESC}[38:5:196mcrimson${ESC}[0m\n${ESC}[<1;2;3Mmouse\n`);
	check("colon-form SGR strips whole", colon.tail(1024), ["crimson", "mouse"]);
}

console.log("--- render ---");
{
	check("commandLabel collapses whitespace", commandLabel("npm   run\n dev"), "npm run dev");
	check("commandLabel clips", commandLabel("a".repeat(60), 10), "aaaaaaaaa…");

	const now = 60_000;
	const running = meta({ command: "npm run dev", startedAt: 0 });
	check("statusLabel running", statusLabel(running, now), "running · 1m00s");
	const done = meta({ command: "ls", startedAt: 0, status: "done", exitCode: 0, endedAt: 30_000 });
	check("statusLabel done", statusLabel(done, now), "exited with code 0 · 30s");
	const killed = meta({ startedAt: 0, status: "killed", exitCode: null, endedAt: 1000, timedOut: true });
	check("statusLabel timeout", statusLabel(killed, now), "timed out and was killed · 1s");
	const unspawned = meta({ startedAt: 0, status: "failed", exitCode: null, endedAt: 0, pid: undefined });
	check("statusLabel spawn failure is not 'died on a signal'", statusLabel(unspawned, now), "failed to start · 0s");
	const signalled = meta({ startedAt: 0, status: "failed", exitCode: null, endedAt: 0, pid: 12345 });
	check("statusLabel signal death still reads as one", statusLabel(signalled, now), "died on a signal · 0s");

	check("footerLines empty means undefined", footerLines([], now), undefined);
	const five = [1, 2, 3, 4, 5].map((i) => meta({ command: `job-${i}`, startedAt: 0 }));
	const lines = footerLines(five, now)!;
	check("footerLines caps and counts the rest", [lines.length, lines.at(-1)], [4, "  +2 more shell(s)"]);

	const report = exitReport(done, ["out1", "out2"]);
	check("exitReport names the shell and shows the tail", [report.includes(done.shellId), report.includes("out2")], [true, true]);
	const panelKill = exitReport(killed, [], "panel");
	check("panel kill is attributed to the user", panelKill.startsWith("The user killed"), true);

	check("runningReminder empty", runningReminder([], now), undefined);
	check("runningReminder names shells", runningReminder([running], now)!.includes(running.shellId), true);
}

console.log("--- shells (real processes) ---");
{
	check("resolveShell honours an explicit path", resolveShell("/bin/zsh"), { shell: "/bin/zsh", args: ["-c"] });

	// A short command runs to completion, output lands in the buffer.
	const ok = meta({ command: "printf hi" });
	const okJob = startShell({ meta: ok, config: {}, onExit: () => {} });
	await okJob.settled;
	check("done status and exit code", [ok.status, ok.exitCode], ["done", 0]);
	check("output captured", okJob.output.tail(1024), ["hi"]);

	// Non-zero exit is failed, and onExit fires exactly once.
	let exits = 0;
	const bad = meta({ command: "exit 3" });
	const badJob = startShell({ meta: bad, config: {}, onExit: () => exits++ });
	await badJob.settled;
	check("failed status and exit code", [bad.status, bad.exitCode], ["failed", 3]);
	check("onExit fired once", exits, 1);

	// A spawn that cannot start still settles as failed, with the reason captured.
	const noShell = meta({ command: "true" });
	const noShellJob = startShell({ meta: noShell, config: { shellPath: join(ROOT, "missing-shell") }, onExit: () => {} });
	await noShellJob.settled;
	check("unspawnable shell settles as failed", [noShell.status, noShell.exitCode], ["failed", null]);
	check("spawn failure is captured as output", noShellJob.output.tail(1024).join(" ").includes("spawn failed"), true);

	// Kill takes down the whole process group — the compound command's sleep
	// would otherwise hold the pipes open and settled would never resolve.
	const long = meta({ command: "sleep 30 | cat" });
	const longJob = startShell({ meta: long, config: {}, onExit: () => {} });
	killJob(longJob, "panel");
	await longJob.settled;
	check("killed status, signal exit, blame recorded", [long.status, long.exitCode, longJob.killedBy], ["killed", null, "panel"]);

	// The timeout parameter kills and marks timedOut.
	const slow = meta({ command: "sleep 30" });
	const slowJob = startShell({ meta: slow, config: {}, timeoutSeconds: 1, onExit: () => {} });
	await slowJob.settled;
	check("timeout kills and marks", [slow.status, slow.timedOut, slowJob.killedBy], ["killed", true, "timeout"]);

	// The SIGKILL rung must fire even though sh (the group leader) dies of the
	// SIGTERM — the trap'd loop survives it and would hold the pipes forever.
	const stubborn = meta({ command: "trap '' TERM; while :; do sleep 1; done" });
	const stubbornJob = startShell({ meta: stubborn, config: {}, onExit: () => {} });
	await new Promise((resolve) => setTimeout(resolve, 100));
	const killedAt = Date.now();
	killJob(stubbornJob, "tool");
	await stubbornJob.settled;
	check("SIGKILL escalation reaps a TERM-trapping group", stubborn.status, "killed");
	check("escalation happened at the grace boundary, not before", Date.now() - killedAt >= CONFIG.killGraceMs, true);

	// Registry bookkeeping.
	const registry = new ShellRegistry();
	registry.add(okJob);
	registry.add(longJob);
	check("registry kill on settled job", registry.kill(long.shellId, "tool"), "not-running");
	check("registry kill on unknown id", registry.kill("sh-nope-1", "tool"), "unknown");
	check("running() excludes settled", registry.running(), []);

	// Retention: settled jobs hold their output ring, so the oldest are dropped
	// once the keep count is exceeded. Running shells are never dropped.
	const retained = new ShellRegistry(2);
	const alive = job(meta({ command: "npm run dev", startedAt: 1 }));
	retained.add(alive);
	const settledJobs = [2, 3, 4].map((i) => job(meta({ command: `job-${i}`, status: "done", startedAt: i })));
	for (const entry of settledJobs) retained.add(entry);
	check("retention drops the oldest settled job", retained.get(settledJobs[0]!.meta.shellId), undefined);
	check("retention keeps the newest settled ones", retained.all().length, 3);
	check("retention never drops a running shell", retained.get(alive.meta.shellId)?.meta.shellId, alive.meta.shellId);
	check("isSettled treats running as unsettled", [isSettled("running"), isSettled("killed")], [false, true]);
}

console.log("--- tools against an owned registry ---");
{
	// registerShellTools with a registry this block controls, so output can be
	// fed byte by byte: the cursor-rewind rules are about partial reads, which
	// a real pipe delivers only by luck.
	const registry = new ShellRegistry();
	const tools = new Map<string, any>();
	registerShellTools({ registerTool: (tool: any) => tools.set(tool.name, tool) } as never, {
		agentDir: AGENT,
		registry,
		shellConfig: () => ({}),
		builtinFor: () => ({}) as never,
		sessionId: () => "owned-session",
		onExit: () => {},
		onStarted: () => {},
	});
	const read = (id: string, filter?: string) =>
		tools.get("bash_output").execute("t", { shell_id: id, ...(filter ? { filter } : {}) }, undefined, undefined, {}).then((r: any) => r.content[0].text);

	// A filter never judges a torn trailing fragment: the cursor holds it back
	// until the line is complete.
	const live = job(meta({ command: "sleep 30" }));
	registry.add(live);
	live.output.append("hello par");
	check("torn fragment is not judged by the filter", (await read(live.meta.shellId, "hello")).includes("(no new output)"), true);
	live.output.append("tial match\nnoise\n");
	const complete = await read(live.meta.shellId, "hello");
	check("reassembled line matches the filter whole", complete.includes("hello partial match"), true);
	check("non-matching lines are filtered out", complete.includes("noise"), false);

	// A torn multibyte character must not push the cursor negative — the
	// rewind target comes from bytes, not from the decoded fragment.
	const mb = job(meta({ command: "sleep 30" }));
	registry.add(mb);
	mb.output.append(Buffer.from([0x63, 0x61, 0x66, 0xc3]));
	check("torn multibyte fragment is held back", (await read(mb.meta.shellId, "café")).includes("(no new output)"), true);
	mb.output.append(Buffer.from([0xa9, 0x0a]));
	check("reassembled multibyte line matches whole", (await read(mb.meta.shellId, "café")).includes("café"), true);

	// Output the ring has already evicted is reported, not silently skipped
	// over: the model is told how many bytes it will never see.
	const hose = job(meta({ command: "yes" }), 16);
	registry.add(hose);
	hose.output.append("x".repeat(100) + "\n");
	const drained = await read(hose.meta.shellId);
	check("evicted bytes are reported as a skip", drained.includes("[skipped 85 bytes"), true);
	check("and the tail itself still arrives", drained.trimEnd().endsWith("x".repeat(15)), true);

	// A shell the registry never knew (or has since dropped) is an error that
	// names what IS known, rather than a silent empty read.
	const unknown = await read("sh-nope-1").then(
		() => "resolved",
		(error: Error) => error.message,
	);
	check("unknown id errors and names known shells", (unknown as string).includes(live.meta.shellId), true);
	const badFilter = await read(live.meta.shellId, "(").then(
		() => "resolved",
		(error: Error) => error.message.startsWith("Invalid filter regex"),
	);
	check("invalid filter regex errors", badFilter, true);

	registry.killAll("shutdown");
}

console.log("--- wiring against a fake pi ---");
{
	writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ theme: "x" }), "utf8");

	const tools = new Map<string, any>();
	const events = new Map<string, Function[]>();
	const bus = new Map<string, Array<(data: unknown) => void>>();
	const emitted: Array<{ channel: string; data: unknown }> = [];
	const sent: Array<{ message: any; options: any }> = [];
	const shortcuts: string[] = [];
	const renderers: string[] = [];

	const pi = {
		on: (event: string, handler: Function) => {
			events.set(event, [...(events.get(event) ?? []), handler]);
		},
		registerTool: (tool: any) => tools.set(tool.name, tool),
		registerShortcut: (key: string) => shortcuts.push(key),
		registerMessageRenderer: (type: string) => renderers.push(type),
		sendMessage: (message: any, options: any) => sent.push({ message, options }),
		events: {
			emit: (channel: string, data: unknown) => {
				emitted.push({ channel, data });
				for (const handler of bus.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				bus.set(channel, [...(bus.get(channel) ?? []), handler]);
				return () => {};
			},
		},
	};

	const extension = (await import("./index.ts")).default;
	extension(pi as never);

	check("tools registered", [...tools.keys()].sort(), ["bash", "bash_output", "kill_shell"]);
	check("shift+up bound", shortcuts, ["shift+up"]);
	check("exit message renderer registered", renderers, [RESULT_MESSAGE]);
	check("bash keeps the built-in prompt snippet", typeof tools.get("bash").promptSnippet, "string");

	const ctx = {
		cwd: ROOT,
		hasUI: false,
		isIdle: () => true,
		model: undefined,
		thinkingLevel: undefined,
		sessionManager: {
			getSessionId: () => "test-session",
			getSessionFile: () => undefined,
		},
		ui: { notify: () => {} },
	};
	for (const handler of events.get("session_start") ?? []) handler({}, ctx);

	// Foreground path delegates to pi's real bash tool.
	const fg = await tools.get("bash").execute("t1", { command: "printf fg-ran" }, undefined, undefined, ctx);
	check("foreground delegation runs the command", fg.content[0].text.includes("fg-ran"), true);

	// Background path returns immediately with a shell id and delivers an exit
	// message once the process finishes — triggerTurn, since the fake ctx is idle.
	const bg = await tools.get("bash").execute("t2", { command: "printf bg-ran", run_in_background: true }, undefined, undefined, ctx);
	const shellId = bg.details.shellId;
	check("background result is immediate and flagged", [bg.details.background, typeof shellId], [true, "string"]);
	check("background result text promises the exit message", bg.content[0].text.includes(RESULT_MESSAGE), true);

	await until("exit delivery", () => sent.length > 0);
	check("exit message wakes the idle agent", [sent[0]!.message.customType, sent[0]!.options], [RESULT_MESSAGE, { triggerTurn: true }]);
	check("exit message carries the output tail", sent[0]!.message.content.includes("bg-ran"), true);

	// bash_output drains, then reports nothing new.
	const out1 = await tools.get("bash_output").execute("t3", { shell_id: shellId }, undefined, undefined, ctx);
	check("bash_output returns the output", out1.content[0].text.includes("bg-ran"), true);
	const out2 = await tools.get("bash_output").execute("t4", { shell_id: shellId }, undefined, undefined, ctx);
	check("bash_output then reports no new output", out2.content[0].text.includes("(no new output)"), true);
	check("bash_output reports the exit", out2.content[0].text.includes("exited with code 0"), true);

	// Oversized and nonsense timeouts are rejected up front — Node would clamp
	// the overflowing timer to 1ms and kill the shell instantly as "timed out".
	const hugeTimeout = await tools.get("bash").execute("tv", { command: "sleep 5", run_in_background: true, timeout: 1e12 }, undefined, undefined, ctx).then(
		() => "resolved",
		(error: Error) => error.message.startsWith("Invalid timeout: maximum"),
	);
	check("overflowing background timeout is rejected", hugeTimeout, true);
	const nanTimeout = await tools.get("bash").execute("tv2", { command: "sleep 5", run_in_background: true, timeout: Number.POSITIVE_INFINITY }, undefined, undefined, ctx).then(
		() => "resolved",
		(error: Error) => error.message.startsWith("Invalid timeout"),
	);
	check("non-finite background timeout is rejected", nanTimeout, true);

	// kill_shell reports the death itself, so no exit message follows it.
	const sentBefore = sent.length;
	const bg2 = await tools.get("bash").execute("t7", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
	const killed = await tools.get("kill_shell").execute("t8", { shell_id: bg2.details.shellId }, undefined, undefined, ctx);
	check("kill_shell reports the kill", killed.content[0].text.startsWith("Killed shell"), true);
	check("kill_shell result carries the status", killed.details.status, "killed");
	await new Promise((resolve) => setTimeout(resolve, 200));
	check("no duplicate exit message after kill_shell", sent.length, sentBefore);

	// The running reminder appears while a shell runs, and only then.
	const bg3 = await tools.get("bash").execute("t9", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
	const reminded = events.get("before_agent_start")![0]!({}, ctx);
	check("running reminder injected", reminded.message.content.includes("Background shells running"), true);
	check("reminder is hidden from the UI", reminded.message.display, false);

	// Shutdown kills what is left, clears the footer, and stays quiet about it.
	const sentBeforeShutdown = sent.length;
	for (const handler of events.get("session_shutdown") ?? []) handler({}, ctx);
	const clearing = emitted.filter((e) => e.channel === "background-shell:lines").at(-1);
	check("shutdown clears the footer lines", clearing?.data, { lines: undefined });
	await new Promise((resolve) => setTimeout(resolve, 300));
	check("shutdown exits are not delivered", sent.length, sentBeforeShutdown);
	check("shutdown empties the registry view", events.get("before_agent_start")![0]!({}, ctx), undefined);
	void bg3;

	// With the registry cleared there is nothing left that knows this shell —
	// a re-rendered transcript row has to say so rather than claim it just
	// "started", which is how a long-dead dev server would otherwise read.
	const idTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const historical = tools.get("bash").renderResult(
		{ content: [], details: { background: true, shellId: bg2.details.shellId, command: "sleep 30" } },
		{ expanded: false, isPartial: false },
		idTheme,
		{} as never,
	);
	check("an untracked row says so", historical.render(200).join(" ").includes("no longer tracked"), true);
	check("and does not claim it just started", historical.render(200).join(" ").includes("started"), false);
}

console.log("--- panel ---");
{
	const registry = new ShellRegistry();
	const running = job(meta({ command: "npm run dev", startedAt: Date.now() - 5000 }));
	running.output.append("line one\nline two\n");
	registry.add(running);

	const killedIds: string[] = [];
	const host = {
		registry: {
			all: () => registry.all(),
			get: (id: string) => registry.get(id),
			running: () => registry.running(),
			kill: (id: string) => {
				killedIds.push(id);
				return "killed";
			},
		},
		notify: () => {},
		requestRender: () => {},
		rows: () => 24,
	};
	const theme = { fg: (_c: string, text: string) => text, bold: (text: string) => text };
	let closed = 0;
	const panel = new ShellsPanel(host as never, theme as never, () => closed++);

	const lines = panel.render(40);
	check("render clamps every line to the width", lines.every((line) => line.length <= 40), true);
	check("list names the command", lines.some((line) => line.includes("npm run dev")), true);

	panel.handleInput("c");
	check("c kills the selected shell", killedIds, [running.meta.shellId]);

	panel.handleInput("l");
	const detail = panel.render(80);
	check("detail shows the output tail", detail.some((line) => line.includes("line two")), true);

	// The tail is cached on the buffer's byte count, so new output shows up.
	running.output.append("line three\n");
	check("detail follows new output", panel.render(80).some((line) => line.includes("line three")), true);

	panel.handleInput("q");
	check("q closes", closed, 1);
	panel.dispose();

	// Empty registry renders the how-to hint instead of a blank hole.
	const emptyPanel = new ShellsPanel({ ...host, registry: { all: () => [], get: () => undefined, running: () => [], kill: () => "unknown" } } as never, theme as never, () => {});
	check("empty state explains itself", emptyPanel.render(80).some((line) => line.includes("run_in_background")), true);
	emptyPanel.dispose();

	// A list longer than the screen keeps the caret and both "more" markers
	// inside the height budget — nothing is sliced off the bottom.
	const crowd = new ShellRegistry(30);
	for (let i = 0; i < 30; i++) crowd.add(job(meta({ command: `job-${i}`, startedAt: 1000 + i })));
	const crowded = new ShellsPanel({ ...host, registry: crowd } as never, theme as never, () => {});
	for (let i = 0; i < 15; i++) crowded.handleInput("j");
	const crowdedLines = crowded.render(80);
	const available = 24 - CONFIG.screenReserve - 3;
	check("crowded list stays within the frame", crowdedLines.length <= available + 3, true);
	check("caret survives the window clip", crowdedLines.some((line) => line.includes("❯")), true);
	check("both ends report what is hidden", [crowdedLines.some((l) => l.includes("↑")), crowdedLines.some((l) => l.includes("↓"))], [true, true]);
	crowded.dispose();

	// Scrolled detail view reserves a row for its marker.
	const scrollPanel = new ShellsPanel(host as never, theme as never, () => {});
	scrollPanel.handleInput("l");
	scrollPanel.handleInput("k");
	check("scroll marker shows when scrolled up", scrollPanel.render(80).some((line) => line.includes("G follows the tail")), true);
	// Scrolling far past the content clamps instead of blanking the view.
	for (let i = 0; i < 50; i++) scrollPanel.handleInput("k");
	check("over-scroll clamps and still shows content", scrollPanel.render(80).some((line) => line.includes("line one")), true);
	scrollPanel.dispose();

	// Height pressure never drops the way out: with a status line up on a tiny
	// terminal, "q close" shares the surviving row.
	const tiny = new ShellsPanel({ ...host, rows: () => 10 } as never, theme as never, () => {});
	tiny.handleInput("c");
	check("q close survives a tiny terminal with a status up", tiny.render(120).some((line) => line.includes("q close")), true);
	tiny.dispose();

	// An orphaned mount must neutralize its close: after onDetached, an
	// ask-user announcement may not resolve the dead mount's done() — that
	// would evict whatever component holds the editor slot now.
	{
		const bus = new Map<string, Array<(data: unknown) => void>>();
		const fakePi = {
			events: {
				emit: (channel: string, data: unknown) => {
					for (const handler of [...(bus.get(channel) ?? [])]) handler(data);
				},
				on: (channel: string, handler: (data: unknown) => void) => {
					bus.set(channel, [...(bus.get(channel) ?? []), handler]);
					return () => bus.set(channel, (bus.get(channel) ?? []).filter((h) => h !== handler));
				},
			},
		};
		let dones = 0;
		const mountCtx = () => {
			const slot: { panel?: any } = {};
			return {
				slot,
				ctx: {
					ui: {
						custom: (factory: any) => {
							slot.panel = factory({ requestRender() {}, terminal: { rows: 24 } }, theme, undefined, () => dones++);
							return new Promise(() => {});
						},
					},
				},
			};
		};

		const orphaned = mountCtx();
		void showShells(fakePi as never, orphaned.ctx as never, { registry: host.registry, notify: () => {} } as never);
		await new Promise((resolve) => setTimeout(resolve, 10));
		orphaned.slot.panel.host.onDetached();
		for (const handler of [...(bus.get("ask-user:asking") ?? [])]) handler({ active: true });
		check("orphaned panel never resolves its dead done", dones, 0);
		check("orphaned panel dropped its ask subscription", (bus.get("ask-user:asking") ?? []).length, 0);
		orphaned.slot.panel.dispose();

		// The ordinary path still closes for a question.
		const live = mountCtx();
		void showShells(fakePi as never, live.ctx as never, { registry: host.registry, notify: () => {} } as never);
		await new Promise((resolve) => setTimeout(resolve, 10));
		for (const handler of [...(bus.get("ask-user:asking") ?? [])]) handler({ active: true });
		check("a live panel still closes for a question", dones, 1);
		live.slot.panel.dispose();
	}
}

console.log("--- nothing on disk ---");
{
	// The property the whole design turns on: after spawning, killing, reading
	// and rendering dozens of shells, the agent dir holds only what the test
	// itself put there. No store, no logs, no leftovers to prune.
	check("no shell store was created", existsSync(join(AGENT, "background-shells")), false);
	check("the agent dir holds only the test's own settings", readdirSync(AGENT), ["settings.json"]);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
