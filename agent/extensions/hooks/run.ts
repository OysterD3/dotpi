/**
 * Running one handler: a process, an HTTP POST, or a model call. The only file
 * here that does I/O; output.ts reads what comes back.
 *
 * Commands use node:child_process directly rather than `pi.exec`, which was
 * checked and cannot do this job: it gives the child no stdin (the payload
 * arrives on stdin), takes no env (CLAUDE_PROJECT_DIR must be set), runs no
 * shell (command strings are shell lines), and reports a child killed by a
 * signal as exit code 0 — which for a hook is the difference between "blocked"
 * and "allowed".
 *
 * Each command runs as the leader of its own process group (`detached`), for
 * two reasons. A timeout must kill what the shell started, not just the shell,
 * or `sh -c 'sleep 999'` outlives its deadline. And a group leader has no
 * controlling terminal, which is how Claude Code runs hooks too — a hook that
 * opened /dev/tty would fight pi's TUI for the keyboard.
 */

import { spawn } from "node:child_process";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CAPTURE_BYTES, KILL_GRACE_MS, PROMPT_REASONING } from "./config.ts";
import { resolveModel } from "./model.ts";
import type { CommandHandler, HttpHandler, PromptHandler } from "./settings.ts";

export type ProcessRun = { code: number | null; stdout: string; stderr: string; timedOut: boolean; aborted: boolean; spawnError?: string };

export function runCommand(
	handler: CommandHandler,
	input: string,
	/** `timeoutMs` undefined: no deadline (an `async` hook), only `signal`. */
	options: { cwd: string; projectDir: string; timeoutMs: number | undefined; signal?: AbortSignal },
): Promise<ProcessRun> {
	return new Promise((resolve) => {
		const env = { ...process.env, CLAUDE_PROJECT_DIR: options.projectDir };
		// Exec form substitutes the placeholder as plain text, since there is no
		// shell to expand it; shell form gets it from the environment like any var.
		const substitute = (text: string) => text.split("${CLAUDE_PROJECT_DIR}").join(options.projectDir);
		let child: ReturnType<typeof spawn>;
		try {
			child = handler.args
				? spawn(substitute(handler.command), handler.args.map(substitute), { cwd: options.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
				: spawn("/bin/sh", ["-c", handler.command], { cwd: options.cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
		} catch (error) {
			resolve({ code: null, stdout: "", stderr: "", timedOut: false, aborted: false, spawnError: message(error) });
			return;
		}

		const stdout = new Capture();
		const stderr = new Capture();
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let exitCode: number | null = null;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let drainTimer: ReturnType<typeof setTimeout> | undefined;

		const kill = () => {
			if (child.pid === undefined) return;
			signalGroup(child.pid, "SIGTERM");
			killTimer = setTimeout(() => signalGroup(child.pid as number, "SIGKILL"), KILL_GRACE_MS);
			killTimer.unref();
		};

		const deadline =
			options.timeoutMs === undefined
				? undefined
				: setTimeout(() => {
						timedOut = true;
						kill();
					}, options.timeoutMs);

		const onAbort = () => {
			aborted = true;
			kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) onAbort();

		const finish = (spawnError?: string) => {
			if (settled) return;
			settled = true;
			if (deadline !== undefined) clearTimeout(deadline);
			if (drainTimer !== undefined) clearTimeout(drainTimer);
			// A helper the hook left behind may still hold these pipes open; they
			// must not hold pi's event loop too, or `pi -p` waits for the helper.
			for (const stream of [child.stdout, child.stderr]) (stream as { unref?: () => void } | null)?.unref?.();
			options.signal?.removeEventListener("abort", onAbort);
			resolve({ code: exitCode, stdout: stdout.text(), stderr: stderr.text(), timedOut, aborted, spawnError });
		};

		child.stdout?.on("data", (chunk: Buffer) => stdout.add(chunk));
		child.stderr?.on("data", (chunk: Buffer) => stderr.add(chunk));
		child.on("error", (error) => finish(message(error)));
		// "close" waits for the pipes, and a hook that backgrounds a helper
		// (`notify-send … &`) hands that helper its stdout — so the pipes can
		// stay open long after the hook itself has answered. The exit is what
		// counts; the drain window only collects output already in flight.
		child.on("exit", (code) => {
			exitCode = code;
			drainTimer = setTimeout(() => finish(), 200);
		});
		child.on("close", () => finish());

		child.stdin?.on("error", () => {}); // a hook that never reads stdin must not EPIPE us
		child.stdin?.end(input);
	});
}

/** Signal a whole process group; the group may already be gone. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pid, signal);
	} catch {
		/* already exited */
	}
}

/** Bounded output buffer: a hook that prints forever cannot take pi's memory with it. */
class Capture {
	private chunks: Buffer[] = [];
	private size = 0;
	add(chunk: Buffer): void {
		if (this.size >= CAPTURE_BYTES) return;
		const kept = chunk.subarray(0, CAPTURE_BYTES - this.size);
		this.chunks.push(kept);
		this.size += kept.length;
	}
	text(): string {
		return Buffer.concat(this.chunks).toString("utf8");
	}
}

export type HttpRun = { status?: number; body?: string; error?: string; timedOut?: boolean };

/**
 * POST the payload. Header values may name environment variables as `$NAME` or
 * `${NAME}`, but only ones listed in `allowedEnvVars`; any other reference
 * becomes an empty string, so a header cannot be used to walk secrets out of
 * the environment to a URL nobody vetted.
 */
export async function runHttp(handler: HttpHandler, body: string, timeoutMs: number, signal?: AbortSignal): Promise<HttpRun> {
	const allowed = new Set(handler.allowedEnvVars);
	const headers: Record<string, string> = { "content-type": "application/json" };
	for (const [name, value] of Object.entries(handler.headers)) {
		headers[name] = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (_whole, braced: string, bare: string) => {
			const variable = braced ?? bare;
			return allowed.has(variable) ? (process.env[variable] ?? "") : "";
		});
	}
	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await fetch(handler.url, {
			method: "POST",
			headers,
			body,
			signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
		});
		return { status: response.status, body: await readCapped(response) };
	} catch (error) {
		if (timeout.aborted) return { timedOut: true };
		return { error: message(error) };
	}
}

/** The body, up to CAPTURE_BYTES — the same bound a command's output gets. */
async function readCapped(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const capture = new Capture();
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		capture.add(Buffer.from(value));
		size += value.length;
		if (size >= CAPTURE_BYTES) {
			await reader.cancel();
			break;
		}
	}
	return capture.text();
}

/** Tokens and cost from one prompt-hook call, for the `usage:spend` channel. */
export type Spend = { input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number; cost: number };

const SYSTEM = [
	"You are a hook in a coding agent. You are shown one lifecycle event as JSON and judge it against the instruction you are given.",
	'Answer with one JSON object and nothing else: {"ok": true} to let it go ahead, or {"ok": false, "reason": "..."} to stop it.',
	"When ok is false, reason is required: write it as an instruction the agent can act on.",
	'On a Stop event, add "impossible": true when the condition can never be met, so the agent may stop instead of trying forever.',
].join("\n");

/**
 * Ask a model, through the session's model registry rather than pi-ai's global
 * `completeSimple`. The registry is pi's documented route for a nested call: it
 * resolves the credentials and reaches providers an extension registered, which
 * the global function cannot see — checked: it throws "No API provider
 * registered" for one. A provider rejection is a resolved message with
 * `stopReason: "error"`, not an exception, so both paths are read off the value.
 */
export async function runPrompt(
	ctx: ExtensionContext,
	handler: PromptHandler,
	text: string,
	timeoutMs: number,
	signal: AbortSignal | undefined,
	onSpend: (spend: Spend) => void,
): Promise<{ text?: string; error?: string }> {
	let model = ctx.model;
	if (handler.model) {
		const resolved = resolveModel(handler.model, ctx.modelRegistry.getAll());
		if (!resolved.ok) return { error: resolved.error };
		model = resolved.model;
	}
	if (!model) return { error: "no model selected" };

	const timeout = AbortSignal.timeout(timeoutMs);
	try {
		const response = await ctx.modelRegistry
			.streamSimple(
				model,
				{ systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] },
				{ signal: signal ? AbortSignal.any([signal, timeout]) : timeout, timeoutMs, reasoning: PROMPT_REASONING },
			)
			.result();
		onSpend({
			input: response.usage?.input ?? 0,
			output: response.usage?.output ?? 0,
			cacheRead: response.usage?.cacheRead ?? 0,
			cacheWrite: response.usage?.cacheWrite ?? 0,
			reasoning: response.usage?.reasoning ?? 0,
			cost: response.usage?.cost?.total ?? 0,
		});
		if (timeout.aborted) return { error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
		if (response.stopReason === "aborted" || signal?.aborted) return { error: "interrupted" };
		if (response.stopReason === "error") return { error: response.errorMessage?.trim() || "model call failed" };
		return {
			text: response.content
				.filter((block): block is { type: "text"; text: string } => block.type === "text")
				.map((block) => block.text)
				.join("\n"),
		};
	} catch (error) {
		if (timeout.aborted) return { error: `timed out after ${Math.round(timeoutMs / 1000)}s` };
		return { error: signal?.aborted ? "interrupted" : message(error) };
	}
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
