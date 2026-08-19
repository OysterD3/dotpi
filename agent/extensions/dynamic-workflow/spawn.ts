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
	/**
	 * Called with the INCREMENT for each assistant turn, as the child reports it.
	 *
	 * Without this a run's spend only lands when the subprocess exits, so a fleet
	 * of ten-minute agents reads $0.0000 for ten minutes — exactly the window in
	 * which someone is watching to decide whether to cancel. The deltas sum to the
	 * same totals the returned `usage` carries, `totalTokens` included (see the
	 * note where it is computed), so a caller streams these INSTEAD of adding the
	 * final total, never as well.
	 */
	onUsage?: (delta: SpawnUsage) => void;
}

export interface SpawnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Thinking tokens, when the provider breaks them out. A subset of `output`. */
	reasoning: number;
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
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0, totalTokens: 0, turns: 0 };
}

export function addUsage(total: SpawnUsage, part: SpawnUsage): void {
	total.input += part.input;
	total.output += part.output;
	total.cacheRead += part.cacheRead;
	total.cacheWrite += part.cacheWrite;
	total.reasoning += part.reasoning;
	total.cost += part.cost;
	total.totalTokens += part.totalTokens;
	total.turns += part.turns;
}

/** The usage block pi puts on an assistant message in its JSONL event stream. */
export interface ReportedUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	/** Subset of `output`; only some providers report it, so it is optional here. */
	reasoning?: number;
	cost?: { total?: number };
	totalTokens?: number;
}

/**
 * Fold one assistant turn into `usage`, and return what that turn added.
 *
 * The returned delta is what makes live reporting possible, and its contract is
 * that adding every delta with addUsage lands exactly where `usage` does. Two
 * cases make that non-obvious:
 *
 *   - a turn counts even when the provider reported no usage at all, so `turns`
 *     is 1 regardless;
 *   - `totalTokens` is the child's CONTEXT SIZE, replaced each turn rather than
 *     accumulated, so its delta is the difference. That goes negative when the
 *     child compacts — correctly, since a caller adding deltas must come down
 *     with it rather than holding the high-water mark.
 */
export function applyTurn(usage: SpawnUsage, reported: ReportedUsage | undefined): SpawnUsage {
	const delta = emptyUsage();
	delta.turns = 1;
	usage.turns++;
	if (!reported) return delta;

	delta.input = reported.input ?? 0;
	delta.output = reported.output ?? 0;
	delta.cacheRead = reported.cacheRead ?? 0;
	delta.cacheWrite = reported.cacheWrite ?? 0;
	delta.reasoning = reported.reasoning ?? 0;
	delta.cost = reported.cost?.total ?? 0;
	usage.input += delta.input;
	usage.output += delta.output;
	usage.cacheRead += delta.cacheRead;
	usage.cacheWrite += delta.cacheWrite;
	usage.reasoning += delta.reasoning;
	usage.cost += delta.cost;

	const next = reported.totalTokens ?? usage.totalTokens;
	delta.totalTokens = next - usage.totalTokens;
	usage.totalTokens = next;
	return delta;
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

/**
 * Make a string safe to pass as an argv slot.
 *
 * Node's spawn rejects an argument containing a NUL outright, killing the call
 * before the child exists. A subagent's prompt carries forked context and
 * earlier stages' results, so one binary byte that reached a tool result
 * anywhere upstream would fail every agent that inherits it — a whole fleet,
 * for a reason that names an argv index rather than the cause.
 *
 * Extensions here install independently and do not import across boundaries,
 * so the four lines are duplicated rather than shared.
 */
export function scrubArg(text: string): string {
	return text.replace(/\0/g, "");
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
	if (request.model) args.push("--model", scrubArg(request.model));
	if (request.thinking) args.push("--thinking", scrubArg(request.thinking));
	if (request.tools && request.tools.length > 0) args.push("--tools", scrubArg(request.tools.join(",")));
	// The role prompt comes from subagents.json and the task prompt carries
	// forked context and earlier results — both are arbitrary text from
	// elsewhere, so both are scrubbed.
	if (request.appendSystemPrompt) args.push("--append-system-prompt", scrubArg(request.appendSystemPrompt));
	args.push(request.approved ? "--approve" : "--no-approve");
	args.push(scrubArg(request.prompt));
	return args;
}

/**
 * pi announces a brand-new --session-id on stderr. That is the normal path for
 * an agent without forked context, so it must not become the reported cause of
 * an unrelated failure.
 */
/** A line that is nothing but a file path or URL — a pointer, not a reason. */
function isBarePointer(line: string): boolean {
	return /^\S+$/.test(line) && /[/\\]/.test(line);
}

export function stderrDetail(stderr: string, maxChars = 300): string {
	// Two different filters. The session notice is benign ALWAYS — it must never
	// come back, even as a last resort, or an agent that only announced its new
	// session id reports that announcement as its cause of death. A bare pointer
	// is merely uninformative, so it is only set aside while something better
	// survives.
	//
	// pi's own errors often END with a documentation path on its own line:
	// "…use a more specific id" then "…/docs/models.md". Returning the last
	// line, as this used to, reported the PATH — every model-resolution failure
	// read `subagent failed: /Users/…/docs/models.md`, naming no cause at all
	// and sending the reader to a file instead of the sentence above it.
	//
	// Up to three surviving lines are kept rather than one, because the message
	// is frequently split ("No model matched X." / "Available: …").
	const all = stderr
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !/^Warning: No project session found with id/.test(line));
	const meaningful = all.filter((line) => !isBarePointer(line));
	const chosen = meaningful.length > 0 ? meaningful.slice(-3) : all.slice(-1);
	// Dropping the pointer can leave the words that introduced it: "…Use /login
	// to log into a provider. See:" reads as though something was lost. Trim the
	// dangling connector rather than the sentence before it.
	// The colon is required: it is what makes this a connector introducing the
	// path rather than the last word of a sentence ("nothing left to see").
	const detail = chosen.join(" ").replace(/\s+see:\s*$/i, "");
	return detail.length > maxChars ? `${detail.slice(0, maxChars)}…` : detail;
}

export async function runSubagent(request: SpawnRequest): Promise<SpawnResult> {
	const usage = emptyUsage();
	if (request.signal?.aborted) throw new SubagentError("aborted", usage);

	let finalText = "";
	let stopReason: string | undefined;
	let errorMessage: string | undefined;
	let stderr = "";
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
				usage?: ReportedUsage;
				stopReason?: string;
				errorMessage?: string;
			};
			if (message.role !== "assistant") return;
			const delta = applyTurn(usage, message.usage);
			// After the totals, so a throwing subscriber cannot leave `usage` half
			// applied — and swallowed, because this runs on the stdout handler where
			// an escape would take the whole spawn down.
			if (request.onUsage) {
				try {
					request.onUsage(delta);
				} catch {
					/* a subscriber's problem is not the agent's */
				}
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

		// No wall-clock timer. A subagent runs until it finishes, the user aborts,
		// or the child dies; a long agent is a slow agent, not a stuck one, and
		// the ceiling that used to be here only ever killed work in progress.
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (request.signal) {
			if (request.signal.aborted) onAbort();
			else request.signal.addEventListener("abort", onAbort, { once: true });
		}

		child.on("close", (code, signal) => {
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
	// A signal-terminated child reports exit code null — that is a failure, not
	// a zero. And JSON mode exits 0 even when the model errored, so stopReason
	// is checked as well.
	if (exitCode !== 0 || stopReason === "error" || stopReason === "aborted") {
		const detail = errorMessage || stderrDetail(stderr) || (killSignal ? `killed by ${killSignal}` : `exit code ${exitCode}`);
		throw new SubagentError(`subagent failed: ${detail}`, usage);
	}
	return { text: finalText, usage };
}
