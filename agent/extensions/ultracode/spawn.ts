/**
 * Spawning one workflow subagent as a headless pi subprocess, following the
 * subagent example pi ships (examples/extensions/subagent): `pi --mode json -p`
 * with stdin ignored (an inherited stdin makes headless pi block reading it to
 * EOF), parsing the JSONL event stream for assistant message_end events,
 * SIGTERM-then-SIGKILL on abort.
 *
 * Subagents run with `--no-extensions --no-skills` so they get plain pi — in
 * particular they cannot recurse into the workflow tool. Project trust is
 * forwarded: `--approve` only when the parent session already trusts the
 * project.
 *
 * Sessions, unlike the first cut of this file, are KEPT: every agent runs with
 * `--session-dir <run>/agents --session-id <runId>-a<n>`, so it leaves a real
 * pi session behind. That is what makes a run debuggable after the fact (the
 * file renders with `pi --export`, tool calls and all) and it is where
 * context.ts puts forked context — pi reopens an existing session with that id
 * rather than creating one. Nothing lands in ~/.pi/agent/sessions; the run
 * directory owns it, and pruning the run takes the transcripts with it.
 *
 * Failures throw SubagentError carrying whatever usage the child accumulated
 * before dying, so a failed agent's spend still reaches the session totals.
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG } from "./config.ts";

export interface SpawnRequest {
	prompt: string;
	cwd: string;
	/** "provider/model-id" pattern for pi's --model flag; omit for pi's default. */
	model?: string;
	/** pi thinking level for --thinking; omit for pi's default. */
	thinking?: string;
	/** Tool allowlist for pi --tools. */
	tools?: string[];
	/** Role preamble for pi --append-system-prompt. */
	appendSystemPrompt?: string;
	/** Session storage directory; with sessionId, the agent keeps a transcript. */
	sessionDir?: string;
	/** Exact session id: pi reopens it if it exists, else creates it. */
	sessionId?: string;
	/** File the child's stderr is mirrored to in full. */
	stderrPath?: string;
	approved: boolean;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface SpawnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	totalTokens: number;
	turns: number;
}

export interface SpawnResult {
	text: string;
	usage: SpawnUsage;
}

export class SubagentError extends Error {
	constructor(
		message: string,
		readonly usage: SpawnUsage,
	) {
		super(message);
		this.name = "SubagentError";
	}
}

export function emptyUsage(): SpawnUsage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, totalTokens: 0, turns: 0 };
}

export function addUsage(total: SpawnUsage, part: SpawnUsage): void {
	total.input += part.input;
	total.output += part.output;
	total.cacheRead += part.cacheRead;
	total.cacheWrite += part.cacheWrite;
	total.cost += part.cost;
	total.totalTokens += part.totalTokens;
	total.turns += part.turns;
}

/**
 * Resolve how to invoke pi from inside a running pi. process.argv[1] is pi's
 * own entry script when running under node, which also works when pi is not on
 * PATH (true for pnpm-global installs in sandboxed shells).
 */
export function piInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	if (!/^(node|bun)(\.exe)?$/.test(basename(process.execPath).toLowerCase())) {
		return { command: process.execPath, args };
	}
	return { command: "pi", args };
}

export function buildArgs(request: SpawnRequest): string[] {
	const args = ["--mode", "json", "-p", "--no-extensions", "--no-skills", "--offline"];
	// A session dir plus an exact id is how an agent both inherits its forked
	// context and leaves a transcript. Without them, stay ephemeral.
	if (request.sessionDir && request.sessionId) {
		args.push("--session-dir", request.sessionDir, "--session-id", request.sessionId);
	} else {
		args.push("--no-session");
	}
	if (request.model) args.push("--model", request.model);
	if (request.thinking) args.push("--thinking", request.thinking);
	if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
	if (request.appendSystemPrompt) args.push("--append-system-prompt", request.appendSystemPrompt);
	args.push(request.approved ? "--approve" : "--no-approve");
	args.push(request.prompt);
	return args;
}

/**
 * pi announces a brand-new --session-id on stderr. That is the normal path for
 * an agent without forked context, so it must not become the reported cause of
 * an unrelated failure.
 */
export function stderrDetail(stderr: string): string {
	const lines = stderr
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^Warning: No project session found with id/.test(line));
	return lines.at(-1) ?? "";
}

export async function runSubagent(request: SpawnRequest): Promise<SpawnResult> {
	const usage = emptyUsage();
	if (request.signal?.aborted) throw new SubagentError("aborted", usage);

	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stderr = "";
	let timedOut = false;
	let aborted = false;
	let killSignal: NodeJS.Signals | null = null;

	const exitCode = await new Promise<number | null>((resolve) => {
		const invocation = piInvocation(buildArgs(request));
		const child = spawn(invocation.command, invocation.args, {
			cwd: request.cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});

		// Decode across chunk boundaries: a multibyte character split between
		// two pipe reads must not become replacement characters.
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: { type?: string; message?: Record<string, unknown> };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.type !== "message_end" || !event.message) return;
			const message = event.message as {
				role?: string;
				content?: Array<{ type?: string; text?: string }>;
				usage?: Partial<SpawnUsage> & { cost?: { total?: number }; totalTokens?: number };
				stopReason?: string;
				errorMessage?: string;
			};
			if (message.role !== "assistant") return;
			usage.turns++;
			if (message.usage) {
				usage.input += message.usage.input ?? 0;
				usage.output += message.usage.output ?? 0;
				usage.cacheRead += message.usage.cacheRead ?? 0;
				usage.cacheWrite += message.usage.cacheWrite ?? 0;
				usage.cost += message.usage.cost?.total ?? 0;
				usage.totalTokens = message.usage.totalTokens ?? usage.totalTokens;
			}
			const text = (message.content ?? [])
				.filter((block) => block.type === "text" && typeof block.text === "string")
				.map((block) => block.text)
				.join("\n")
				.trim();
			if (text) finalText = text;
			if (message.stopReason) stopReason = message.stopReason;
			if (message.errorMessage) errorMessage = message.errorMessage;
		};

		child.stdout.on("data", (data: Buffer) => {
			buffer += decoder.write(data);
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) handleLine(line);
		});
		child.stderr.on("data", (data: Buffer) => {
			const chunk = data.toString();
			// The tail is for the error message; the file keeps everything, so a
			// failure can be diagnosed after the fact rather than from 8KB.
			stderr = (stderr + chunk).slice(-8192);
			if (request.stderrPath) {
				try {
					appendFileSync(request.stderrPath, chunk, "utf8");
				} catch {
					/* the run matters more than its log */
				}
			}
		});

		const kill = () => {
			child.kill("SIGTERM");
			const hardKill = setTimeout(() => {
				if (child.exitCode === null) child.kill("SIGKILL");
			}, 5000);
			hardKill.unref?.();
		};

		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, request.timeoutMs ?? CONFIG.agentTimeoutMs);
		timer.unref?.();

		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (request.signal) {
			if (request.signal.aborted) onAbort();
			else request.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.on("close", (code, signal) => {
			clearTimeout(timer);
			request.signal?.removeEventListener("abort", onAbort);
			buffer += decoder.end();
			if (buffer.trim()) handleLine(buffer);
			killSignal = signal;
			resolve(code);
		});
		child.on("error", (error) => {
			stderr += String(error);
			resolve(1);
		});
	});

	if (aborted) throw new SubagentError("aborted", usage);
	if (timedOut) {
		throw new SubagentError(`subagent timed out after ${Math.round((request.timeoutMs ?? CONFIG.agentTimeoutMs) / 1000)}s`, usage);
	}
	// A signal-terminated child reports exit code null — that is a failure, not
	// a zero. And JSON mode exits 0 even when the model errored, so stopReason
	// is checked as well.
	if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
		const detail = errorMessage || stderrDetail(stderr) || (killSignal ? `killed by ${killSignal}` : `exit code ${exitCode}`);
		throw new SubagentError(`subagent failed: ${detail}`, usage);
	}
	return { text: finalText, usage };
}
