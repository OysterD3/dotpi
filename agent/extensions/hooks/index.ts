/**
 * hooks — Claude Code's hooks API for pi: shell commands, HTTP endpoints or a
 * model call, run at fixed points in the agent's lifecycle, configured in
 * settings.json or hooks.json.
 *
 *   { "hooks": {
 *       "PreToolUse": [
 *         { "matcher": "Bash",
 *           "hooks": [{ "type": "command", "command": "python3 ~/.claude/hooks/bash-guard.py" }] }
 *       ] } }
 *
 * The protocol is that agent's, so a hook written for it runs here unchanged:
 * the event arrives as JSON on stdin, exit 2 blocks, and JSON on stdout decides
 * (output.ts). The one deliberate difference in what a hook is shown is the
 * tool input — see TOOL_NAMES in config.ts.
 *
 * Every event is hung on the pi signal that means the same thing, and the ones
 * with no such signal are refused at load time rather than faked (UNSUPPORTED
 * in config.ts). The mapping, and each place pi differs:
 *
 *   SessionStart        session_start (not reload), and after compaction as
 *                       source "compact". The hooks run in the background and
 *                       the first prompt waits for them, so a slow hook does
 *                       not hold the TUI's startup. Unlike Claude Code, Esc
 *                       cannot take that first prompt back during the wait.
 *   UserPromptSubmit    input, for prompts a person sent (typed or RPC) — not
 *                       ones an extension sent. Block = the prompt is dropped.
 *   PreToolUse          tool_call. deny blocks here; allow and ask are handed
 *                       to the permissions extension, which runs after this one
 *                       and decides with them (CHANNELS.decision).
 *   PermissionRequest   asked by the permissions extension just before it
 *                       would prompt (CHANNELS.request).
 *   PostToolUse(Failure) tool_result. Feedback is appended to the result.
 *   PostToolBatch       turn_end of a turn that ran tools. Block stops the agent.
 *   Stop / StopFailure  agent_before_settle: completed / error. pi offers no
 *                       abort signal there, so Esc waits for a running Stop hook.
 *   SubagentStart/Stop  the task tool starting and finishing. Observe only:
 *                       the subagent is a separate pi process run without
 *                       extensions, so these hooks do not run inside it.
 *   Notification        a permission prompt or ask_user question still open
 *                       after 6 s; 60 s idle.
 *   Pre/PostCompact     session_before_compact / session_compact.
 *   PostModelSwitch     model_select.
 *   DirectoryAdded      /add-dir (CHANNELS.workspace).
 *   SessionEnd          session_shutdown (not reload), inside a time budget.
 *
 *   config.ts     events, defaults, channel names
 *   settings.ts   loading and checking the four config files
 *   match.ts      matcher strings (pure)
 *   output.ts     reading a hook's answer; merging many (pure)
 *   run.ts        running a command, a POST, or a model call
 *   model.ts      resolving a prompt hook's model (a copy)
 */

import {
	type ExtensionAPI,
	type ExtensionContext,
	getAgentDir,
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent";
import {
	CHANNELS,
	EVENTS,
	type EventName,
	hookToolName,
	IDLE_MS,
	MATCH_FIELD,
	MESSAGE,
	MODE_EVENTS,
	SESSION_END,
	SHORT_TIMEOUT_EVENTS,
	SPEND_SOURCE,
	STOP_CAP,
	SUBAGENT_TOOL,
	TIMEOUT,
	WAITING_MS,
} from "./config.ts";
import { fromCommand, fromHttp, type HookResult, type Merged, merge, readVerdict, renderPrompt, stopFailureType } from "./output.ts";
import { runCommand, runHttp, runPrompt } from "./run.ts";
import { EMPTY, type Handler, type HookConfig, hookPaths, isObject, loadHooks, select } from "./settings.ts";

type Content = { type: string; text?: string; [key: string]: unknown };

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let config: HookConfig = EMPTY;
	let trusted = false;

	/**
	 * The latest context, for work that starts on a pi.events message rather than
	 * a pi event (notifications, /add-dir, permission requests) and so arrives
	 * without one.
	 */
	let current: ExtensionContext | undefined;

	/**
	 * False once this runtime's session ends. pi rebuilds the extension runtime
	 * on every /new, /resume, /fork and /reload, and any use of the old one's
	 * ctx or pi after that throws — so a hook that finishes late, or anything
	 * awaited across the change, must check this before touching either. An
	 * unhandled throw there is an uncaught rejection, which takes pi down.
	 */
	let alive = true;
	/** Aborted with the session: kills hooks still running, background ones included. */
	const lifetime = new AbortController();

	/** The session's starting directory: CLAUDE_PROJECT_DIR. */
	let projectDir = process.cwd();

	/** The permissions extension's mode, as it last announced it. */
	let mode: string | undefined;
	/** Whether permissions is installed — known because it announces its mode. */
	let permissionsPresent = false;

	/** SessionStart hooks, still running; the first prompt waits on this. */
	let sessionStart: Promise<void> | undefined;
	/** Context waiting for the next prompt's before_agent_start. */
	let sessionContext: string[] = [];
	let promptContext: string[] = [];
	/** PreToolUse additionalContext, held until the call's result exists to carry it. */
	const toolContext = new Map<string, string[]>();
	/** Running subagents by tool call id -> agent type. */
	const subagents = new Map<string, string>();
	/** Consecutive Stop continuations, for STOP_CAP. */
	let stopStreak = 0;
	/** Workspace directories as last announced; undefined until the first announcement. */
	let knownDirs: Set<string> | undefined;
	/** A permission prompt is open, so its midpoint re-announcement is not a second notification. */
	let promptOpen = false;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	/** A permission prompt / ask_user question still open after WAITING_MS notifies. */
	let promptTimer: ReturnType<typeof setTimeout> | undefined;
	let questionTimer: ReturnType<typeof setTimeout> | undefined;
	/** Every tool call's input object, by id, as the tool received it — for PostToolBatch. */
	const ranInputs = new Map<string, unknown>();
	let statusDepth = 0;

	const has = (event: EventName) => !config.disabled && (config.events[event]?.length ?? 0) > 0;

	/** For work nothing waits on: a failure there has nobody to report to, and must not crash pi. */
	const settle = (work: Promise<unknown>) => void work.catch(() => {});

	/**
	 * Tell the user. Without a UI (print and json modes) pi drops every notice,
	 * and a prompt a hook blocked would end the run with no word of why — so
	 * those go to stderr instead.
	 */
	function tell(ctx: ExtensionContext, text: string, level: "info" | "warning" = "warning"): void {
		if (!alive) return;
		if (ctx.hasUI) ctx.ui.notify(text, level);
		else console.error(text);
	}

	/**
	 * Fire one event: pick the handlers its matcher selects, run them all in
	 * parallel, and fold their answers. Background (`async`) commands start and
	 * are not waited for. Messages meant for the user are shown here, so every
	 * caller only has to act on the decision.
	 */
	async function fire(
		event: EventName,
		ctx: ExtensionContext,
		fields: Record<string, unknown>,
		options: { signal?: AbortSignal; capMs?: number } = {},
	): Promise<Merged | undefined> {
		if (!has(event)) return undefined;
		const field = MATCH_FIELD[event];
		const handlers = select(config.events[event], field ? String(fields[field] ?? "") : "");
		if (handlers.length === 0) return undefined;

		const json = serialize({
			session_id: ctx.sessionManager.getSessionId(),
			transcript_path: ctx.sessionManager.getSessionFile() ?? null,
			cwd: ctx.cwd,
			hook_event_name: event,
			...(MODE_EVENTS.has(event) && mode !== undefined ? { permission_mode: mode } : {}),
			...fields,
		});

		const waited: Handler[] = [];
		for (const handler of handlers) {
			if (handler.type === "command" && handler.async) settle(runBackground(handler, event, json, ctx));
			else waited.push(handler);
		}
		if (waited.length === 0) return undefined;

		const signal = options.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal;
		const status = waited.find((handler) => handler.statusMessage)?.statusMessage;
		if (status !== undefined) showStatus(ctx, status);
		try {
			const results = await Promise.all(waited.map((handler) => runOne(handler, event, json, ctx, { ...options, signal })));
			if (!alive) return undefined;
			const merged = merge(event, results);
			for (const line of merged.toUser) tell(ctx, line);
			// Written straight to the terminal, as elapsed writes its bell. Only in
			// the TUI: in other modes stdout is the output, not a screen.
			if (ctx.mode === "tui") for (const sequence of merged.terminal) process.stdout.write(sequence);
			return merged;
		} finally {
			if (status !== undefined && alive) hideStatus(ctx);
		}
	}

	async function runOne(
		handler: Handler,
		event: EventName,
		json: string,
		ctx: ExtensionContext,
		options: { signal?: AbortSignal; capMs?: number },
	): Promise<HookResult> {
		// SessionEnd's own default is its budget: raising the shared budget with
		// one hook's timeout does not lend that time to the hooks without one.
		const defaultMs =
			event === "SessionEnd"
				? SESSION_END.budgetMs
				: (handler.type === "prompt" ? TIMEOUT.prompt : SHORT_TIMEOUT_EVENTS.has(event) ? TIMEOUT.short : TIMEOUT[handler.type]) * 1000;
		const timeoutMs = Math.min(handler.timeout !== undefined ? handler.timeout * 1000 : defaultMs, options.capMs ?? Number.POSITIVE_INFINITY);
		const seconds = timeoutMs % 1000 === 0 ? String(timeoutMs / 1000) : (timeoutMs / 1000).toFixed(1);

		if (handler.type === "command") {
			const label = clip(handler.args ? [handler.command, ...handler.args].join(" ") : handler.command);
			// Claude Code enforces no timeout on an async hook; the session's end
			// (the lifetime signal) is what stops one.
			const deadline = handler.async ? undefined : timeoutMs;
			const run = await runCommand(handler, json, { cwd: ctx.cwd, projectDir, timeoutMs: deadline, signal: options.signal });
			if (run.spawnError !== undefined) return { label, error: `could not start: ${run.spawnError}` };
			// A timeout decides nothing — on PreToolUse the call goes on to the
			// permission check as if the hook were absent, as in Claude Code.
			if (run.timedOut) return { label, error: `timed out after ${seconds}s` };
			// Interrupted with the turn or session it belonged to; nothing to report.
			if (run.aborted) return { label };
			return fromCommand(label, run.code, run.stdout, run.stderr, event);
		}

		if (handler.type === "http") {
			const label = clip(handler.url);
			const run = await runHttp(handler, json, timeoutMs, options.signal);
			if (run.timedOut) return { label, error: `timed out after ${seconds}s` };
			if (options.signal?.aborted) return { label };
			if (run.error !== undefined || run.status === undefined) return { label, error: run.error ?? "no response" };
			return fromHttp(label, run.status, run.body ?? "", event);
		}

		const label = `prompt${handler.model ? ` on ${handler.model}` : ""}`;
		const reply = await runPrompt(ctx, handler, renderPrompt(handler.prompt, json), timeoutMs, options.signal, (spend) => {
			pi.events.emit(CHANNELS.spend, { source: SPEND_SOURCE, usage: spend, calls: 1 });
		});
		if (reply.error !== undefined) return options.signal?.aborted ? { label } : { label, error: reply.error };
		const verdict = readVerdict(reply.text ?? "");
		if ("error" in verdict) return { label, error: verdict.error };
		return { label, verdict: { ...verdict, continueOnBlock: handler.continueOnBlock } };
	}

	/**
	 * An `async` command: not waited for, and its decision fields mean nothing.
	 * What it can still do is leave the model a note — additionalContext and
	 * systemMessage reach the model with its next request, in the same run if
	 * the agent is still working.
	 */
	async function runBackground(handler: Handler, event: EventName, json: string, ctx: ExtensionContext): Promise<void> {
		const result = await runOne(handler, event, json, ctx, { signal: lifetime.signal });
		if (!alive) return;
		if (result.error !== undefined) {
			tell(ctx, `${event} hook error (${result.label}): ${result.error}`);
			return;
		}
		const notes = [result.output?.hookSpecificOutput?.additionalContext, result.output?.systemMessage].filter(
			(note): note is string => typeof note === "string" && note.trim().length > 0,
		);
		inject(ctx, event, notes);
	}

	function showStatus(ctx: ExtensionContext, text: string): void {
		if (!ctx.hasUI) return;
		statusDepth++;
		ctx.ui.setWorkingMessage(text);
	}

	function hideStatus(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		statusDepth = Math.max(0, statusDepth - 1);
		if (statusDepth === 0) ctx.ui.setWorkingMessage();
	}

	/**
	 * `continue: false`: stop the agent as Esc would. The reason is shown, and
	 * kept in the transcript (unless the caller records it itself) so the model
	 * can say why it stopped if the conversation goes on.
	 */
	function halt(ctx: ExtensionContext, reason: string, record = true): void {
		tell(ctx, `Stopped by a hook: ${reason}`);
		if (record) pi.sendMessage({ customType: MESSAGE.notice, content: `A hook stopped the agent: ${reason}`, display: true }, { triggerTurn: false });
		ctx.abort();
	}

	/**
	 * Hand the model context outside the prompt path. Idle, it rides the next
	 * prompt; mid-run, it is flushed at the turn's end and the next request in
	 * the same run carries it. Both were checked against pi, and the obvious
	 * alternative — an idle append — lands ahead of the system prompt on a fresh
	 * session, which some providers then drop.
	 */
	function inject(ctx: ExtensionContext, event: EventName, lines: string[]): void {
		if (lines.length === 0 || !alive) return;
		if (ctx.isIdle()) pi.sendMessage(contextMessage(event, lines), { deliverAs: "nextTurn" });
		else pi.sendMessage(contextMessage(event, lines), { triggerTurn: false });
	}

	function notification(type: string, message: string, title: string): void {
		const ctx = current;
		if (!ctx || !alive || !has("Notification")) return;
		settle(fire("Notification", ctx, { message, title, notification_type: type }));
	}

	function cancelIdle(): void {
		if (idleTimer !== undefined) clearTimeout(idleTimer);
		idleTimer = undefined;
	}

	// Every other handler below opens with `if (!alive) return`. On quit pi tears
	// the session down without waiting for the run to unwind, so the aborted
	// run's last tool_result, turn_end and agent_settled still arrive here —
	// with a ctx that throws on first touch.

	/** The session SessionStart last fired for; see the duplicate check below. */
	let startedFor: string | undefined;

	pi.on("session_start", (event, ctx) => {
		// pi 0.87.1's RPC new_session emits session_start twice for one session,
		// which would run every SessionStart hook, and send its context, twice.
		const id = ctx.sessionManager.getSessionId();
		if (event.reason !== "reload" && startedFor === id) return;
		startedFor = id;
		current = ctx;
		projectDir = ctx.cwd;
		// pi's own isProjectTrusted() is true for a repository whose only project
		// file is .pi/hooks.json, because that file is not on pi's list of
		// trust-requiring resources. So hooks demand more: trust that was actually
		// decided — either pi had a reason to ask, or the project is in trust.json.
		let trustProblem: string | undefined;
		try {
			trusted =
				ctx.isProjectTrusted() &&
				(hasTrustRequiringProjectResources(ctx.cwd) || new ProjectTrustStore(agentDir).get(ctx.cwd) === true);
		} catch (error) {
			// An unreadable trust.json costs the project's hooks, never the user's own.
			trusted = false;
			trustProblem = `project hooks are off: the trust store could not be read (${error instanceof Error ? error.message : String(error)})`;
		}
		config = loadHooks(agentDir, ctx.cwd, trusted);
		if (trustProblem) config.warnings.push(trustProblem);
		if (config.warnings.length > 0) tell(ctx, `Hooks:\n${config.warnings.join("\n")}`);

		// A reload rebuilds pi's runtime inside a session that already started.
		if (event.reason === "reload" || !has("SessionStart")) return;
		const resumed = ctx.sessionManager.getEntries().some((entry) => entry.type === "message");
		const source =
			event.reason === "startup" ? (resumed ? "resume" : "startup") : event.reason === "new" ? "clear" : event.reason;
		sessionStart = fire("SessionStart", ctx, { source, model: ctx.model?.id })
			.then((merged) => {
				if (!merged || !alive) return;
				// Claude Code applies a title on startup, resume and fork, not on clear.
				if (merged.sessionTitle && source !== "clear") pi.setSessionName(merged.sessionTitle);
				if (merged.context.length > 0) sessionContext.push(formatContext("SessionStart", merged.context));
			})
			.catch(() => {});
	});

	pi.on("input", async (event, ctx) => {
		if (!alive) return undefined;
		current = ctx;
		cancelIdle();
		promptContext = [];
		if (event.source === "extension") return undefined;

		// No turn signal. A prompt typed while the agent works outlives the turn
		// that is running, and Esc on that turn would kill the check and let the
		// prompt through unchecked — the guard failing open.
		const merged = await fire("UserPromptSubmit", ctx, { prompt: event.text });
		if (!merged) return undefined;
		const refusal = merged.halt ?? merged.block;
		if (refusal !== undefined) {
			// To the user only: Claude Code keeps a blocked prompt's reason out of
			// the model's context, and so does this — the prompt never existed.
			tell(ctx, `Prompt blocked by a UserPromptSubmit hook: ${refusal}`);
			return { action: "handled" as const };
		}
		if (merged.sessionTitle) pi.setSessionName(merged.sessionTitle);
		if (merged.context.length > 0) {
			const text = formatContext("UserPromptSubmit", merged.context);
			// A prompt typed while the agent works is queued, not started, and
			// before_agent_start will not fire for it; the context queues with it.
			if (event.streamingBehavior) pi.sendMessage(contextMessage("UserPromptSubmit", merged.context), { deliverAs: event.streamingBehavior });
			else promptContext = [text];
		}
		return undefined;
	});

	pi.on("before_agent_start", async () => {
		if (!alive) return undefined;
		stopStreak = 0;
		if (sessionStart) {
			await sessionStart;
			sessionStart = undefined;
		}
		const lines = [...sessionContext, ...promptContext];
		sessionContext = [];
		promptContext = [];
		if (lines.length === 0) return undefined;
		return { message: { customType: MESSAGE.context, content: lines.join("\n\n"), display: false } };
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!alive) return undefined;
		current = ctx;
		// By reference: a rewrite below, or by permissions, is what PostToolBatch must see.
		ranInputs.set(event.toolCallId, event.input);
		const name = hookToolName(event.toolName);
		const merged = await fire("PreToolUse", ctx, { tool_name: name, tool_input: event.input, tool_use_id: event.toolCallId }, { signal: ctx.signal });
		if (!merged) return undefined;

		if (merged.halt !== undefined) {
			halt(ctx, merged.halt);
			return { block: true, reason: merged.halt };
		}
		if (merged.permission === "deny") {
			// A blocked call gets no tool_result to carry the context, so it rides the reason.
			const reason = merged.permissionReason || "Blocked by a PreToolUse hook";
			return { block: true, reason: merged.context.length > 0 ? `${reason}\n\n${formatContext("PreToolUse", merged.context)}` : reason };
		}
		if (merged.context.length > 0) toolContext.set(event.toolCallId, merged.context);
		// In place: pi hands the same object to the tool, and replacing the
		// reference would change nothing. Not re-validated against the schema —
		// pi does not re-validate after tool_call either.
		if (merged.updatedInput) replaceInput(event.input as Record<string, unknown>, merged.updatedInput);

		if (merged.permission === "allow" || merged.permission === "ask") {
			const reason = merged.permissionReason ?? "";
			// permissions loads after this extension, so its tool_call handler for
			// this same call has not run yet and will read this before deciding.
			if (permissionsPresent) {
				pi.events.emit(CHANNELS.decision, { toolCallId: event.toolCallId, decision: merged.permission, reason });
				return undefined;
			}
			// Without permissions there is nothing an allow could skip, but an ask
			// must still ask — silently dropping it would turn a guard into a pass.
			if (merged.permission === "ask") return confirmCall(ctx, name, event.input, reason);
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (!alive) return undefined;
		current = ctx;
		const held = toolContext.get(event.toolCallId);
		toolContext.delete(event.toolCallId);

		const hookEvent = event.isError ? "PostToolUseFailure" : "PostToolUse";
		const name = hookToolName(event.toolName);
		const fields = event.isError
			? { tool_name: name, tool_input: event.input, tool_use_id: event.toolCallId, error: textOf(event.content) }
			: {
					tool_name: name,
					tool_input: event.input,
					tool_response: { content: withoutImageData(event.content), details: event.details },
					tool_use_id: event.toolCallId,
				};
		const merged = await fire(hookEvent, ctx, fields, { signal: ctx.signal });
		if (merged?.halt !== undefined) halt(ctx, merged.halt);

		const notes = [
			...(held !== undefined ? [formatContext("PreToolUse", held)] : []),
			...(merged?.toModel.map((text) => `${hookEvent} hook feedback:\n${text}`) ?? []),
			...(merged && merged.context.length > 0 ? [formatContext(hookEvent, merged.context)] : []),
		];
		let content = event.content as Content[];
		let changed = false;
		if (merged?.updatedOutput !== undefined) {
			const replaced = toContent(merged.updatedOutput);
			if (replaced) {
				content = replaced;
				changed = true;
			} else {
				tell(ctx, `${hookEvent} hook: updatedToolOutput must be a string or an array of content blocks — ignored`);
			}
		}
		if (notes.length > 0) {
			content = [...content, { type: "text", text: notes.join("\n\n") }];
			changed = true;
		}
		return changed ? { content: content as typeof event.content } : undefined;
	});

	pi.on("tool_execution_update", (event, ctx) => {
		if (!alive) return undefined;
		if (event.toolName !== SUBAGENT_TOOL || subagents.has(event.toolCallId)) return;
		// The task tool's first update is the moment the subagent is launched —
		// after every tool_call handler, permissions included, has let it through.
		const details = (event.partialResult as { details?: { subagent?: unknown } } | undefined)?.details;
		const requested = (event.args as { subagent_type?: unknown } | undefined)?.subagent_type;
		const type = typeof details?.subagent === "string" ? details.subagent : typeof requested === "string" && requested ? requested : "one-time";
		subagents.set(event.toolCallId, type);
		settle(fire("SubagentStart", ctx, { agent_id: event.toolCallId, agent_type: type }));
	});

	pi.on("tool_execution_end", (event, ctx) => {
		if (!alive) return undefined;
		// Context still held here belongs to a call that ended with no result —
		// permissions blocked it after the hook allowed or asked. It is delivered
		// on its own rather than lost.
		const held = toolContext.get(event.toolCallId);
		toolContext.delete(event.toolCallId);
		if (held !== undefined) inject(ctx, "PreToolUse", held);
		const type = subagents.get(event.toolCallId);
		if (type === undefined) return;
		subagents.delete(event.toolCallId);
		settle(
			fire("SubagentStop", ctx, {
				stop_hook_active: false,
				agent_id: event.toolCallId,
				agent_type: type,
				agent_transcript_path: null,
				last_assistant_message: textOf((event.result as { content?: unknown } | undefined)?.content),
			}),
		);
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!alive) return undefined;
		// The input each call RAN with. pi's saved toolCall arguments keep what the
		// model asked for, which a PreToolUse rewrite may have changed.
		const ran = new Map(event.toolResults.map((result) => [result.toolCallId, ranInputs.get(result.toolCallId)]));
		for (const result of event.toolResults) ranInputs.delete(result.toolCallId);
		if (event.toolResults.length === 0 || !has("PostToolBatch")) return undefined;
		const inputs = new Map<string, unknown>();
		const message = event.message as { role?: string; content?: unknown };
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const block of message.content as { type?: string; id?: string; arguments?: unknown }[]) {
				if (block.type === "toolCall" && typeof block.id === "string") inputs.set(block.id, block.arguments);
			}
		}
		const merged = await fire(
			"PostToolBatch",
			ctx,
			{
				tool_calls: event.toolResults.map((result) => ({
					tool_name: hookToolName(result.toolName),
					tool_input: ran.get(result.toolCallId) ?? inputs.get(result.toolCallId) ?? {},
					tool_use_id: result.toolCallId,
					tool_response: textOf(result.content),
				})),
			},
			{ signal: ctx.signal },
		);
		if (!merged) return undefined;

		const stop = merged.halt ?? merged.block;
		if (stop !== undefined) {
			// pi has no "end the loop here" result for turn_end, so this stops the
			// agent the way Esc does. The reason is kept in the transcript, where
			// the model reads it if the conversation goes on.
			halt(ctx, stop, false);
			return {
				entries: [...event.entries, { type: "custom_message" as const, customType: MESSAGE.notice, content: `A PostToolBatch hook stopped the agent: ${stop}`, display: true }],
			};
		}
		if (merged.context.length === 0) return undefined;
		return {
			entries: [...event.entries, { type: "custom_message" as const, customType: MESSAGE.context, content: formatContext("PostToolBatch", merged.context), display: false }],
		};
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (!alive) return undefined;
		const messages = event.context.contextMessages as { role?: string; content?: unknown; errorMessage?: string }[];
		const last = [...messages].reverse().find((message) => message.role === "assistant");

		if (event.outcome === "error") {
			stopStreak = 0;
			const detail = last?.errorMessage?.trim() ?? "";
			settle(
				fire("StopFailure", ctx, {
					error: stopFailureType(detail),
					error_details: detail,
					last_assistant_message: detail ? `API Error: ${detail}` : "",
				}),
			);
			return undefined;
		}
		if (event.outcome !== "completed" || !has("Stop")) return undefined;

		const merged = await fire("Stop", ctx, { stop_hook_active: stopStreak > 0, last_assistant_message: textOf(last?.content) });
		if (merged?.halt !== undefined) {
			stopStreak = 0;
			tell(ctx, `Stopped by a Stop hook: ${merged.halt}`);
			return {
				entries: [...event.entries, { type: "custom_message" as const, customType: MESSAGE.notice, content: `A Stop hook stopped the agent: ${merged.halt}`, display: true }],
			};
		}
		const feedback = merged ? [...(merged.block !== undefined ? [merged.block] : []), ...merged.context] : [];
		if (feedback.length === 0) {
			stopStreak = 0;
			return undefined;
		}
		// pi fires this again after every continuation and has no limit of its own.
		// Past the cap the hooks still run — their side effects belong to this stop
		// too — but their request to keep going is overruled.
		if (stopStreak >= STOP_CAP) {
			tell(ctx, `Stop hooks kept the agent going ${STOP_CAP} times in a row — letting it stop.`);
			stopStreak = 0;
			return undefined;
		}
		stopStreak++;
		return {
			entries: [
				...event.entries,
				{ type: "custom_message" as const, customType: MESSAGE.stop, content: `Stop hook feedback:\n${feedback.join("\n\n")}`, display: true },
			],
			continue: true,
		};
	});

	pi.on("agent_start", () => {
		if (alive) cancelIdle();
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (!alive) return undefined;
		// Once per run, aborted and failed ones included — the one reset point
		// every path reaches. A run started by an extension message never fires
		// before_agent_start, so resetting only there leaked a streak into it.
		stopStreak = 0;
		ranInputs.clear();
		cancelIdle();
		if (!ctx.hasUI || !has("Notification")) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			notification("idle_prompt", "pi is waiting for your input", "Waiting for input");
		}, IDLE_MS);
		idleTimer.unref();
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (!alive) return undefined;
		const trigger = event.reason === "manual" ? "manual" : "auto";
		const merged = await fire("PreCompact", ctx, { trigger, custom_instructions: event.customInstructions ?? null }, { signal: event.signal });
		if (merged?.block === undefined) return undefined;
		tell(ctx, `Compaction blocked by a PreCompact hook: ${merged.block}`);
		return { cancel: true };
	});

	pi.on("session_compact", async (event, ctx) => {
		if (!alive) return undefined;
		const trigger = event.reason === "manual" ? "manual" : "auto";
		await fire("PostCompact", ctx, { trigger, compact_summary: event.compactionEntry.summary });
		if (!alive) return undefined;
		// Claude Code's way to re-inject what compaction dropped: SessionStart,
		// matcher "compact".
		const merged = await fire("SessionStart", ctx, { source: "compact", model: ctx.model?.id });
		if (merged) inject(ctx, "SessionStart", merged.context);
	});

	pi.on("model_select", (event, ctx) => {
		if (!alive) return undefined;
		// pi's "set" is /model, the picker or an extension; "cycle" is the cycling
		// key. Claude Code's vocabulary is the nearest honest fit.
		const source = event.source === "cycle" ? "picker" : event.source === "restore" ? "resume" : "command";
		settle(
			fire("PostModelSwitch", ctx, {
				from_model: event.previousModel?.id ?? null,
				to_model: event.model.id,
				requested_model: event.model.id,
				source,
			}).then((merged) => {
				if (merged) inject(ctx, "PostModelSwitch", merged.context);
			}),
		);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (!alive) return undefined;
		cancelIdle();
		clearTimeout(promptTimer);
		clearTimeout(questionTimer);
		if (event.reason !== "reload" && has("SessionEnd")) {
			const reason = event.reason === "quit" ? "prompt_input_exit" : event.reason === "new" ? "clear" : event.reason === "resume" ? "resume" : "other";
			// pi waits for this with no limit, so the budget is what keeps /quit quick.
			const longest = Math.max(0, ...select(config.events.SessionEnd, reason).map((handler) => (handler.timeout ?? 0) * 1000));
			const capMs = Math.min(Math.max(SESSION_END.budgetMs, longest), SESSION_END.maxMs);
			await fire("SessionEnd", ctx, { reason }, { capMs });
		}
		// Last: SessionEnd needed the session. Hooks still running now — background
		// ones, a notification — belong to a session that is over; nothing they
		// return can land, and left alone they would outlive pi itself.
		alive = false;
		lifetime.abort();
	});

	pi.events.on(CHANNELS.mode, (data) => {
		const announced = (data as { mode?: unknown } | undefined)?.mode;
		if (typeof announced !== "string") return;
		mode = announced;
		permissionsPresent = true;
	});

	pi.events.on(CHANNELS.ask, (data) => {
		// permissions repeats the announcement at the prompt's timeout midpoint for
		// notifiers that missed it; one wait is one notification.
		if (promptOpen) return;
		promptOpen = true;
		const tool = (data as { tool?: unknown } | undefined)?.tool;
		const message = `pi needs your permission to use ${typeof tool === "string" ? hookToolName(tool) : "a tool"}`;
		promptTimer = setTimeout(() => notification("permission_prompt", message, "Permission needed"), WAITING_MS);
		promptTimer.unref();
	});

	pi.events.on(CHANNELS.answered, () => {
		promptOpen = false;
		clearTimeout(promptTimer);
	});

	pi.events.on(CHANNELS.question, (data) => {
		const question = data as { active?: unknown; blocking?: unknown; question?: unknown; header?: unknown } | undefined;
		clearTimeout(questionTimer);
		// `blocking: false` is the /ask-user test demo, which the user just asked for.
		if (!question?.active || !question.blocking) return;
		const message = typeof question.question === "string" ? question.question : "pi has a question for you";
		const title = typeof question.header === "string" ? question.header : "Question";
		questionTimer = setTimeout(() => notification("agent_needs_input", message, title), WAITING_MS);
		questionTimer.unref();
	});

	pi.events.on(CHANNELS.workspace, (data) => {
		const listed = (data as { dirs?: unknown } | undefined)?.dirs;
		if (!Array.isArray(listed)) return;
		const dirs = listed.filter((dir): dir is string => typeof dir === "string");
		// The first announcement is the session's starting list — persisted
		// directories, not ones added now — the way Claude Code does not fire for
		// --add-dir at launch.
		const before = knownDirs;
		knownDirs = new Set(dirs);
		const ctx = current;
		if (before === undefined || !ctx) return;
		for (const directory of dirs.filter((dir) => !before.has(dir))) {
			settle(
				fire("DirectoryAdded", ctx, { directory, source: "slash_command" }).then((merged) => {
					if (merged) inject(ctx, "DirectoryAdded", merged.context);
				}),
			);
		}
	});

	/**
	 * PermissionRequest. The bus does not wait for a listener, so the answer
	 * travels back as a promise placed on the message before this returns —
	 * synchronously, since the emitter reads the slot the moment emit() returns.
	 */
	pi.events.on(CHANNELS.request, (data) => {
		const ctx = current;
		if (!ctx || !isObject(data) || !has("PermissionRequest")) return;
		const tool = typeof data.tool === "string" ? data.tool : "";
		data.reply = fire("PermissionRequest", ctx, { tool_name: hookToolName(tool), tool_input: data.input ?? {} }, { signal: ctx.signal })
			.then((merged) => {
				if (merged?.halt !== undefined) {
					halt(ctx, merged.halt);
					return { behavior: "deny", message: merged.halt };
				}
				return merged?.request;
			})
			.catch(() => undefined);
	});

	pi.registerCommand("hooks", {
		description: "List the hooks loaded for this session",
		handler: async (_args, ctx) => {
			const lines: string[] = [];
			if (config.disabled) lines.push("All hooks are OFF — disableAllHooks is true.", "");
			for (const event of EVENTS) {
				const groups = config.events[event];
				if (!groups || groups.length === 0) continue;
				lines.push(event);
				for (const group of groups) {
					for (const handler of group.handlers) {
						lines.push(`  ${group.matcherText ? `${group.matcherText}  ` : ""}${describe(handler)}`);
					}
				}
			}
			if (lines.length === 0) lines.push("No hooks loaded.");
			const paths = hookPaths(agentDir, ctx.cwd);
			lines.push(
				"",
				`User files:     ${paths.userSettings}, ${paths.userHooks}`,
				`Project files:  ${paths.projectSettings}, ${paths.projectHooks}${trusted ? "" : " (not loaded: project not trusted)"}`,
				`Loaded from:    ${config.sources.length > 0 ? config.sources.join(", ") : "nothing"}`,
			);
			if (config.warnings.length > 0) lines.push("", "Warnings:", ...config.warnings.map((warning) => `  ${warning}`));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}

async function confirmCall(ctx: ExtensionContext, name: string, input: unknown, reason: string) {
	if (!ctx.hasUI) {
		return { block: true, reason: `A PreToolUse hook asked for approval${reason ? ` (${reason})` : ""} and there is no interactive session to give it` };
	}
	const approved = await ctx.ui.confirm(`Approve ${name}?`, `${reason || "A PreToolUse hook asked to confirm this call."}\n\n${clip(serialize(input), 400)}`);
	return approved ? undefined : { block: true, reason: `Denied by the user${reason ? ` — ${reason}` : ""}` };
}

function replaceInput(target: Record<string, unknown>, next: Record<string, unknown>): void {
	for (const key of Object.keys(target)) delete target[key];
	Object.assign(target, next);
}

function contextMessage(event: EventName, lines: string[]) {
	return { customType: MESSAGE.context, content: formatContext(event, lines), display: false };
}

function formatContext(event: EventName, lines: string[]): string {
	return `${event} hook additional context:\n${lines.join("\n\n")}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } => isObject(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n");
}

/** Images keep their type and mime type; the base64 payload is not a hook's business. */
function withoutImageData(content: unknown): unknown {
	if (!Array.isArray(content)) return content;
	return content.map((block) => (isObject(block) && block.type === "image" ? { type: "image", mimeType: block.mimeType } : block));
}

/** updatedToolOutput: a string, or pi content blocks. */
function toContent(value: unknown): Content[] | undefined {
	if (typeof value === "string") return [{ type: "text", text: value }];
	if (Array.isArray(value) && value.every((block) => isObject(block) && (block.type === "text" || block.type === "image"))) {
		return value as Content[];
	}
	return undefined;
}

function describe(handler: Handler): string {
	if (handler.type === "command") {
		const line = handler.args ? [handler.command, ...handler.args].join(" ") : handler.command;
		return `[command${handler.async ? ", async" : ""}] ${line}`;
	}
	if (handler.type === "http") return `[http] POST ${handler.url}`;
	return `[prompt${handler.model ? `, ${handler.model}` : ""}] ${clip(handler.prompt.replace(/\s+/g, " "), 80)}`;
}

function clip(text: string, max = 60): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Tool details can hold anything. A value JSON cannot represent — a cycle, a
 * bigint — is written as a placeholder, so the hook still runs and still sees
 * everything else.
 */
function serialize(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "null";
	} catch {
		// Only a true back-reference — an object among its own ancestors — is a
		// cycle; the same object reached twice by different paths is kept.
		const ancestors: unknown[] = [];
		return (
			JSON.stringify(value, function (this: unknown, _key, inner: unknown) {
				if (typeof inner === "bigint") return String(inner);
				if (typeof inner !== "object" || inner === null) return inner;
				while (ancestors.length > 0 && ancestors[ancestors.length - 1] !== this) ancestors.pop();
				if (ancestors.includes(inner)) return "[Circular]";
				ancestors.push(inner);
				return inner;
			}) ?? "null"
		);
	}
}
