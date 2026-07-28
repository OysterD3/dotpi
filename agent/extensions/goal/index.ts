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
 *   prompts.ts     evaluator + instruction prompts
 *   judge.ts       the evaluator LLM call, model selection and verdict parsing
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
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { evaluate, selectModel } from "./judge.ts";
import { goalSetInstruction, notMetInstruction } from "./prompts.ts";
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

export default function (pi: ExtensionAPI) {
	const state = new GoalState(pi);
	const agentDir = getAgentDir();
	let settings: GoalSettings = { ...DEFAULTS };

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
			const verdict = await evaluate(ctx, goal.condition, ctx.signal, settings.model);

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
