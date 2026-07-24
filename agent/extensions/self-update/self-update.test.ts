/**
 * Tests for the self-update extension: the throttle, settings parsing, the
 * update flow against a scripted fake git (repo/no-repo, noop, updated, failed),
 * and the session_start gating against a fake pi.
 *
 * No real git, no network — `exec` is injected everywhere.
 *
 * Run: jiti agent/extensions/self-update/self-update.test.ts
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = mkdtempSync(join(tmpdir(), "selfupdate-test-"));
const AGENT = join(ROOT, "agent");
mkdirSync(AGENT, { recursive: true });
process.env.PI_CODING_AGENT_DIR = AGENT;

const { getAgentDir } = await import("@earendil-works/pi-coding-agent");
if (!getAgentDir().startsWith(ROOT)) {
	throw new Error(`REFUSING TO RUN: getAgentDir() is ${getAgentDir()}, outside ${ROOT}`);
}

const { isDue, readLastCheck, writeLastCheck } = await import("./state.ts");
const { runUpdate } = await import("./update.ts");
const { loadSettings } = await import("./index.ts");

let failures = 0;
function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `\n      got=${JSON.stringify(got)}\n     want=${JSON.stringify(want)}`}`);
}
function checkTrue(label: string, got: boolean) {
	check(label, got, true);
}

const HOUR = 3_600_000;

// ------------------------------------------------------------------ throttle

console.log("--- state: the throttle ---");
check("never checked -> due", isDue(1_000_000, 0, 6), true);
check("interval 0 -> always due", isDue(1_000_000, 999_000, 0), true);
check("within the interval -> not due", isDue(10 * HOUR, 6 * HOUR, 6), false);
check("past the interval -> due", isDue(10 * HOUR, 3 * HOUR, 6), true);
check("exactly at the interval -> due", isDue(7 * HOUR, 1 * HOUR, 6), true);

console.log("\n--- state: read/write round-trip ---");
check("no file -> 0", readLastCheck(AGENT), 0);
writeLastCheck(AGENT, 123456);
check("reads back what was written", readLastCheck(AGENT), 123456);
writeFileSync(join(AGENT, ".self-update.json"), "{ corrupt");
check("corrupt state -> 0", readLastCheck(AGENT), 0);
rmSync(join(AGENT, ".self-update.json"), { force: true });

// ------------------------------------------------------------------ settings

console.log("\n--- settings ---");
const writeSettings = (block: unknown) => writeFileSync(join(AGENT, "settings.json"), JSON.stringify({ selfUpdate: block }));
writeSettings({});
check("defaults", loadSettings(AGENT), { enabled: true, intervalHours: 6 });
writeSettings({ enabled: false, intervalHours: 24 });
check("overrides", loadSettings(AGENT), { enabled: false, intervalHours: 24 });
writeSettings({ intervalHours: -3 });
check("negative interval falls back", loadSettings(AGENT).intervalHours, 6);
writeSettings({ enabled: "yes" });
check("wrong-typed enabled falls back", loadSettings(AGENT).enabled, true);
writeFileSync(join(AGENT, "settings.json"), "{ not json");
check("unreadable settings fall back", loadSettings(AGENT), { enabled: true, intervalHours: 6 });

// ------------------------------------------------------------ the update flow

console.log("\n--- update: the flow against scripted git ---");
type Resp = { stdout?: string; stderr?: string; code?: number };
function makeExec(responder: (args: string[]) => Resp) {
	const calls: string[][] = [];
	const exec = async (_cmd: string, args: string[]) => {
		calls.push(args);
		const r = responder(args);
		return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.code ?? 0 };
	};
	return { exec, calls };
}
const arg = (args: string[], token: string) => args.includes(token);

{
	// Not a git repo: show-toplevel fails.
	const { exec, calls } = makeExec((a) => (arg(a, "--show-toplevel") ? { code: 128 } : {}));
	const notices: unknown[] = [];
	const outcome = await runUpdate(exec, AGENT, (m, l) => notices.push([l, m]), 1000);
	check("no repo -> not-repo", outcome.status, "not-repo");
	check("nothing pulled", calls.some((c) => arg(c, "pull")), false);
	check("silent", notices.length, 0);
}
{
	// Up to date: HEAD unchanged around a clean pull.
	const { exec } = makeExec((a) => {
		if (arg(a, "--show-toplevel")) return { stdout: "/repo" };
		if (arg(a, "HEAD")) return { stdout: "aaaaaaa" };
		return { code: 0 };
	});
	const notices: unknown[] = [];
	const outcome = await runUpdate(exec, AGENT, (m, l) => notices.push([l, m]), 1000);
	check("unchanged HEAD -> noop", outcome.status, "noop");
	check("no notification", notices.length, 0);
}
{
	// Updated: HEAD moves, two new commits.
	let headCalls = 0;
	const { exec, calls } = makeExec((a) => {
		if (arg(a, "--show-toplevel")) return { stdout: "/repo" };
		if (arg(a, "HEAD")) return { stdout: headCalls++ === 0 ? "aaaaaaa" : "bbbbbbb" };
		if (arg(a, "rev-list")) return { stdout: "2\n" };
		return { code: 0 };
	});
	const notices: Array<[string, string]> = [];
	const outcome = await runUpdate(exec, AGENT, (m, l) => notices.push([l, m]), 1000);
	check("moved HEAD -> updated", outcome.status, "updated");
	check("counts the new commits", outcome.newCommits, 2);
	checkTrue("notifies with the count", notices.some(([lvl, m]) => lvl === "info" && m.includes("2 new commits") && m.includes("/reload")));
	checkTrue("it did pull with rebase+autostash", calls.some((c) => arg(c, "pull") && arg(c, "--rebase") && arg(c, "--autostash")));
}
{
	// Failed pull: aborts the rebase, stays silent.
	const { exec, calls } = makeExec((a) => {
		if (arg(a, "--show-toplevel")) return { stdout: "/repo" };
		if (arg(a, "HEAD")) return { stdout: "aaaaaaa" };
		if (arg(a, "pull")) return { code: 1, stderr: "CONFLICT" };
		return { code: 0 };
	});
	const notices: unknown[] = [];
	const outcome = await runUpdate(exec, AGENT, (m, l) => notices.push([l, m]), 1000);
	check("failed pull -> failed", outcome.status, "failed");
	checkTrue("aborts the rebase to leave a clean tree", calls.some((c) => arg(c, "rebase") && arg(c, "--abort")));
	check("stays silent on failure", notices.length, 0);
}

// -------------------------------------------------- wiring: session_start gating

console.log("\n--- wiring: session_start gating ---");
const extension = (await import("./index.ts")).default;
const flush = () => new Promise((r) => setTimeout(r, 20));

function makePi() {
	let handler: Function | undefined;
	const calls: string[][] = [];
	const pi = {
		on: (event: string, h: Function) => {
			if (event === "session_start") handler = h;
		},
		exec: async (_cmd: string, args: string[]) => {
			calls.push(args);
			// A benign, up-to-date repo so runUpdate completes without notifying.
			if (arg(args, "--show-toplevel")) return { stdout: "/repo", stderr: "", code: 0 };
			if (arg(args, "HEAD")) return { stdout: "same", stderr: "", code: 0 };
			return { stdout: "", stderr: "", code: 0 };
		},
	};
	const notices: Array<[string, string]> = [];
	const ctx = { hasUI: true, ui: { notify: (m: string, l: string) => notices.push([l, m]) } };
	return { pi, calls, notices, ctx, fire: (c: any) => handler?.({}, c) };
}

{
	// Clean slate: due -> it pulls and stamps the timestamp.
	rmSync(join(AGENT, ".self-update.json"), { force: true });
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	h.fire(h.ctx);
	await flush();
	checkTrue("due -> git ran", h.calls.length > 0);
	checkTrue("timestamp was stamped", readLastCheck(AGENT) > 0);

	// Second start within the interval -> not due -> no new git calls.
	const before = h.calls.length;
	h.fire(h.ctx);
	await flush();
	check("not due -> no further git", h.calls.length, before);
}
{
	// hasUI false -> skip entirely.
	rmSync(join(AGENT, ".self-update.json"), { force: true });
	writeSettings({});
	const h = makePi();
	extension(h.pi as never);
	h.fire({ hasUI: false, ui: { notify: () => {} } });
	await flush();
	check("headless -> no git", h.calls.length, 0);
}
{
	// Disabled -> skip.
	rmSync(join(AGENT, ".self-update.json"), { force: true });
	writeSettings({ enabled: false });
	const h = makePi();
	extension(h.pi as never);
	h.fire(h.ctx);
	await flush();
	check("disabled -> no git", h.calls.length, 0);
}
{
	// No pi.exec -> no crash, no git.
	rmSync(join(AGENT, ".self-update.json"), { force: true });
	writeSettings({});
	let threw = false;
	const notices: unknown[] = [];
	const pi: any = { on: (e: string, hnd: Function) => (pi._h = e === "session_start" ? hnd : pi._h) };
	extension(pi);
	try {
		pi._h?.({}, { hasUI: true, ui: { notify: (m: string, l: string) => notices.push([l, m]) } });
		await flush();
	} catch {
		threw = true;
	}
	check("missing exec does not throw", threw, false);
}

rmSync(ROOT, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
