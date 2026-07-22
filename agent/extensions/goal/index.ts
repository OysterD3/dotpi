/**
 * /goal — set an objective pi keeps working toward before it is allowed to stop.
 *
 * A port of Claude Code's `/goal`, whose logic was read out of the shipped
 * binary (2.1.217) rather than inferred. There, `/goal` registers a session-scoped
 * **Stop hook**: when the agent tries to stop, a separate tool-less LLM call judges
 * the transcript against the condition and either lets it stop or blocks with a
 * reason that is fed back to the agent. The goal auto-clears when met.
 *
 * pi has no Stop hook, and no event that can veto the end of a run — the closest
 * are `agent_end` and `agent_settled`, neither of which accepts a blocking result.
 * So the block is expressed the way pi's own shipped example does it: evaluate on
 * `agent_end`, and on "not met" deliver a follow-up message, which resumes the
 * agent. The observable behaviour is the same; the mechanism is pi-native.
 *
 *   prompts.ts     evaluator + instruction prompts, transcribed from Claude Code
 *   judge.ts       the evaluator LLM call and verdict parsing
 *   transcript.ts  session branch -> budgeted transcript text (pure)
 *   state.ts       active goal, iteration count, session persistence
 *   render.ts      TUI panels and status text (pure)
 *   config.ts      limits and timeouts
 *
 * Cost note: every stop attempt while a goal is active costs one extra LLM call
 * carrying up to half the context window. That is inherent to how Claude Code
 * works, not an artifact of this port.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { evaluate } from "./judge.ts";
import { goalSetInstruction, notMetInstruction } from "./prompts.ts";
import {
	type GoalMessageDetails,
	type GoalResultDetails,
	renderGoalMessage,
	renderGoalResult,
	statusText,
	summaryLine,
} from "./render.ts";
import { GoalState, restoreGoal } from "./state.ts";

const GOAL_MESSAGE = "goal";
const GOAL_RESULT = "goal_result";

export default function (pi: ExtensionAPI) {
	const state = new GoalState(pi);

	pi.registerMessageRenderer<GoalMessageDetails>(GOAL_MESSAGE, (message, _options, theme) =>
		message.details ? renderGoalMessage(message.details, theme) : undefined,
	);

	pi.registerEntryRenderer<GoalResultDetails>(GOAL_RESULT, (entry, _options, theme) =>
		entry.data ? renderGoalResult(entry.data, theme) : undefined,
	);

	// A goal outlives the process: /resume must not silently drop it.
	pi.on("session_start", (_event, ctx) => {
		const restored = restoreGoal(ctx.sessionManager.getBranch());
		state.adopt(restored);
		ctx.ui.setStatus("goal", statusText(restored));
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
				ctx.ui.setStatus("goal", undefined);
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

			const goal = state.set(condition);
			ctx.ui.setStatus("goal", statusText(goal));

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
			const verdict = await evaluate(ctx, goal.condition, ctx.signal);
			const finish = (kind: GoalResultDetails["kind"], reason: string, iterations: number) => {
				state.clear();
				ctx.ui.setStatus("goal", undefined);
				pi.appendEntry<GoalResultDetails>(GOAL_RESULT, {
					kind,
					condition: goal.condition,
					reason,
					iterations,
					durationMs: Date.now() - goal.setAt,
				});
			};

			if (verdict.kind === "met") {
				finish("met", verdict.reason, goal.iterations);
				return;
			}

			if (verdict.kind === "impossible") {
				finish("impossible", verdict.reason, goal.iterations);
				return;
			}

			// An evaluator we cannot reach or parse must not trap the agent in a loop,
			// and must not silently pass the goal either. Claude Code also treats this
			// as a non-blocking error: the agent is allowed to stop.
			if (verdict.kind === "error") {
				ctx.ui.notify(`Goal check failed, not blocking: ${verdict.reason}`, "warning");
				return;
			}

			const iterations = state.recordMiss(verdict.reason);
			ctx.ui.setStatus("goal", statusText(state.get()));

			if (CONFIG.maxIterations > 0 && iterations >= CONFIG.maxIterations) {
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
