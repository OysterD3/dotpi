/**
 * What the streak says when it fires, injected as a <system-reminder>.
 *
 * It names the count and the command because a model mid-loop has no sense of
 * either — every round looks like the first from inside. And it ends with the
 * two ways out rather than "stop", because "stop" with unfinished work reads as
 * an instruction to abandon the task, and the model will pick the suite over
 * abandoning every time.
 */

export function rerunReminder(count: number, command: string): string {
	return `You have run \`${command}\` ${count} times with no edit between them. The result cannot change while the code does not, so another run will tell you nothing this one did not. Either change something and re-run it, or say plainly what you observed — including that it is still failing, if it is — and move on.`;
}

export function rerunNotice(count: number): string {
	return `${count} suite runs with no edit between them — the model has been told.`;
}

export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
