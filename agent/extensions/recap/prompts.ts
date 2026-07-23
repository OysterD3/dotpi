/**
 * The recap prompt.
 *
 * Transcribed verbatim from the Claude Code binary (2.1.217). Both surfaces use
 * it — the manual `/recap` command and the automatic on-return summary run
 * through the same generator there (`Zin`), which is why there is one prompt, not
 * two. Only the framing around it (how the transcript is supplied) differs,
 * because Claude Code hands the model its live conversation and this port has to
 * flatten the branch into text.
 */

/**
 * Claude Code's `Viy`, unchanged. It reads as an instruction, so it is used as
 * the system prompt with the flattened transcript as the user message.
 */
export const RECAP_SYSTEM =
	"The user stepped away and is coming back. Recap in under 40 words, 1-2 plain sentences, no markdown. Lead with the overall goal and current task, then the one next action. Skip root-cause narrative, fix internals, secondary to-dos, and em-dash tangents.";

/** Framing for the flattened transcript handed to the recap model. */
export function recapRequest(transcript: string): string {
	return `<transcript>\n${transcript}\n</transcript>\n\nRecap where things stand, following the instructions.`;
}

/** Prefix a dropped-message notice onto the transcript, as the goal evaluator does. */
export function truncationNotice(dropped: number): string {
	return `[Note: the ${dropped} oldest message${dropped === 1 ? "" : "s"} were dropped to fit. The recent conversation follows.]`;
}
