/**
 * How many times in a row the suite has been run with nothing changed between.
 *
 * The failure this watches is a turn that verifies instead of finishing: run
 * the tests, read the same green, run them again. It is recorded in this repo
 * already — a workflow agent that ran `pnpm check` twenty-five times and
 * reported success without ever starting the thing it built.
 *
 * The discriminator is not the command, it is what sits between two of them.
 * Test, edit, test is work. Test, test, test cannot tell the model anything the
 * first one did not, and no wording of a task makes the second run informative.
 * So an edit ends a streak and nothing else does: reads, greps and `git status`
 * neither count nor clear, because none of them changes what the suite sees.
 */

/** Ends a streak: the code under test is no longer the code that was tested. */
export const EDIT_TOOLS = new Set(["edit", "write"]);

export const CONFIG = {
	/**
	 * Nudge on this run and every multiple of it.
	 *
	 * Two runs of a suite is ordinary — a flake, a watch mode that missed a
	 * file, a config change. Four with no edit at all between them is not
	 * something a working session does.
	 */
	nudgeEvery: 4,
	/**
	 * Nudges per turn. More than one because the trap is a *single* turn that
	 * keeps calling tools, and a steer that fires once and then goes quiet for
	 * the rest of it would say nothing to exactly the run that needs it.
	 */
	maxNudgesPerTurn: 3,
};

/**
 * Commands that run a suite rather than do work.
 *
 * Deliberately a list of what this machine's projects actually run, not a
 * theory of every build tool. A command this misses costs nothing — the streak
 * simply does not count it — while a command it wrongly matches would nag a
 * session that is working properly, so the bias is toward missing.
 */
const RUNNERS = [
	/^(?:pnpm|npm|yarn|bun|deno)\s+(?:run\s+)?(?:test|check|typecheck|type-check|lint|build)\b/,
	/^(?:npx|pnpm\s+exec|bunx)\s+(?:vitest|jest|tsc|eslint)\b/,
	/^(?:vitest|jest|tsc|eslint|pytest|rspec|phpunit)\b/,
	/^(?:cargo|go|mvn|gradle|swift)\s+(?:test|build)\b/,
	/^make\s+(?:test|check|lint)\b/,
	/^jiti\s+\S+\.test\.ts\b/,
];

/**
 * One command, read the way a shell would start it.
 *
 * `cd x && pnpm test` is a suite run, and so is `pnpm test 2>&1 | tail`. The
 * segments are split on the operators that start a new command, and a match on
 * any of them is a match — a pipeline's first stage is what does the running.
 */
export function isCheckCommand(command: string): boolean {
	return command
		.split(/&&|\|\||[;|]/)
		.map((segment) => segment.trim().replace(/^\(\s*/, ""))
		.some((segment) => RUNNERS.some((runner) => runner.test(segment)));
}

export class CheckStreak {
	private count = 0;
	private nudgesThisTurn = 0;

	current(): number {
		return this.count;
	}

	/** Call once per turn, so the per-turn cap resets and the count does not. */
	newTurn(): void {
		this.nudgesThisTurn = 0;
	}

	/** The code changed, so the next run of the suite is a new question. */
	reset(): void {
		this.count = 0;
	}

	/**
	 * Record one suite run. Returns the streak to report on every `every`th
	 * one, or null when this is not one of them — or the turn has had its fill.
	 */
	record(every: number, maxPerTurn: number): number | null {
		this.count++;
		if (this.count % every !== 0 || this.nudgesThisTurn >= maxPerTurn) return null;
		this.nudgesThisTurn++;
		return this.count;
	}
}
