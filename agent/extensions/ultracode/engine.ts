/**
 * The workflow script engine: parses the required `export const meta` literal,
 * then runs the script body in a vm sandbox with the orchestration globals —
 * agent(), parallel(), pipeline(), phase(), log(), args, budget.
 *
 * The semantics:
 *   - agent() calls are UNBOUNDED and unqueued: every agent a script starts is
 *     spawned immediately, and there is no cap on how many run at once or how
 *     many a run may start in total. Breadth is the script's decision;
 *   - parallel() never rejects for ordinary failures: a thunk that throws
 *     resolves to null. Fatal conditions (abort, invalid agent() usage) DO
 *     propagate — an aborted run must never look successful;
 *   - pipeline() has no barrier between stages; a stage that throws drops the
 *     item to null and skips its remaining stages; stages receive
 *     (prevResult, originalItem, index);
 *   - budget is a stub ({total: null}) since pi has no token-budget directive,
 *     so budget-guarded loops fall through cleanly;
 *   - Date.now()/Math.random()/argless new Date() throw, so a journal can be
 *     replayed (opt out per script with `deterministic: false` in meta, at the
 *     cost of that run being unresumable).
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
 * Three seams the host drives (all optional, all in EngineHooks):
 *   - replay(key) serves a previous run's result instead of spawning (resume);
 *   - waitWhilePaused() parks a call before it spawns (live pause);
 *   - agentSettled() reports the full outcome, which is what the journal
 *     records.
 * `globals` injects extra sandbox bindings, so an extension can add helpers
 * without editing this file.
 *
 * Deviations (documented in README.md): no worktree isolation and no nested
 * workflow() (it throws). The script body itself runs unbounded on the host
 * event loop — a synchronous infinite loop in a script wedges the session (same
 * trust level as extension code; the tool description tells the model to always
 * await, never busy-wait).
 */
import { runInNewContext } from "node:vm";
import { CONFIG } from "./config.ts";
import { agentKey, shellKey, type ShellResult } from "./journal.ts";

export interface WorkflowMeta {
	name: string;
	description: string;
	phases?: Array<{ title: string; detail?: string }>;
	whenToUse?: string;
	/**
	 * Default true. Set false to allow Date.now()/Math.random() in the script,
	 * accepting that the run cannot be resumed from its journal.
	 */
	deterministic?: boolean;
}

/** What one agent may be forked with. See context.ts for how it is built. */
export interface AgentContext {
	/** Turns of the parent conversation to carry: a count, or "all". */
	parent?: number | "all";
	/** Files to embed, by path relative to the project (or absolute). */
	files?: string[];
	/** Literal text to prepend, e.g. findings from an earlier stage. */
	text?: string;
}

export interface AgentOptions {
	label?: string;
	phase?: string;
	model?: string;
	thinking?: string;
	schema?: Record<string, unknown>;
	/** A name from subagents.json: supplies tools, role prompt, model. */
	agentType?: string;
	/** Explicit tool allowlist, overriding the agentType's. */
	tools?: string[];
	context?: AgentContext;
	/**
	 * Name of a SHARED pi session, scoped to this run. Agents given the same
	 * name continue one conversation in turn, each seeing what the previous one
	 * actually did rather than a summary of it.
	 *
	 * Sequential by construction — see the guard in runAgent. Two agents holding
	 * the same name at once is a script error, not a race to be tolerated.
	 */
	session?: string;
}

/** Conditions that must fail the whole run instead of nulling one agent. */
export class WorkflowFatalError extends Error {}

export interface AgentOutcome {
	index: number;
	key: string;
	label: string;
	phase?: string;
	options: AgentOptions;
	status: "done" | "failed" | "replayed";
	value?: unknown;
	error?: string;
	startedAt: number;
	endedAt: number;
	/** Spawn attempts made (schema retries count); 0 for a replayed agent. */
	attempts: number;
}

export interface EngineHooks {
	/** Spawn one subagent; returns its final text. Throws on spawn failure. */
	spawn: (prompt: string, options: AgentOptions, index: number, signal: AbortSignal, attempt: number) => Promise<string>;
	/** One agent() call is starting (schema retries reuse the same index). */
	agentStart?: (index: number, label: string, phase: string | undefined) => void;
	/** The agent() call settled; ok is false when it resolved to null. */
	agentEnd?: (index: number, ok: boolean) => void;
	/** Full outcome of an agent() call — what the journal records. */
	agentSettled?: (outcome: AgentOutcome) => void;
	/**
	 * Everything that affects an agent's answer but is only NAMED in its
	 * options — the resolved agentType definition, the content of context
	 * files. Folded into the replay key so editing either invalidates the cache.
	 */
	keyExtras?: (options: AgentOptions) => unknown;
	/** Serve a cached result for this content key instead of spawning. */
	replay?: (key: string) => { hit: true; value: unknown } | { hit: false };
	/** Park a call while the run is paused; resolves when it may proceed. */
	waitWhilePaused?: (signal: AbortSignal) => Promise<void>;
	log: (message: string) => void;
	phase: (title: string) => void;
	/**
	 * Run a command on the HOST and return its real exit code.
	 *
	 * Absent when the project is not trusted, in which case shell() throws
	 * rather than silently doing nothing — a gate that quietly stops gating is
	 * the failure this whole feature exists to remove.
	 */
	shell?: (command: string, options: ShellOptions, signal: AbortSignal) => Promise<ShellResult>;
	/** A shell() call settled; what the journal records. */
	shellSettled?: (outcome: ShellOutcome) => void;
}

export interface ShellOptions {
	/** Kill the process after this many ms. Omitted means no limit. */
	timeoutMs?: number;
	/** Extra environment for the child, merged over the host's. */
	env?: Record<string, string>;
}

export interface ShellOutcome {
	key: string;
	command: string;
	cwd: string;
	result: ShellResult;
	startedAt: number;
	endedAt: number;
	replayed: boolean;
}

export interface EngineOptions {
	/** Extra sandbox bindings, merged after the built-in globals. */
	globals?: Record<string, unknown>;
	/**
	 * The project directory shell() runs in and keys against. Absent in unit
	 * tests, where no shell hook is wired either.
	 */
	cwd?: string;
}

// ---------------------------------------------------------------------- meta

/**
 * `export` is stripped from every top-level declaration, not just meta's: a
 * script that also exports a schema constant is otherwise a syntax error, and
 * models write those. Only line-leading `export` before a declaration keyword
 * is touched, so the word inside a string or comment survives.
 */
function stripExports(source: string): string {
	return source.replace(/^[ \t]*export[ \t]+(?=(?:const|let|var|function|class|async)\b)/gm, "");
}

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
	return { meta: record as unknown as WorkflowMeta, body: stripExports(script) };
}

function wrapBody(body: string): string {
	return `(async () => { "use strict";\n${body}\n})`;
}

/**
 * Compile the body without running it, so a syntax error fails the tool call
 * synchronously instead of arriving minutes later as a failed background run.
 */
export function compileBody(body: string, sandbox: Record<string, unknown> = {}): () => Promise<unknown> {
	return runInNewContext(wrapBody(body), sandbox, { timeout: 5000 }) as () => Promise<unknown>;
}

/** parseMeta plus a compile check. Throws with the reason if either fails. */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
	const parsed = parseMeta(script);
	try {
		compileBody(parsed.body);
	} catch (error) {
		throw new Error(`workflow script does not compile: ${error instanceof Error ? error.message : String(error)}`);
	}
	return parsed;
}

// -------------------------------------------------------------------- engine

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
	/** Agents served from a previous run's journal rather than spawned. */
	replayedCount: number;
}

/**
 * The sandbox bindings that make a run replayable. Date.now(), argless
 * new Date() and Math.random() are the three ways a script can produce a
 * different call sequence on a rerun, so under determinism they throw with the
 * fix in the message rather than silently poisoning the journal.
 */
function deterministicBindings(): Record<string, unknown> {
	const refuse = (what: string, instead: string) => () => {
		throw new WorkflowFatalError(`${what} is unavailable in a workflow script (it would break resume) — ${instead}`);
	};
	const math: Record<string, unknown> = {};
	for (const name of Object.getOwnPropertyNames(Math)) {
		math[name] = (Math as unknown as Record<string, unknown>)[name];
	}
	math.random = refuse("Math.random()", "vary the prompt or label by index instead");

	const DateProxy = new Proxy(Date, {
		construct(target, argumentList, newTarget) {
			if (argumentList.length === 0) {
				refuse("new Date()", "pass timestamps in through args")();
			}
			return Reflect.construct(target, argumentList, newTarget);
		},
		get(target, property, receiver) {
			if (property === "now") return refuse("Date.now()", "pass timestamps in through args");
			return Reflect.get(target, property, receiver);
		},
	});

	return { Math: math, Date: DateProxy };
}

export async function runWorkflowScript(
	script: string,
	args: unknown,
	hooks: EngineHooks,
	signal?: AbortSignal,
	engineOptions: EngineOptions = {},
): Promise<RunResult> {
	const { meta, body } = parseMeta(script);
	let agentCount = 0;
	let replayedCount = 0;
	/** Shared session names currently held by a running agent. */
	const activeSessions = new Set<string>();
	/** Shared sessions already explained in the log, so a chain says it once. */
	const announcedSessions = new Set<string>();

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
		const index = ++agentCount;
		const label = options.label ?? `agent ${index}`;
		const key = agentKey(prompt, options as unknown as Record<string, unknown>, hooks.keyExtras?.(options));
		const startedAt = Date.now();

		// A shared session is one conversation continued by one agent at a time.
		// Claimed BEFORE the pause so the error is immediate and
		// deterministic: whichever of two concurrent claimants arrives second
		// fails, and the run fails with it, rather than both being admitted and
		// interleaving their turns into a single transcript.
		const session = options.session;
		if (session !== undefined) {
			if (typeof session !== "string" || !session.trim()) {
				throw new WorkflowFatalError(`agent() session must be a non-empty string, got ${JSON.stringify(session)}`);
			}
			if (activeSessions.has(session)) {
				// Fatal, not a nulled agent. By the time a second agent wants the
				// session the chain's ordering is already undefined, and every later
				// link would be reading state assembled in an unknown order — wrong
				// answers that look right. Better to stop.
				throw new WorkflowFatalError(
					`two agents hold the shared session "${session}" at once. A shared session is a single conversation and must be continued sequentially — await one agent before starting the next, or give each its own name (session: \`${session}-\${index}\`) if they were meant to be independent.`,
				);
			}
			activeSessions.add(session);
		}

		try {
			// Pause first: a paused run must not race ahead through cached results
			// either, or unpausing would find the script somewhere unexpected.
			if (hooks.waitWhilePaused) await hooks.waitWhilePaused(controller.signal);
			if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");

			// Shared-session agents are NEVER replayed. Resume allocates a fresh
			// runId, so a replayed agent writes no session file into the new run —
			// a later live agent in the same chain would find nothing, quietly
			// start a new conversation, and return an answer computed without the
			// accumulated context. Replaying only when the WHOLE chain replays
			// cannot be decided in advance (pipeline() has no fixed order), so the
			// chain re-runs. Correctness over the saving; it is stated in the log
			// rather than left to be discovered from a bill.
			if (session === undefined) {
				// A replay costs nothing, so it happens outside the concurrency gate.
				const cached = hooks.replay?.(key);
				if (cached?.hit) {
					replayedCount++;
					hooks.agentStart?.(index, label, options.phase);
					hooks.agentEnd?.(index, true);
					hooks.agentSettled?.({
						index,
						key,
						label,
						phase: options.phase,
						options,
						status: "replayed",
						value: cached.value,
						startedAt,
						endedAt: Date.now(),
						attempts: 0,
					});
					return cached.value;
				}
			} else if (hooks.replay && !announcedSessions.has(session)) {
				announcedSessions.add(session);
				hooks.log(`session "${session}" is shared, so its agents re-run instead of replaying`);
			}

			return await (async () => {
				if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
				hooks.agentStart?.(index, label, options.phase);
				let ok = false;
				let value: unknown;
				let failure: string | undefined;
				// Counted here rather than returned, so a FAILED agent still reports
				// how many attempts it burned — that is exactly when you want to know.
				let attempts = 0;
				const spawnOnce = (request: string, attempt: number) => {
					attempts++;
					return hooks.spawn(request, options, index, controller.signal, attempt);
				};
				try {
					value = options.schema ? await runSchemaAgent(prompt, options, label, spawnOnce) : await spawnOnce(prompt, 0);
					ok = true;
					return value;
				} catch (error) {
					if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
					failure = error instanceof Error ? error.message : String(error);
					hooks.log(`agent ${label} failed: ${failure}`);
					return null;
				} finally {
					hooks.agentEnd?.(index, ok);
					hooks.agentSettled?.({
						index,
						key,
						label,
						phase: options.phase,
						options,
						status: ok ? "done" : "failed",
						value: ok ? value : undefined,
						error: failure,
						startedAt,
						endedAt: Date.now(),
						attempts,
					});
				}
			})();
		} finally {
			// Released on every path — success, failure, abort and the fatal
			// throws above — or one erroring agent would lock its session for the
			// rest of the run and turn a single failure into a dead chain.
			if (session !== undefined) activeSessions.delete(session);
		}
	}

	async function runSchemaAgent(
		prompt: string,
		options: AgentOptions,
		label: string,
		spawnOnce: (request: string, attempt: number) => Promise<string>,
	): Promise<unknown> {
		const schema = options.schema!;
		let request = prompt + schemaInstruction(schema);
		for (let attempt = 0; ; attempt++) {
			const reply = await spawnOnce(request, attempt);
			try {
				const value = extractJson(reply);
				if (!conformsTo(value, schema)) throw new Error("JSON did not match the schema");
				return value;
			} catch (error) {
				if (attempt >= CONFIG.schemaRetries) throw error;
				const reason = error instanceof Error ? error.message : String(error);
				hooks.log(`agent ${label}: retrying, ${reason}`);
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

	const cwd = engineOptions.cwd ?? process.cwd();

	/**
	 * Run a command on the host and hand the script its real exit code.
	 *
	 * This is the only thing in the sandbox an agent cannot author. Agents get
	 * their own bash inside their own pi process, so shell() grants no new
	 * power — it relocates existing power to where the RESULT is trustworthy.
	 * That distinction is the whole point: a workflow that gates on an agent's
	 * assertion that the tests passed is gating on prose, and we have watched
	 * that produce "17/17 passing" for an application that never started.
	 *
	 * Replayed on resume like an agent, because re-running a build is slow and
	 * re-running a mutating command is worse.
	 */
	const shell = async (command: unknown, options: unknown = {}): Promise<ShellResult> => {
		if (typeof command !== "string" || !command.trim()) {
			throw new WorkflowFatalError("shell() requires a non-empty command string");
		}
		if (!hooks.shell) {
			throw new WorkflowFatalError(
				"shell() is unavailable because this project is not trusted. Trust the project to use it as a gate, or verify some other way — do not fall back to asking an agent whether it succeeded.",
			);
		}
		if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");

		const opts = (options && typeof options === "object" ? options : {}) as ShellOptions;
		const startedAt = Date.now();
		const key = shellKey(command, cwd, opts as unknown as Record<string, unknown>);

		const cached = hooks.replay?.(key);
		if (cached?.hit) {
			const value = cached.value as ShellResult;
			hooks.shellSettled?.({ key, command, cwd, result: value, startedAt, endedAt: Date.now(), replayed: true });
			return value;
		}

		await hooks.waitWhilePaused?.(controller.signal);
		if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");

		const result = await hooks.shell(command, opts, controller.signal);
		hooks.shellSettled?.({ key, command, cwd, result, startedAt, endedAt: Date.now(), replayed: false });
		return result;
	};

	const sandbox: Record<string, unknown> = {
		agent,
		shell,
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
		...(meta.deterministic === false ? {} : deterministicBindings()),
		...(engineOptions.globals ?? {}),
	};

	// The vm timeout bounds COMPILATION only: evaluating this expression just
	// creates the closure. The body itself runs unbounded on the host event
	// loop when fn() is awaited — see the header comment.
	const fn = compileBody(body, sandbox);

	try {
		// Race the body against the abort signal: a cancelled run must settle
		// promptly even when the script is sleeping rather than awaiting an
		// agent. The body keeps running as unobserved dead code afterwards
		// (vm code cannot be preempted), but every later agent() it makes
		// throws immediately and race()'s subscription keeps its eventual
		// rejection from surfacing as a host unhandledRejection.
		const running = fn();
		const abortedRun = new Promise<never>((_resolve, reject) => {
			const fail = () => reject(new WorkflowFatalError("workflow aborted"));
			if (controller.signal.aborted) fail();
			else controller.signal.addEventListener("abort", fail, { once: true });
		});
		const result = await Promise.race([running, abortedRun]);
		if (controller.signal.aborted) throw new WorkflowFatalError("workflow aborted");
		return { meta, result, agentCount, replayedCount };
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
