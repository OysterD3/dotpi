/**
 * The instruction text that steers a compaction summary.
 *
 * WHY THIS EXISTS. pi's summarizer has two prompts: an initial one, and an
 * update one used on every compaction after the first. The update prompt opens
 * with "PRESERVE all existing information from the previous summary", and its
 * only permission to forget is a single weak "If something is no longer
 * relevant, you may remove it". In a long session that reads as append-only:
 * summary N+1 restates summary N and adds to it, so the one part of the context
 * that survives every compaction is also the one part that only ever grows.
 *
 * HOW IT GETS IN. pi appends whatever it is given as "Additional focus: …" to
 * the end of the base prompt (generateSummaryWithUsage). Coming last, it is
 * read as a refinement of the rules above it rather than a contradiction — so
 * the text below re-frames the budget and names what to drop, instead of trying
 * to revoke "PRESERVE all", which it cannot do.
 *
 * A user's own `/compact <instructions>` is theirs, so it is kept and placed
 * last, where it wins any conflict with ours.
 */

/**
 * What must survive is listed as specifically as what must go. A prompt that
 * only says "be shorter" gets shorter by dropping file paths and error strings
 * — the things that are expensive to recover and cheap to keep.
 */
export function steeringInstructions(maxWords: number): string {
	return [
		`Treat this summary as a working brief with a budget, not an append-only log. Aim for under ${maxWords} words. A summary longer than the one it replaces is usually wrong: the session moved forward, so more of it should now be settled and droppable.`,
		"",
		"Compress or drop entirely:",
		"- Work that is finished and verified. One line recording that it was done is enough; the code and the git history are the real record.",
		"- Files that were only read, and searches that found nothing. Say what was learned, not what was opened.",
		"- Superseded decisions, abandoned approaches and fixed bugs — unless the user must not have them retried, in which case keep one line saying so and why.",
		"- Anything already visible in the recent messages that are being kept, which the reader can see directly.",
		"- Narration of the process: who ran what, in which order, and how long it took.",
		"",
		"Keep, and keep exact:",
		"- What the user asked for, and every constraint, preference or correction they stated. These are unrecoverable once dropped.",
		"- File paths, identifiers, commands and error strings that are still live.",
		"- Decisions that still bind, each with the reason it was made.",
		"- What is in flight right now, and what happens next.",
	].join("\n");
}

/**
 * Combine our steering with any instructions the user typed on /compact.
 *
 * The user's text goes last and is labelled, so the summarizer treats it as the
 * operative request rather than as more of ours.
 */
export function compactionInstructions(maxWords: number, userInstructions?: string): string {
	const steering = steeringInstructions(maxWords);
	const user = userInstructions?.trim();
	if (!user) return steering;
	return `${steering}\n\nThe user asked for this compaction specifically, with these instructions. Where they conflict with anything above, follow the user:\n${user}`;
}
