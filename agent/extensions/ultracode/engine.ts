/**
 * The workflow script engine: parses the required `export const meta` literal,
 * then runs the script body in a vm sandbox with the orchestration globals
 * Claude Code's Workflow tool provides — agent(), parallel(), pipeline(),
 * phase(), log(), args, budget.
 *
 * Semantics mirror Claude Code 2.1.217:
 *   - concurrent agent() calls gated by a semaphore (min(16, cores - 2));
 *   - total agent() calls per run capped (1000) — exceeding fails the run;
 *   - parallel() never rejects for ordinary failures: a thunk that throws
 *     resolves to null. Fatal conditions (abort, the agent cap, invalid
 *     agent() usage) DO propagate — an aborted run must never look successful;
 *   - pipeline() has no barrier between stages; a stage that throws drops the
 *     item to null and skips its remaining stages; stages receive
 *     (prevResult, originalItem, index);
 *   - a single parallel()/pipeline() call accepts at most 4096 items;
 *   - budget is a stub ({total: null}) since pi has no "+500k" directive:
 *     budget-guarded loops written for Claude Code fall through cleanly.
 *
 * Safety properties this file is responsible for:
 *   - an agent() promise the script never awaits can NOT become a host
 *     unhandledRejection (pi exits the whole process on those) — every
 *     returned promise carries an observer;
 *   - when the run settles, agents the script left in flight are aborted and
 *     awaited, so no subprocess outlives the tool call;
 *   - an external abort always fails the run, even if the script swallowed
 *     every error.
 *
 * Deviations (documented in README.md): no resume journal, no worktree
 * isolation, no nested workflow() (it throws), Date.now()/Math.random() are
 * allowed (Claude Code bans them only to keep resume deterministic). The
 * script body itself runs unbounded on the host event loop — a synchronous
 * infinite loop in a script wedges the session (same trust level as extension
 * code; the tool description tells the model to always await, never busy-wait).
 */
import { runInNewContext } from "node:vm";
import { CONFIG } from "./config.ts";

export interface WorkflowMeta {
	name: string;
	description: string;
	phases?: Array<{ title: string; detail?: string }>;
	whenToUse?: string;
}

export interface AgentOptions {
	label?: string;
	phase?: string;
	model?: string;
	thinking?: string;
	schema?: Record<string, unknown>;
}

/** Conditions that must fail the whole run instead of nulling one agent. */
export class WorkflowFatalError extends Error {}

export interface EngineHooks {
	/** Spawn one subagent; returns its final text. Throws on spawn failure. */
	spawn: (prompt: string, options: AgentOptions, index: number, signal: AbortSignal) => Promise<string>;
	/** One agent() call is starting (schema retries reuse the same index). */
	agentStart?: (index: number, label: string, phase: string | undefined) => void;
	/** The agent() call settled; ok is false when it resolved to null. */
	agentEnd?: (index: number, ok: boolean) => void;
	log: (message: string) => void;
	phase: (title: string) => void;
}

// ---------------------------------------------------------------------- meta

/**
 * Extract the `export const meta = {...}` literal that must open the script.
 * The scanner walks balanced braces while respecting strings, template
 * literals, and comments, so a "{" inside a description cannot derail it.
 */
export function parseMeta(script: string): { meta: WorkflowMeta; body: string } {
	const match = /^\s*export\s+const\s+meta\s*=\s*\{/.exec(script);
	if (!match) throw new Error("workflow script must begin with `export const meta = {...}`");

	const start = match[0].length - 1; // index of the opening brace
	let depth = 0;
	let i = start;
	let mode: "code" | "'" | '"' | "`" | "line" | "block" = "code";
	for (; i < script.length; i++) {
		const ch = script[i]!;
		const next = script[i + 1];
		if (mode === "code") {
			if (ch === "{") depth++;
			else if (ch === "}") {
				depth--;
				if (depth === 0) break;
			} else if (ch === "'" || ch === '"' || ch === "`") mode = ch;
			else if (ch === "/" && next === "/") mode = "line";
			else if (ch === "/" && next === "*") mode = "block";
		} else if (mode === "line") {
			if (ch === "\n") mode = "code";
		} else if (mode === "block") {
			if (ch === "*" && next === "/") {
				mode = "code";
				i++;
			}
		} else {
			if (ch === "\\") i++;
			else if (ch === mode) mode = "code";
		}
	}
	if (depth !== 0) throw new Error("workflow meta: unbalanced braces");

	const literal = script.slice(start, i + 1);
	let meta: unknown;
	try {
		meta = runInNewContext(`(${literal})`, {}, { timeout: 1000 });
	} catch (error) {
		throw new Error(`workflow meta must be a pure object literal: ${error instanceof Error ? error.message : String(error)}`);
	}
	const record = meta as Record<string, unknown>;
	if (!record || typeof record.name !== "string" || typeof record.description !== "string") {
		throw new Error("workflow meta requires string `name` and `description`");
	}
	// Strip the `export ` so the body parses as plain script code.
	const body = script.slice(0, match.index) + script.slice(match.index).replace(/^\s*export\s+/, "");
	return { meta: record as unknown as WorkflowMeta, body };
}

// -------------------------------------------------------------------- engine

class Semaphore {
	private queue: Array<() => void> = [];
	private active = 0;
	constructor(private readonly limit: number) {}

	async run<T>(task: () => Promise<T>): Promise<T> {
		if (this.active >= this.limit) await new Promise<void>((resolve) => this.queue.push(resolve));
		this.active++;
		try {
			return await task();
		} finally {
			this.active--;
			this.queue.shift()?.();
		}
	}
}

/** Shallow schema check: the payload is an object carrying every required key. */
export function conformsTo(value: unknown, schema: Record<string, unknown>): boolean {
	if (schema.type === "object") {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
		const required = Array.isArray(schema.required) ? schema.required : [];
		return required.every((key) => typeof key === "string" && key in (value as Record<string, unknown>));
	}
	if (schema.type === "array") return Array.isArray(value);
	return true;
}

export function schemaInstruction(schema: Record<string, unknown>): string {
	return [
		"",
		"Your reply will be machine-parsed. Output ONLY a JSON value matching this JSON Schema — no prose, no markdown fences:",
		JSON.stringify(schema),
	].join("\n");
}

/** The balanced JSON value starting at `start`, or null if none closes. */
function balancedJson(text: string, start: number): string | null {
	let depth = 0;
	let inString = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i]!;
		if (inString) {
			if (ch === "\\") i++;
			else if (ch === '"') inString = false;
		} else if (ch === '"') inString = true;
		else if (ch === "{" || ch === "[") depth++;
		else if (ch === "}" || ch === "]") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return null;
}

/** Pull a JSON value out of a reply that may wrap it in fences or prose. */
export function extractJson(text: string): unknown {
	const trimmed = text.trim();
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	const start = trimmed.search(/[[{]/);
	const candidates = [
		trimmed,
		fenced?.[1]?.trim(),
		start !== -1 ? trimmed.slice(start) : undefined, // prose before the JSON
		start !== -1 ? balancedJson(trimmed, start) : undefined, // prose after it too
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			return JSON.parse(candidate);
		} catch {
			/* try the next shape */
		}
	}
	throw new Error("reply contained no parsable JSON");
}

export interface RunResult {
	meta: WorkflowMeta;
	result: unknown;
	agentCount: number;
}

export async function runWorkflowScript(
	script: string,
	args: unknown,
	hooks: EngineHooks,
	signal?: AbortSignal,
): Promise<RunResult> {
	const { meta, body } = parseMeta(script);
	const semaphore = new Semaphore(CONFIG.maxConcurrency);
	let agentCount = 0;

	// Everything spawned runs against this controller so that when the run
	// settles — normally, fatally, or by external abort — agents the script
	// abandoned are cancelled rather than orphaned.
	const controller = new AbortController();
	const onExternalAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onExternalAbort, { once: true });

	const inFlight = new Set<Promise<unknown>>();

	async function runAgent(prompt: unknown, options: AgentOptions): Promise<unknown> {
		if (typeof prompt !== "string" || !prompt.trim()) {
			throw new WorkflowFatalError("agent() requires a non-empty prompt string");
		}
		if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
		if (agentCount >= CONFIG.maxAgentsPerRun) {
			throw new WorkflowFatalError(`workflow exceeded the ${CONFIG.maxAgentsPerRun}-agent cap`);
		}
		const index = ++agentCount;
		return semaphore.run(async () => {
			if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
			hooks.agentStart?.(index, options.label ?? `agent ${index}`, options.phase);
			let ok = false;
			try {
				let value: unknown;
				if (!options.schema) {
					value = await hooks.spawn(prompt, options, index, controller.signal);
				} else {
					value = await runSchemaAgent(prompt, options, index);
				}
				ok = true;
				return value;
			} catch (error) {
				if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
				hooks.log(`agent ${options.label ?? index} failed: ${error instanceof Error ? error.message : String(error)}`);
				return null;
			} finally {
				hooks.agentEnd?.(index, ok);
			}
		});
	}

	async function runSchemaAgent(prompt: string, options: AgentOptions, index: number): Promise<unknown> {
		const schema = options.schema!;
		let request = prompt + schemaInstruction(schema);
		for (let attempt = 0; ; attempt++) {
			const reply = await hooks.spawn(request, options, index, controller.signal);
			try {
				const value = extractJson(reply);
				if (!conformsTo(value, schema)) throw new Error("JSON did not match the schema");
				return value;
			} catch (error) {
				if (attempt >= CONFIG.schemaRetries) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				hooks.log(`agent ${options.label ?? index}: retrying, ${reason}`);
				request = `${prompt}${schemaInstruction(schema)}\n\nYour previous reply could not be used (${reason}). Reply again with ONLY the JSON value.`;
			}
		}
	}

	const agent = (prompt: unknown, options: AgentOptions = {}): Promise<unknown> => {
		const task = runAgent(prompt, options);
		// Observe the rejection path so a promise the script drops on the floor
		// can never surface as a host unhandledRejection (pi exits on those),
		// and track it so run teardown can wait for it. Awaiting `task` itself
		// still rejects normally for the script.
		const settle = () => void inFlight.delete(task);
		inFlight.add(task);
		task.then(settle, settle);
		return task;
	};

	const guardAll = async (promises: Array<Promise<unknown>>): Promise<unknown[]> => {
		// Promise.all rejects on the FIRST fatal error; observe the rest so the
		// losers of that race cannot become unhandled rejections.
		for (const promise of promises) promise.then(undefined, () => {});
		return Promise.all(promises);
	};

	const parallel = async (thunks: unknown): Promise<unknown[]> => {
		if (!Array.isArray(thunks)) throw new Error("parallel() takes an array of functions");
		if (thunks.length > CONFIG.maxItemsPerCall) {
			throw new Error(`parallel() accepts at most ${CONFIG.maxItemsPerCall} items, got ${thunks.length}`);
		}
		return guardAll(
			thunks.map(async (thunk) => {
				if (typeof thunk !== "function") return null;
				try {
					return await thunk();
				} catch (error) {
					if (error instanceof WorkflowFatalError) throw error;
					return null;
				}
			}),
		);
	};

	const pipeline = async (items: unknown, ...stages: unknown[]): Promise<unknown[]> => {
		if (!Array.isArray(items)) throw new Error("pipeline() takes an array of items");
		if (items.length > CONFIG.maxItemsPerCall) {
			throw new Error(`pipeline() accepts at most ${CONFIG.maxItemsPerCall} items, got ${items.length}`);
		}
		const callbacks = stages.filter((s): s is (prev: unknown, item: unknown, index: number) => unknown => typeof s === "function");
		return guardAll(
			items.map(async (item, index) => {
				let previous: unknown = item;
				for (const stage of callbacks) {
					try {
						previous = await stage(previous, item, index);
					} catch (error) {
						if (error instanceof WorkflowFatalError) throw error;
						return null;
					}
				}
				return previous;
			}),
		);
	};

	const sandbox = {
		agent,
		parallel,
		pipeline,
		phase: (title: unknown) => hooks.phase(String(title)),
		log: (message: unknown) => hooks.log(String(message)),
		args,
		budget: { total: null as number | null, spent: () => 0, remaining: () => Infinity },
		workflow: () => {
			throw new Error("nested workflow() is not supported in pi");
		},
		// The vm context is a fresh realm with all JS intrinsics; only host APIs
		// (which are not intrinsics) need providing.
		console: { log: (...parts: unknown[]) => hooks.log(parts.map(String).join(" ")) },
		structuredClone,
		setTimeout,
		clearTimeout,
	};

	// The vm timeout bounds COMPILATION only: evaluating this expression just
	// creates the closure. The body itself runs unbounded on the host event
	// loop when fn() is awaited — see the header comment.
	const fn = runInNewContext(`(async () => { "use strict";\n${body}\n})`, sandbox, { timeout: 5000 }) as () => Promise<unknown>;

	try {
		const result = await fn();
		if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
		return { meta, result, agentCount };
	} finally {
		// Cancel anything the script started and never awaited, then wait for
		// those agents to wind down so no subprocess outlives the tool call.
		signal?.removeEventListener("abort", onExternalAbort);
		controller.abort();
		if (inFlight.size > 0) {
			hooks.log(`${inFlight.size} agent(s) still in flight at run end — cancelling`);
			await Promise.allSettled([...inFlight]);
		}
	}
}
