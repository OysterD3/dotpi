/**
 * /research — a sweep the session agent runs, read by a fleet that could not
 * have run it.
 *
 * The command does no researching. It works out three things the model would
 * otherwise guess at — how wide to sweep, where the fetched sources go, and
 * which fan-out tool is actually active — assembles a prompt from them, and
 * injects it as a turn. Same shape as /code-review, and for the same reason:
 * the agent in the session has the tools, so the command's job is to be
 * specific rather than to do the work.
 *
 * The split it enforces is not a style choice. Workflow subagents spawn with
 * `--no-extensions`, so web_search and fetch — extension tools — do not exist
 * for them. The session agent fetches; the fleet reads. See prompt.ts.
 *
 *   config.ts   depths, angles, tunables (pure)
 *   args.ts     parsing `[--quick|--standard|--deep] <question>` (pure)
 *   prompt.ts   assembling the turn per depth and fan-out (pure)
 *
 * The reading fleet lives in agent/workflows/deep-research.js, as a saved
 * workflow rather than a script the model authors each time: the source-file
 * contract in prompt.ts and the reader that consumes it have to agree, and two
 * halves of one contract should not be re-derived per run.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { parseArgs, slugify } from "./args.ts";
import { CONFIG, DEPTHS, type FanOut } from "./config.ts";
import { researchPrompt } from "./prompt.ts";

const RESEARCH_MESSAGE = "research";

/**
 * The best fan-out tool active right now, or "none".
 *
 * Order matters: `workflow` reads every source concurrently and gates the
 * report on the file existing, so it wins wherever both are available.
 */
export function detectFanOut(activeTools: readonly string[]): FanOut {
	const active = new Set(activeTools);
	for (const tool of CONFIG.fanOutTools) {
		if (active.has(tool)) return tool;
	}
	return "none";
}

/**
 * Where the fetched sources go.
 *
 * The scratchpad when there is one — writes there do not stop to ask, which is
 * what makes a forty-file sweep survive `auto` mode. Without it, the system
 * temp directory: the sources are intermediate, they are large, and they are
 * not what the user asked for. The report is the deliverable, and it lands in
 * the project.
 */
export function sourceDir(scratch: string | undefined, slug: string): string {
	return join(scratch ?? tmpdir(), "research-" + slug);
}

export default function (pi: ExtensionAPI) {
	/** This session's scratchpad, as last announced. */
	let scratch: string | undefined;
	pi.events.on(CONFIG.scratchChannel, (data) => {
		const dir = (data as { dir?: unknown } | undefined)?.dir;
		scratch = typeof dir === "string" && dir.length > 0 ? dir : undefined;
	});

	const fanOut = (): FanOut => {
		try {
			return detectFanOut(pi.getActiveTools());
		} catch {
			// A context with no live tool list is not a reason to refuse the
			// command; inline is the honest fallback, and the prompt says so.
			return "none";
		}
	};

	pi.registerCommand("research", {
		description: `Sweep the web on a question, read every source in parallel, and write one HTML report ([--${DEPTHS.join("|--")}] <question>)`,

		getArgumentCompletions: (prefix) => {
			const lower = prefix.toLowerCase();
			const options = DEPTHS.map((depth) => "--" + depth).filter((option) => option.startsWith(lower));
			if (options.length === 0) return null;
			return options.map((value) => ({
				value,
				label: value,
				description:
					value === "--quick"
						? "3 angles, ~9 sources"
						: value === "--deep"
							? "8 angles, ~40 sources, and the answer is refuted before it is written"
							: "5 angles, ~20 sources",
			}));
		},

		handler: async (args, ctx) => {
			const { depth, question, unknownFlags, extraDepths } = parseArgs(args);

			if (!question) {
				ctx.ui.notify("/research needs a question — e.g. /research --deep does prompt caching help agent loops?", "warning");
				return;
			}
			if (extraDepths.length > 0) {
				ctx.ui.notify(`Using --${depth}; ignoring ${extraDepths.join(", ")}. One depth per run.`, "warning");
			}
			if (unknownFlags.length > 0) {
				ctx.ui.notify(`Ignoring unknown flag${unknownFlags.length > 1 ? "s" : ""}: ${unknownFlags.join(", ")}.`, "warning");
			}

			const slug = slugify(question);
			pi.sendMessage(
				{
					customType: RESEARCH_MESSAGE,
					content: researchPrompt({
						question,
						depth,
						fanOut: fanOut(),
						dir: sourceDir(scratch, slug),
						out: join(CONFIG.outDir, slug + ".html"),
					}),
					display: false,
				},
				{ triggerTurn: true },
			);
		},
	});
}
