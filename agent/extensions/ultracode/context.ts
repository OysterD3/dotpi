/**
 * Forking context into a subagent.
 *
 * A workflow agent used to start from nothing but its prompt, so a script had
 * to paste every fact into a string. Here it can ask for what it needs —
 * `context: { parent: 8, files: ["src/a.ts"], text: "..." }` — and the agent is
 * seeded with it.
 *
 * The mechanism is pi's own: build a session file up front with SessionManager,
 * then run the agent with `--session-id`/`--session-dir` pointed at it. Two
 * consequences fall out for free:
 *   - the seeded session IS the agent's transcript, so a finished agent can be
 *     read back or rendered with `pi --export` (debuggability);
 *   - nothing has to be re-derived on resume, because the file is on disk.
 *
 * The seed is a user message carrying the bundle plus a one-line assistant
 * acknowledgement. Both are needed: providers reject two consecutive user
 * messages, and pi only flushes a session to disk once it holds an assistant
 * message (SessionManager._persist), so a user-only seed would never exist as
 * a file for the child to open.
 *
 * The rendering half is pure and takes plain entry shapes, so it is testable
 * without a session.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SessionManager, type NewSessionOptions } from "@earendil-works/pi-coding-agent";
import type { AgentContext } from "./engine.ts";

type ContentBlock = { type?: string; text?: string; name?: string; arguments?: unknown };

export type BranchEntry = {
	type: string;
	message?: { role?: string; content?: unknown };
};

function textBlocks(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const out: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as ContentBlock;
		if (block.type === "text" && typeof block.text === "string") out.push(block.text);
	}
	return out;
}

/** One "User: …" / "Assistant: …" section per message, oldest first. */
export function branchSections(entries: BranchEntry[]): string[] {
	const sections: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = textBlocks(entry.message?.content).join("\n").trim();
		if (!text) continue;
		sections.push(`${role === "user" ? "User" : "Assistant"}: ${text}`);
	}
	return sections;
}

/**
 * The last `turns` sections, newest-biased: when the budget bites, the OLDEST
 * are dropped, because a subagent needs where things stand more than how they
 * started.
 */
export function renderParent(entries: BranchEntry[], turns: number | "all", budgetChars: number): string {
	const sections = branchSections(entries);
	// slice(-0) is slice(0) — the whole array — so zero has to be special-cased.
	const count = turns === "all" ? sections.length : Math.max(0, Math.floor(turns));
	if (count === 0) return "";
	const wanted = sections.slice(-count);

	let used = 0;
	let start = wanted.length;
	for (let i = wanted.length - 1; i >= 0; i--) {
		const cost = wanted[i]!.length + 2;
		if (start < wanted.length && used + cost > budgetChars) break;
		used += cost;
		start = i;
	}
	const kept = wanted.slice(start);
	if (kept.length === 0) return "";
	// Only budget-driven loss is announced: asking for the last N turns is a
	// choice, not a truncation, and saying otherwise would misreport it.
	const dropped = wanted.length - kept.length;
	const notice = dropped > 0 ? `[${dropped} earlier message(s) omitted]\n\n` : "";
	return `${notice}${kept.join("\n\n")}`;
}

export interface RenderedFile {
	path: string;
	text: string;
	error?: string;
}

/** Read the requested files, truncating each to the per-file budget. */
export function readContextFiles(paths: string[], cwd: string, perFileChars: number): RenderedFile[] {
	const out: RenderedFile[] = [];
	for (const path of paths) {
		if (typeof path !== "string" || !path.trim()) continue;
		const full = isAbsolute(path) ? path : resolve(cwd, path);
		try {
			const raw = readFileSync(full, "utf8");
			const text = raw.length > perFileChars ? `${raw.slice(0, perFileChars)}\n… [truncated at ${perFileChars} characters]` : raw;
			out.push({ path, text });
		} catch (error) {
			out.push({ path, text: "", error: error instanceof Error ? error.message : String(error) });
		}
	}
	return out;
}

export interface BundleInput {
	context: AgentContext;
	branch: BranchEntry[];
	cwd: string;
}

/**
 * The seed text for one agent, or undefined when nothing was asked for. Order
 * is text → files → parent conversation.
 *
 * Nothing is truncated. The character budgets that used to cap this are gone:
 * a seed silently cut at 60k is an agent working from half a file and no way to
 * tell, which is a worse failure than a large prompt. The helpers still TAKE a
 * budget — they are pure and independently useful — so Infinity is passed
 * rather than deleting a parameter that has its own tests.
 */
export function buildContextBundle(input: BundleInput): string | undefined {
	const { context, branch, cwd } = input;
	const parts: string[] = [];

	const literal = typeof context.text === "string" ? context.text.trim() : "";
	if (literal) parts.push(`## Context\n\n${literal}`);

	if (Array.isArray(context.files) && context.files.length > 0) {
		const files = readContextFiles(context.files, cwd, Number.POSITIVE_INFINITY);
		const rendered: string[] = [];
		for (const file of files) {
			if (file.error) {
				rendered.push(`### ${file.path}\n\n[could not be read: ${file.error}]`);
				continue;
			}
			rendered.push(`### ${file.path}\n\n\`\`\`\n${file.text}\n\`\`\``);
		}
		if (rendered.length > 0) parts.push(`## Files\n\n${rendered.join("\n\n")}`);
	}

	if (context.parent !== undefined && context.parent !== 0) {
		const conversation = renderParent(branch, context.parent, Number.POSITIVE_INFINITY);
		if (conversation) parts.push(`## Conversation so far\n\n${conversation}`);
	}

	if (parts.length === 0) return undefined;
	const header =
		"The following is context forked from the session that started this workflow. Use it as background; the task itself arrives in the next message.";
	return `${header}\n\n${parts.join("\n\n")}`;
}

export const SEED_ACKNOWLEDGEMENT = "Context received. Send the task.";

export interface SeedRequest {
	cwd: string;
	sessionDir: string;
	sessionId: string;
	bundle: string;
	/** Recorded on the seeded assistant turn; cosmetic, but keeps entries valid. */
	provider?: string;
	model?: string;
	/** The parent session file, recorded in the header for lineage. */
	parentSession?: string;
}

/**
 * Write the agent's session file with the forked context already in it.
 * Returns the file path, or undefined if the session could not be created —
 * a seeding failure downgrades to a context-less agent rather than a dead run.
 */
export function seedAgentSession(request: SeedRequest): string | undefined {
	try {
		const options: NewSessionOptions = { id: request.sessionId, parentSession: request.parentSession };
		const manager = SessionManager.create(request.cwd, request.sessionDir, options);
		manager.appendMessage({
			role: "user",
			content: [{ type: "text", text: request.bundle }],
			timestamp: Date.now(),
		} as never);
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: SEED_ACKNOWLEDGEMENT }],
			api: "seed",
			provider: request.provider ?? "workflow",
			model: request.model ?? "seed",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		} as never);
		return manager.getSessionFile();
	} catch {
		return undefined;
	}
}
