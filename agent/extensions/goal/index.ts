/**
 * /goal — set an objective pi keeps working toward before it is allowed to stop.
 *
 * The natural shape for this is a session-scoped **stop hook**: when the agent
 * tries to stop, a separate tool-less LLM call judges the transcript against the
 * condition and either lets it stop or blocks with a reason fed back to the agent,
 * and the goal auto-clears when met.
 *
 * pi has no stop hook, and no event that can veto the end of a run — the closest
 * are `agent_end` and `agent_settled`, and neither handler's return value is read.
 * So the block is expressed the way pi's own shipped example does it: evaluate on
 * `agent_end`, and on "not met" deliver a follow-up message, which resumes the
 * agent. The observable behaviour is the same; the mechanism is pi-native.
 *
 *   prompts.ts     evaluator, extraction and instruction prompts
 *   judge.ts       the evaluator + extraction LLM calls, model selection, parsing
 *   capture.ts     when an "input" event is worth an autoCapture attempt (pure)
 *   transcript.ts  session branch -> budgeted transcript text (pure)
 *   state.ts       active goal, iteration count, session persistence
 *   render.ts      TUI panels and summary text (pure)
 *   settings.ts    the `goal` settings block
 *   model.ts       resolving `goal.model` the way pi resolves `--model`
 *   config.ts      limits and timeouts
 *
 * Cost note: every stop attempt while a goal is active costs one extra LLM call
 * carrying up to half the context window. Set `goal.model` to a small, fast model
 * to keep that cheap, or the session model judges its own work.
 *
 * Two gaps closed after an A/B benchmark traced a runaway session to this
 * extension sitting unused:
 *
 *   - `goal.autoCapture` (default off): a session that never runs `/goal` gets
 *     no stop-gate at all, which is exactly what happened — a request with
 *     explicit acceptance criteria ran to a bad result with nothing checking it
 *     against them. When on, the first work-opening interactive prompt of a
 *     session, with no goal already active, gets one extraction call (judge.ts's
 *     extractCriteria) asking whether the message itself states measurable
 *     criteria; a non-null answer is registered exactly the way `/goal
 *     <condition>` would be.
 *   - Compaction and `/resume` reassertion: a goal set early can have the
 *     message that told the model about it summarized away by a later
 *     compaction, or restored from a custom entry the model never sees (custom
 *     entries do not enter LLM context — see state.ts). Either event arms a
 *     pending flag; the next `before_agent_start` spends it on one hidden
 *     reminder, so the condition survives both without costing anything on
 *     turns where neither happened.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isCaptureCandidate } from "./capture.ts";
import { CONFIG } from "./config.ts";
import { evaluate, extractCriteria, selectModel, type SpendReport } from "./judge.ts";
import { goalSetInstruction, notMetInstruction, reassertInstruction, systemReminder } from "./prompts.ts";
import {
	type GoalMessageDetails,
	type GoalResultDetails,
	renderGoalMessage,
	renderGoalResult,
	summaryLine,
} from "./render.ts";
import { DEFAULTS, type GoalSettings, loadSettings } from "./settings.ts";
import { goalElapsed, GoalState, restoreGoal, tokensSpent } from "./state.ts";

const GOAL_MESSAGE = "goal";
const GOAL_RESULT = "goal_result";
/** customType on the hidden compaction/resume reassertion message — see before_agent_start below. */
const GOAL_REASSERT = "goal_reassert";

/**
 * pi.events channel for announcing model spend, shared by every extension that
 * bills money (the `usage` extension keeps the tally and `/usage` prints it).
 * A literal string rather than an import: each extension here installs on its
 * own, so the two sides share a channel name, not a module. With no subscriber
 * the event goes nowhere.
 */
const SPEND_CHANNEL = "usage:spend";

export default function (pi: ExtensionAPI) {
	const state = new GoalState(pi);
	const agentDir = getAgentDir();
	let settings: GoalSettings = { ...DEFAULTS };

	/** One evaluator (or extractor) call's spend, announced as an increment. */
	const announce = (spend: SpendReport) => pi.events.emit(SPEND_CHANNEL, { source: "goal", usage: spend, calls: 1 });

	/**
	 * autoCapture's one-shot: set on the "input" hook, consumed on
	 * before_agent_start for the same turn — the pattern ask-user's opening
	 * nudge uses for the same reason (nudge.ts). `captureTried` closes the
	 * window for the rest of the session the first time a candidate prompt is
	 * seen, whether or not it turns into a goal; without it, a session that
	 * opens with small talk before the real request would get one attempt per
	 * message instead of one attempt, period.
	 */
	let captureThisTurn = false;
	let captureText = "";
	let captureTried = false;

	pi.registerMessageRenderer<GoalMessageDetails>(GOAL_MESSAGE, (message, _options, theme) =>
		message.details ? renderGoalMessage(message.details, theme) : undefined,
	);

	pi.registerEntryRenderer<GoalResultDetails>(GOAL_RESULT, (entry, _options, theme) =>
		entry.data ? renderGoalResult(entry.data, theme) : undefined,
	);

	/**
	 * Warn now if `goal.model` names nothing resolvable.
	 *
	 * Left to evaluation time, a typo turns every stop attempt into a failed
	 * check: the goal never blocks, never caps and never clears, and the only
	 * signal is a warning that arrives once per stop, long after the file was
	 * edited. Resolution is a synchronous registry lookup, so it costs nothing
	 * to answer at load. (Credentials still can't be checked here — that needs
	 * an async call — so an auth failure remains an evaluation-time error.)
	 */
	const checkModel = (ctx: ExtensionContext) => {
		if (!settings.model) return;
		const selected = selectModel(ctx, settings.model);
		if ("error" in selected) ctx.ui.notify(`goal.model is unusable: ${selected.error}`, "warning");
	};

	// A goal outlives the process: /resume must not silently drop it.
	pi.on("session_start", (_event, ctx) => {
		const { settings: loaded, warnings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		settings = loaded;
		for (const warning of warnings) ctx.ui.notify(warning, "warning");
		checkModel(ctx);
		state.adopt(restoreGoal(ctx.sessionManager.getBranch()));

		// autoCapture's one-shot is scoped to "a session". In the CLI, pi
		// re-runs every extension factory on each session replacement (/new,
		// /resume, /reload, fork all build a fresh DefaultResourceLoader and
		// re-await factory(pi) — see loadExtensionsCached in pi dist's
		// core/extensions/loader.js), so this closure never actually survives
		// past the session it was built for there and this reset is a no-op in
		// practice. It earns its keep for the SDK: createAgentSession() lets a
		// caller construct its own DefaultResourceLoader and pass it in as
		// `resourceLoader` across several createAgentSession() calls (see pi
		// dist's core/sdk.js) — that loader's extensions are computed once, in
		// reload(), and just handed to every session built from it, so THAT
		// closure genuinely does outlive a single session. Without a reset here,
		// such an embedder's second session would inherit whether the first had
		// already spent its attempt.
		captureThisTurn = false;
		captureText = "";
		captureTried = false;

		// A goal just restored from disk is exactly the case state.ts's own
		// header comment describes: the model has no other way to see it,
		// because custom entries never enter LLM context. Reassert on the next
		// turn rather than trusting whatever the visible history still contains
		// — which may itself have been compacted away already.
		state.markPendingReassertion();
	});

	// Judged on the text as typed, before command expansion, and only for a
	// fresh interactive prompt — mirrors ask-user's nudge.ts, which the same
	// comment there explains: a prompt steered into a running turn never
	// reaches before_agent_start, so it must not spend the one shot either.
	pi.on("input", (event) => {
		if (!settings.autoCapture || captureTried) return { action: "continue" };
		if (!isCaptureCandidate(event)) return { action: "continue" };

		// The window closes here, on the first candidate prompt, regardless of
		// what happens next — including a goal already being active, in which
		// case there is nothing to capture and there will not be later either:
		// this was the one first work-opening prompt of the session.
		captureTried = true;
		if (!state.get()) {
			captureThisTurn = true;
			captureText = event.text;
		}
		return { action: "continue" };
	});

	// Compaction can summarize the goalSetInstruction message that first told
	// the model about the check into prose with no directive weight. This just
	// arms the flag; before_agent_start (below) spends it on the next turn.
	pi.on("session_compact", () => {
		state.markPendingReassertion();
	});

	// Reminders ride the turn as one hidden custom message: autoCapture's
	// extraction result if this is the turn it was armed for, otherwise the
	// compaction/resume reassertion if that is pending. The two never compete
	// for the single message slot before_agent_start can return — capture only
	// runs with no goal active, and reassertion is only armed for one that is.
	pi.on("before_agent_start", async (_event, ctx) => {
		const capturing = captureThisTurn;
		captureThisTurn = false;

		if (capturing && !state.get()) {
			const message = captureText;
			captureText = "";
			// Same "say so before the model call, not after" reasoning as the
			// command handler below.
			checkModel(ctx);
			const extraction = await extractCriteria(ctx, message, ctx.signal, settings.model, announce);

			if (extraction.kind === "error") {
				ctx.ui.notify(`goal.autoCapture failed, not blocking: ${extraction.reason}`, "warning");
			} else if (extraction.kind === "criteria" && extraction.criteria.length <= CONFIG.maxConditionChars) {
				state.set(extraction.criteria, ctx.getContextUsage()?.tokens ?? undefined);
				return {
					message: {
						customType: GOAL_MESSAGE,
						content: goalSetInstruction(extraction.criteria),
						display: true,
						details: { kind: "set", condition: extraction.criteria } satisfies GoalMessageDetails,
					},
				};
			}
			// "none", "aborted", or criteria too long to trust: nothing to set.
			// Overlong is treated as unusable rather than truncated, same as a
			// user-typed `/goal` condition — a clipped goal is judged against
			// something nobody actually said.
		}

		if (state.consumePendingReassertion()) {
			const goal = state.get();
			if (goal) {
				return {
					message: {
						customType: GOAL_REASSERT,
						content: systemReminder(reassertInstruction(goal.condition)),
						display: false,
					},
				};
			}
		}

		return undefined;
	});

	pi.registerCommand("goal", {
		description: "Set a goal pi checks before stopping ([<condition> | clear])",

		getArgumentCompletions: (prefix) =>
			"clear".startsWith(prefix.toLowerCase())
				? [{ value: "clear", label: "clear", description: "Clear the active goal" }]
				: null,

		handler: async (args, ctx) => {
			const condition = args.trim();

			if (condition.length === 0) {
				ctx.ui.notify(summaryLine(state.get()), "info");
				return;
			}

			if (CONFIG.clearWords.has(condition.toLowerCase())) {
				const previous = state.clear();
				ctx.ui.notify(previous ? `Goal cleared: ${previous.condition}` : "No goal set", "info");
				return;
			}

			if (condition.length > CONFIG.maxConditionChars) {
				ctx.ui.notify(
					`Goal condition is limited to ${CONFIG.maxConditionChars} characters (got ${condition.length})`,
					"warning",
				);
				return;
			}

			// Say so before the goal is set, not after the first stop attempt fails.
			checkModel(ctx);
			state.set(condition, ctx.getContextUsage()?.tokens ?? undefined);

			// The content is what the model reads; the renderer is what the user sees.
			pi.sendMessage<GoalMessageDetails>(
				{
					customType: GOAL_MESSAGE,
					content: goalSetInstruction(condition),
					display: true,
					details: { kind: "set", condition },
				},
				{ triggerTurn: true },
			);
		},
	});

	pi.on("agent_end", async (_event, ctx) => {
		const goal = state.get();
		if (!goal) return;

		// agent_end can fire again while our own evaluation call is still in flight.
		if (!state.beginEvaluation()) return;

		try {
			const verdict = await evaluate(ctx, goal.condition, ctx.signal, settings.model, announce);

			// The judge call takes tens of seconds, and the user can type through it.
			// If they cleared this goal or set a different one meanwhile, the verdict
			// answers a question nobody is asking any more — acting on it would let
			// `/goal clear` fail to stop the loop, or feed the old goal's reason back
			// under the new goal's name.
			if (state.get() !== goal) return;

			// An interrupt is not a failed check. Say nothing and leave the goal
			// standing: the next stop attempt evaluates it again.
			if (verdict.kind === "aborted") return;

			// An evaluator we cannot reach or parse must not trap the agent in a loop,
			// and must not silently pass the goal either, so it is a non-blocking
			// error: the agent is allowed to stop, and the goal stays unresolved.
			if (verdict.kind === "error") {
				ctx.ui.notify(`Goal check failed, not blocking: ${verdict.reason}`, "warning");
				return;
			}

			// The check that ends the goal counts as a turn, so a goal met on the first
			// try reports "1 turn" rather than "0 turns".
			const finish = (kind: GoalResultDetails["kind"], reason: string, iterations: number) => {
				state.clear();
				pi.appendEntry<GoalResultDetails>(GOAL_RESULT, {
					kind,
					condition: goal.condition,
					reason,
					iterations,
					durationMs: goalElapsed(goal, Date.now()),
					tokens: tokensSpent(goal, ctx),
				});
			};

			if (verdict.kind === "met" || verdict.kind === "impossible") {
				finish(verdict.kind, verdict.reason, goal.iterations + 1);
				return;
			}

			const iterations = state.recordMiss(verdict.reason);

			if (settings.maxIterations > 0 && iterations >= settings.maxIterations) {
				finish("capped", verdict.reason, iterations);
				return;
			}

			pi.sendMessage<GoalMessageDetails>(
				{
					customType: GOAL_MESSAGE,
					content: notMetInstruction(goal.condition, verdict.reason),
					display: true,
					details: { kind: "not_met", condition: goal.condition, reason: verdict.reason, iterations },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} finally {
			state.endEvaluation();
		}
	});
}
