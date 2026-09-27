/**
 * Running a configured subagent as a headless pi subprocess.
 *
 * Same recipe as the dynamic-workflow extension and pi's own
 * examples/extensions/subagent (`pi --mode json -p --no-session` with stdin
 * ignored, JSONL message_end parsing, SIGTERM-then-SIGKILL on abort), with the
 * extra flags a standing subagent needs: `--thinking` for its reasoning level,
 * `--tools` for its allowlist, and `--append-system-prompt` for its role
 * prompt. `--no-extensions --no-skills` keep it plain pi (no recursion into
 * subagents), `--no-session` keeps sessions/ clean. Duplicated here so the
 * extension is independently installable. The one extension a child gets back
 * is the provider package its model needs (Qoder), loaded with `-e`.
 *
 * Failures throw SubagentError carrying whatever usage the child accumulated
 * before dying, so a failed subagent's spend still reaches the session totals.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";

export interface SpawnRequest {
	prompt: string;
	cwd: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	appendSystemPrompt?: string;
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
	/** Qoder credits of the billable requests; set once any request reported `billable`. */
	credits?: number;
	/** Whether any Qoder request was billable. */
	billable?: boolean;
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

/**
 * Providers that come from a pi package, not from pi itself. `--no-extensions`
 * drops them with every other extension, so a subagent on one of their models
 * gets that one package back with `-e`.
 */
const PROVIDER_PACKAGES: Record<string, string> = {
	qoder: "pi-provider-qoder",
	"qoder-cn": "pi-provider-qoder",
};

/** The installed extension file that registers the model's provider, when pi lacks it. */
export function providerExtension(model: string | undefined): string | undefined {
	const pkg = model ? PROVIDER_PACKAGES[model.split("/")[0] ?? ""] : undefined;
	if (!pkg) return undefined;
	const dir = join(getAgentDir(), "npm", "node_modules", pkg);
	try {
		const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { pi?: { extensions?: unknown } };
		const entry = Array.isArray(manifest.pi?.extensions) ? manifest.pi.extensions[0] : undefined;
		return typeof entry === "string" ? join(dir, entry) : undefined;
	} catch {
		// Not installed: the child reports the unknown model, as it did before.
		return undefined;
	}
}

export function buildArgs(request: SpawnRequest): string[] {
	const args = ["--mode", "json", "-p", "--no-session", "--no-extensions", "--no-skills", "--offline"];
	const extension = providerExtension(request.model);
	if (extension) args.push("-e", extension);
	if (request.model) args.push("--model", request.model);
	if (request.thinking) args.push("--thinking", request.thinking);
	if (request.tools && request.tools.length > 0) args.push("--tools", request.tools.join(","));
	if (request.appendSystemPrompt) args.push("--append-system-prompt", request.appendSystemPrompt);
	args.push(request.approved ? "--approve" : "--no-approve");
	args.push(request.prompt);
	return args;
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

		// Decode across chunk boundaries so a multibyte character split between
		// two pipe reads does not become replacement characters.
		const decoder = new StringDecoder("utf8");
		let buffer = "";
		// A Qoder request reports its credits; a non-billable one counts as 0.
		const addCredits = (spent: { credits?: unknown; billable?: unknown } | undefined) => {
			if (typeof spent?.billable !== "boolean") return;
			const credits = spent.billable ? spent.credits : 0;
			usage.credits = (usage.credits ?? 0) + (typeof credits === "number" ? credits : 0);
			usage.billable = usage.billable === true || spent.billable;
		};
		const handleLine = (line: string) => {
			if (!line.trim()) return;
			let event: {
				type?: string;
				message?: Record<string, unknown>;
				result?: { usage?: { credits?: unknown; billable?: unknown } };
			};
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			// The child's own compaction summary is billed too, and is reported only here.
			if (event.type === "compaction_end") return addCredits(event.result?.usage);
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
				addCredits(message.usage);
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
		}, request.timeoutMs ?? CONFIG.subagentTimeoutMs);
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
		throw new SubagentError(`subagent timed out after ${Math.round((request.timeoutMs ?? CONFIG.subagentTimeoutMs) / 1000)}s`, usage);
	}
	// A signal-terminated child reports exit code null — that is a failure, not
	// a zero. And JSON mode exits 0 even when the model errored, so stopReason
	// is checked as well.
	if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
		const detail =
			errorMessage ||
			stderr.trim().split("\n").at(-1) ||
			(killSignal ? `killed by ${killSignal}` : `exit code ${exitCode}`);
		throw new SubagentError(`subagent failed: ${detail}`, usage);
	}
	return { text: finalText, usage };
}
