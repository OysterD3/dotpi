/**
 * Running the reviewer as a headless pi subprocess.
 *
 * The reviewer is a one-shot, TOOL-LESS call: it reads the forwarded transcript
 * and returns advice text, nothing else. So this spawns pi with `--no-tools`
 * (the reviewer must not act on the repo), `--no-session` (no litter in
 * ~/.pi/agent/sessions), `--no-extensions --no-skills` (plain pi — in
 * particular it cannot recurse into another advisor), and `--offline` (suppress
 * update/catalog fetches; model inference still happens). stdin is ignored — an
 * inherited stdin makes headless pi block reading it to EOF.
 *
 * This follows the same subagent recipe as the ultracode extension and pi's own
 * examples/extensions/subagent; it is duplicated here rather than shared so the
 * advisor extension is independently installable.
 *
 * Failures throw SubagentError carrying whatever usage the child accumulated
 * before dying, so a failed reviewer's spend still reaches the session totals.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CONFIG } from "./config.ts";

export interface ReviewerRequest {
	prompt: string;
	cwd: string;
	/** "provider/model-id" for pi's --model flag. Required: the reviewer model. */
	model: string;
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

export interface ReviewerResult {
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

export function buildArgs(request: ReviewerRequest): string[] {
	const args = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--no-extensions",
		"--no-skills",
		"--offline",
		"--no-tools",
		"--no-approve",
		"--model",
		request.model,
	];
	args.push(request.prompt);
	return args;
}

export async function runReviewer(request: ReviewerRequest): Promise<ReviewerResult> {
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

		// Decode across chunk boundaries so a multibyte character split between
		// two pipe reads does not become replacement characters.
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
			if (stderr.length < 8192) stderr += data.toString();
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
		}, request.timeoutMs ?? CONFIG.reviewerTimeoutMs);
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
		throw new SubagentError(`reviewer timed out after ${Math.round((request.timeoutMs ?? CONFIG.reviewerTimeoutMs) / 1000)}s`, usage);
	}
	// A signal-terminated child reports exit code null — that is a failure, not
	// a zero. And JSON mode exits 0 even when the model errored, so stopReason
	// is checked as well.
	if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
		const detail =
			errorMessage ||
			stderr.trim().split("\n").at(-1) ||
			(killSignal ? `killed by ${killSignal}` : `exit code ${exitCode}`);
		throw new SubagentError(`reviewer failed: ${detail}`, usage);
	}
	return { text: finalText, usage };
}
