/**
 * /simplify and /code-review — structured review of the current diff.
 *
 * `/simplify` improves quality: reuse, simplification, efficiency, altitude.
 * `/code-review` hunts for correctness bugs, at an effort level you choose.
 * They are deliberately separate commands rather than one with a flag, because
 * a reviewer asked for both trades them against each other, and a style nit
 * should never displace a real defect.
 *
 * Neither does the reviewing itself. Each assembles a prompt and injects it as
 * a turn, and the agent in the session does the work with whatever tools it
 * has — which is what lets the same command scale from a single inline pass to
 * a verified fleet without changing anything here.
 *
 * The one thing this file decides is fan-out: `workflow` (from the ultracode
 * extension) orchestrates a whole fleet deterministically, `task` (from the
 * subagents extension) spawns them one call at a time, and with neither the
 * review still runs inline and is told to say so. Detecting it here rather than
 * asking the model to guess means the prompt can be specific about the tool,
 * and the summary can be honest about what actually ran.
 *
 *   angles.ts   the review lenses, cleanup and correctness (pure)
 *   phases.ts   diff gathering, verdict rubric, output contract (pure)
 *   prompt.ts   assembling a prompt per command / level / fan-out (pure)
 *   args.ts     parsing `[level] [--fix] [<target>]` (pure)
 *   diff.ts     sizing the diff so the fleet matches the work
 *   config.ts   levels, caps, finder bounds
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs, splitFlags, tokenize } from "./args.ts";
import { anglesFor, CONFIG, type FanOut, LEVEL_SPECS, LEVELS } from "./config.ts";
import { countDiffLines } from "./diff.ts";
import { allowsUncertainty, finderBudget } from "./phases.ts";
import { codeReviewPrompt, simplifyPrompt } from "./prompt.ts";

const REVIEW_MESSAGE = "review";

/**
 * The best fan-out tool active right now, or "none".
 *
 * Order matters: `workflow` runs a whole fleet from one script with a real
 * verify stage, so it is preferred wherever both are available.
 */
export function detectFanOut(activeTools: readonly string[]): FanOut {
	const active = new Set(activeTools);
	for (const tool of CONFIG.fanOutTools) {
		if (active.has(tool)) return tool;
	}
	return "none";
}

export default function (pi: ExtensionAPI) {
	/** Inject an assembled review prompt as a turn. */
	const dispatch = (content: string) => {
		pi.sendMessage(
			{ customType: REVIEW_MESSAGE, content, display: false },
			{ triggerTurn: true },
		);
	};

	const fanOut = (): FanOut => {
		try {
			return detectFanOut(pi.getActiveTools());
		} catch {
			// A context without a live tool list is not a reason to fail the
			// command; inline is the honest fallback and says so in its summary.
			return "none";
		}
	};

	pi.registerCommand("simplify", {
		description:
			"Review the changed code for reuse, simplification, efficiency and altitude cleanups, then apply the fixes ([<target>])",
		handler: async (args, ctx) => {
			// /simplify takes no flags, but `--fix` is a reflex after using
			// /code-review. Left unparsed it became a review *target*, silently
			// scoping the cleanup to a path that does not exist.
			const { rest, fix, unknownFlags } = splitFlags(tokenize(args));
			const stray = [...(fix ? ["--fix"] : []), ...unknownFlags];
			if (stray.length > 0) {
				ctx.ui.notify(`/simplify takes no flags — ignoring ${stray.join(", ")}. It always applies its fixes.`, "warning");
			}
			dispatch(simplifyPrompt(fanOut(), rest.join(" ")));
		},
	});

	pi.registerCommand("code-review", {
		description: `Review the current diff for correctness bugs at a given effort level ([${LEVELS.join("|")}] [--fix] [<target>])`,

		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase();
			const options = [...LEVELS, "--fix" as const].filter((o) => o.startsWith(lower));
			if (options.length === 0) return null;
			return options.map((value) => {
				if (value === "--fix") {
					return { value, label: value, description: "Apply the findings after reporting them" };
				}
				// Same source of truth the injected prompt reads, so the hint here
				// cannot describe a level differently from how it actually behaves.
				const { cap } = LEVEL_SPECS[value];
				const description = allowsUncertainty(value)
					? `Broader coverage, may include uncertain findings (≤${cap})`
					: `Fewer, high-confidence findings (≤${cap})`;
				return { value, label: value, description };
			});
		},

		handler: async (args, ctx) => {
			const { level, target, fix, unrecognizedLevel, unknownFlags } = parseArgs(args);

			if (unrecognizedLevel) {
				ctx.ui.notify(
					`"${unrecognizedLevel}" is not an effort level — using ${level}. Levels: ${LEVELS.join(", ")}.`,
					"warning",
				);
			}
			if (unknownFlags.length > 0) {
				ctx.ui.notify(`Ignoring unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}.`, "warning");
			}

			// Only the deeper levels size their fleet to the diff; below that the
			// angle list is short enough that one finder per angle is the fleet.
			let finders = CONFIG.minFinders;
			if (LEVEL_SPECS[level].scaleFinders) {
				const lines = await countDiffLines(ctx.cwd, target || undefined);
				// An unmeasurable diff is not a small one — see CONFIG.unmeasurableFinders.
				finders = lines === undefined ? CONFIG.unmeasurableFinders : finderBudget(lines);
			}

			// Never more finders than angles: two agents handed the same single
			// angle is one wasted call and no extra coverage.
			finders = Math.max(1, Math.min(finders, anglesFor(level).length));

			dispatch(codeReviewPrompt(level, fanOut(), target, finders, fix));
		},
	});
}
