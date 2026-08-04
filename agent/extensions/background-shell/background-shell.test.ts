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
 * real store or settings.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const {
	appendOutput,
	ensureStore,
	isSettled,
	listShells,
	newShellId,
	pruneShells,
	readMeta,
	readOutputFrom,
	reconcile,
	tailOutput,
	writeMeta,
} = await import("./store.ts");
const { killJob, resolveShell, ShellRegistry, startShell } = await import("./shells.ts");
const { commandLabel, exitReport, footerLines, interruptedNotice, runningReminder, statusLabel } = await import("./render.ts");
const { ShellsPanel } = await import("./tui.ts");
const { CONFIG, RESULT_MESSAGE } = await import("./config.ts");
import type { ShellMeta } from "./store.ts";
import type { ShellJob } from "./shells.ts";

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
		ownerPid: process.pid,
		status: "running",
		startedAt: Date.now(),
		...overrides,
	};
}

const until = async (label: string, condition: () => boolean, timeoutMs = 8000) => {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
};

ensureStore(AGENT);

console.log("--- store ---");
{
	const a = newShellId(1000);
	const b = newShellId(1000);
	check("ids are unique for the same instant", a === b, false);
	check("id shape includes the pid", /^sh-[a-z0-9]{9}-[a-z0-9]+-\d+$/.test(a), true);
	check("id carries this process's pid", a.includes(`-${process.pid.toString(36)}-`), true);

	const m = meta({ command: "printf hi" });
	writeMeta(AGENT, m);
	check("meta roundtrip", readMeta(AGENT, m.shellId)?.command, "printf hi");

	const older = meta({ startedAt: 1 });
	writeMeta(AGENT, older);
	check("listShells newest first", listShells(AGENT).at(-1)?.shellId, older.shellId);

	// A running shell whose owner pid is dead is reconciled to interrupted; a
	// live owner (this process) is left alone.
	const dead = meta({ ownerPid: 2 ** 30 + 7, command: "npm run dev" });
	writeMeta(AGENT, dead);
	const marked = reconcile(AGENT);
	check("reconcile marks dead-owner shells", marked.map((r) => r.shellId), [dead.shellId]);
	check("reconcile persisted the status", readMeta(AGENT, dead.shellId)?.status, "interrupted");
	check("live-owner shell untouched", readMeta(AGENT, m.shellId)?.status, "running");

	// Cursor reads: from 0, then from the cursor, then nothing new.
	const out = meta({});
	writeMeta(AGENT, out);
	appendOutput(AGENT, out.shellId, "hello\n");
	const first = readOutputFrom(AGENT, out.shellId, 0, 1024);
	check("first read sees everything", first.text, "hello\n");
	appendOutput(AGENT, out.shellId, "world\n");
	const second = readOutputFrom(AGENT, out.shellId, first.nextOffset, 1024);
	check("second read sees only the new part", second.text, "world\n");
	check("nothing new means empty, cursor stays", readOutputFrom(AGENT, out.shellId, second.nextOffset, 1024), {
		text: "",
		nextOffset: second.nextOffset,
		skipped: 0,
	});

	// Firehose: more unread than the cap skips ahead, tail-biased.
	const hose = meta({});
	writeMeta(AGENT, hose);
	appendOutput(AGENT, hose.shellId, "x".repeat(90) + "END");
	const capped = readOutputFrom(AGENT, hose.shellId, 0, 10);
	check("cap keeps the tail", capped.text, "xxxxxxxEND");
	check("cap reports the skip", capped.skipped, 83);

	// Tail drops the torn first line when the window starts mid-file.
	const tailMeta = meta({});
	writeMeta(AGENT, tailMeta);
	appendOutput(AGENT, tailMeta.shellId, "one\ntwo\nthree\n");
	check("tail within window keeps all lines", tailOutput(AGENT, tailMeta.shellId, 1024), ["one", "two", "three"]);
	check("tail drops the torn first line", tailOutput(AGENT, tailMeta.shellId, 10), ["three"]);

	// …but a single line bigger than the whole window is kept, marked torn,
	// instead of reading as "no output".
	const bigLine = meta({});
	writeMeta(AGENT, bigLine);
	appendOutput(AGENT, bigLine.shellId, "y".repeat(20));
	check("oversized single line survives as a torn fragment", tailOutput(AGENT, bigLine.shellId, 10), [`…${"y".repeat(10)}`]);

	// Raw terminal traffic is sanitized: ANSI stripped, CR frames become lines.
	const noisy = meta({});
	writeMeta(AGENT, noisy);
	appendOutput(AGENT, noisy.shellId, "\u001B[31mred\u001B[0m\rprog 50%\rprog 100%\n\u001B[2K\u001B[1Adone\n");
	check("ansi stripped and CR treated as line breaks", tailOutput(AGENT, noisy.shellId, 1024), ["red", "prog 50%", "prog 100%", "done"]);

	// Prune drops settled shells beyond the keep count, never running ones.
	const settled = meta({ status: "done", startedAt: 2 });
	writeMeta(AGENT, settled);
	pruneShells(AGENT, 0);
	check("prune drops settled", readMeta(AGENT, settled.shellId), undefined);
	check("prune keeps running", readMeta(AGENT, m.shellId)?.shellId, m.shellId);
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

	// A live "orphan" (this process's pid) gets its pid surfaced; a dead one does not.
	const orphan = meta({ status: "interrupted", pid: process.pid, command: "vite" });
	check("interruptedNotice names a live orphan pid", interruptedNotice([orphan])!.includes(`pid ${process.pid}`), true);
	const gone = meta({ status: "interrupted", pid: 2 ** 30 + 9 });
	check("interruptedNotice stays quiet about dead pids", interruptedNotice([gone])!.includes("STILL"), false);
}

console.log("--- shells (real processes) ---");
{
	check("resolveShell honours an explicit path", resolveShell("/bin/zsh"), { shell: "/bin/zsh", args: ["-c"] });

	// A short command runs to completion, output lands in the log.
	const ok = meta({ command: "printf hi" });
	const okJob = startShell({ agentDir: AGENT, meta: ok, config: {}, onExit: () => {} });
	await okJob.settled;
	check("done status and exit code", [ok.status, ok.exitCode], ["done", 0]);
	check("output captured", tailOutput(AGENT, ok.shellId, 1024), ["hi"]);

	// Non-zero exit is failed, and onExit fires exactly once.
	let exits = 0;
	const bad = meta({ command: "exit 3" });
	const badJob = startShell({ agentDir: AGENT, meta: bad, config: {}, onExit: () => exits++ });
	await badJob.settled;
	check("failed status and exit code", [bad.status, bad.exitCode], ["failed", 3]);
	check("onExit fired once", exits, 1);

	// A spawn that cannot start still settles as failed.
	const noShell = meta({ command: "true" });
	const noShellJob = startShell({ agentDir: AGENT, meta: noShell, config: { shellPath: join(ROOT, "missing-shell") }, onExit: () => {} });
	await noShellJob.settled;
	check("unspawnable shell settles as failed", [noShell.status, noShell.exitCode], ["failed", null]);

	// Kill takes down the whole process group — the compound command's sleep
	// would otherwise hold the pipes open and settled would never resolve.
	const long = meta({ command: "sleep 30 | cat" });
	const longJob = startShell({ agentDir: AGENT, meta: long, config: {}, onExit: () => {} });
	killJob(longJob, "panel");
	await longJob.settled;
	check("killed status, signal exit, blame recorded", [long.status, long.exitCode, longJob.killedBy], ["killed", null, "panel"]);

	// The timeout parameter kills and marks timedOut.
	const slow = meta({ command: "sleep 30" });
	const slowJob = startShell({ agentDir: AGENT, meta: slow, config: {}, timeoutSeconds: 1, onExit: () => {} });
	await slowJob.settled;
	check("timeout kills and marks", [slow.status, slow.timedOut, slowJob.killedBy], ["killed", true, "timeout"]);

	// The SIGKILL rung must fire even though sh (the group leader) dies of the
	// SIGTERM — the trap'd loop survives it and would hold the pipes forever.
	const stubborn = meta({ command: "trap '' TERM; while :; do sleep 1; done" });
	const stubbornJob = startShell({ agentDir: AGENT, meta: stubborn, config: {}, onExit: () => {} });
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

	// bash_output drains, then reports nothing new; unknown ids name the known ones.
	const out1 = await tools.get("bash_output").execute("t3", { shell_id: shellId }, undefined, undefined, ctx);
	check("bash_output returns the output", out1.content[0].text.includes("bg-ran"), true);
	const out2 = await tools.get("bash_output").execute("t4", { shell_id: shellId }, undefined, undefined, ctx);
	check("bash_output then reports no new output", out2.content[0].text.includes("(no new output)"), true);
	check("bash_output reports the exit", out2.content[0].text.includes("exited with code 0"), true);
	const unknown = await tools.get("bash_output").execute("t5", { shell_id: "sh-nope-1" }, undefined, undefined, ctx).then(
		() => "resolved",
		(error: Error) => error.message,
	);
	check("unknown id errors and names known shells", (unknown as string).includes(shellId), true);
	const badFilter = await tools.get("bash_output").execute("t6", { shell_id: shellId, filter: "(" }, undefined, undefined, ctx).then(
		() => "resolved",
		(error: Error) => error.message.startsWith("Invalid filter regex"),
	);
	check("invalid filter regex errors", badFilter, true);

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

	// A filter never judges a torn trailing fragment: the cursor holds it back
	// until the line is complete.
	const filtered = await tools.get("bash").execute("tf", { command: "sleep 30", run_in_background: true }, undefined, undefined, ctx);
	const filteredId = filtered.details.shellId;
	appendOutput(AGENT, filteredId, "hello par");
	const partial = await tools.get("bash_output").execute("tf1", { shell_id: filteredId, filter: "hello" }, undefined, undefined, ctx);
	check("torn fragment is not judged by the filter", partial.content[0].text.includes("(no new output)"), true);
	appendOutput(AGENT, filteredId, "tial match\nnoise\n");
	const complete = await tools.get("bash_output").execute("tf2", { shell_id: filteredId, filter: "hello" }, undefined, undefined, ctx);
	check("reassembled line matches the filter whole", complete.content[0].text.includes("hello partial match"), true);
	check("non-matching lines are filtered out", complete.content[0].text.includes("noise"), false);
	await tools.get("kill_shell").execute("tf3", { shell_id: filteredId }, undefined, undefined, ctx);

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

	// Shutdown kills what is left, clears the footer, and stays quiet about it.
	const sentBeforeShutdown = sent.length;
	for (const handler of events.get("session_shutdown") ?? []) handler({}, ctx);
	const clearing = emitted.filter((e) => e.channel === "background-shell:lines").at(-1);
	check("shutdown clears the footer lines", clearing?.data, { lines: undefined });
	await new Promise((resolve) => setTimeout(resolve, 300));
	check("shutdown exits are not delivered", sent.length, sentBeforeShutdown);
	check("shutdown empties the registry view", events.get("before_agent_start")![0]!({}, ctx), undefined);
	void bg3;

	// The interrupted notice is owed to the OWNING project and delivered
	// exactly once: another cwd's session start must not consume it, and the
	// `reported` flag persists the handover.
	const orphan = meta({ ownerPid: 2 ** 30 + 21, command: "vite dev", cwd: ROOT });
	writeMeta(AGENT, orphan);
	const otherCtx = { ...ctx, cwd: join(ROOT, "elsewhere") };
	for (const handler of events.get("session_start") ?? []) handler({}, otherCtx);
	check("another project's session does not consume the notice", events.get("before_agent_start")![0]!({}, otherCtx), undefined);
	for (const handler of events.get("session_start") ?? []) handler({}, ctx);
	const notice = events.get("before_agent_start")![0]!({}, ctx);
	check("owning project gets the interrupted notice", notice.message.content.includes(orphan.shellId), true);
	check("notice is hidden from the UI", notice.message.display, false);
	for (const handler of events.get("session_start") ?? []) handler({}, ctx);
	check("notice is delivered exactly once", events.get("before_agent_start")![0]!({}, ctx), undefined);
	check("handover persisted on the record", readMeta(AGENT, orphan.shellId)?.reported, true);
}

console.log("--- panel ---");
{
	const registry = new ShellRegistry();
	const running = meta({ command: "npm run dev", startedAt: Date.now() - 5000 });
	writeMeta(AGENT, running);
	appendOutput(AGENT, running.shellId, "line one\nline two\n");
	const job: ShellJob = { meta: running, child: undefined, readOffset: 0, settled: Promise.resolve() };
	registry.add(job);

	const killedIds: string[] = [];
	const host = {
		agentDir: AGENT,
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
	check("c kills the selected shell", killedIds, [running.shellId]);

	panel.handleInput("l");
	const detail = panel.render(80);
	check("detail shows the output tail", detail.some((line) => line.includes("line two")), true);

	// Wide enough that the temp dir's long path is not width-clipped.
	panel.handleInput("e");
	check("e surfaces the output path", panel.render(300).some((line) => line.includes(running.shellId)), true);

	panel.handleInput("q");
	check("q closes", closed, 1);
	panel.dispose();

	// Empty registry renders the how-to hint instead of a blank hole.
	const emptyPanel = new ShellsPanel({ ...host, registry: { all: () => [], get: () => undefined, running: () => [], kill: () => "unknown" } } as never, theme as never, () => {});
	check("empty state explains itself", emptyPanel.render(80).some((line) => line.includes("run_in_background")), true);
	emptyPanel.dispose();

	// A list longer than the screen keeps the caret and both "more" markers
	// inside the height budget — nothing is sliced off the bottom.
	const crowd = new ShellRegistry();
	for (let i = 0; i < 30; i++) {
		const m = meta({ command: `job-${i}`, startedAt: 1000 + i });
		crowd.add({ meta: m, child: undefined, readOffset: 0, settled: Promise.resolve() });
	}
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
	tiny.handleInput("e");
	check("q close survives a tiny terminal with a status up", tiny.render(120).some((line) => line.includes("q close")), true);
	tiny.dispose();
}

rmSync(ROOT, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
if (failures > 0) process.exitCode = 1;
