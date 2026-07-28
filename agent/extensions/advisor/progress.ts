/**
 * What the advisor is doing right now, and how to say it in one line.
 *
 * A consult is a headless pi child that can easily run for minutes: the
 * transcript is large, reviewer models are slow, and a reasoning model spends
 * most of that time thinking before it writes a word. The tool used to print
 * "Consulting <model>…" once and then go silent for the whole call, which is
 * indistinguishable from a wedged subprocess — the one thing a five-minute wait
 * must never look like.
 *
 * pi's `--mode json` child streams its own session events, so the wait is not
 * actually opaque: message_update carries the partial assistant message, whose
 * blocks say whether the reviewer is still reasoning or has started writing
 * advice, and how much of each. This module turns that into a status line, and
 * is pure so the wording is testable without spawning anything.
 */

/** Where the reviewer is in its one and only turn. */
export type ReviewerPhase = "starting" | "thinking" | "writing";

export interface ReviewerProgress {
	phase: ReviewerPhase;
	/** Characters of reasoning in the current attempt. */
	thinkingChars: number;
	/** Characters of advice in the current attempt. */
	adviceChars: number;
	/** Assistant messages completed (a one-shot reviewer ends on 1). */
	turns: number;
	/**
	 * Which attempt is on screen. The reviewer is a one-shot, tool-less call, so
	 * a second assistant message means the first was retried — not a second step
	 * of the same answer.
	 */
	attempt: number;
}

export function emptyProgress(): ReviewerProgress {
	return { phase: "starting", thinkingChars: 0, adviceChars: 0, turns: 0, attempt: 1 };
}

/** Content blocks as pi-ai models them; only the two that carry prose matter. */
interface Block {
	type?: string;
	text?: string;
	thinking?: string;
}

/** Characters of reasoning and of advice in one (possibly partial) message. */
export function scanBlocks(content: unknown): { thinkingChars: number; adviceChars: number } {
	let thinkingChars = 0;
	let adviceChars = 0;
	if (Array.isArray(content)) {
		for (const block of content as Block[]) {
			if (block?.type === "thinking" && typeof block.thinking === "string") thinkingChars += block.thinking.length;
			else if (block?.type === "text" && typeof block.text === "string") adviceChars += block.text.length;
		}
	}
	return { thinkingChars, adviceChars };
}

/**
 * Which phase the counts describe, given what they were a moment ago.
 *
 * Whichever counter just grew wins, because the phase exists to name the number
 * next to it — and that number has to be one that moves. A model that opens with
 * a one-line preamble and then reasons for three minutes would otherwise latch
 * on "writing advice" beside a frozen 24 characters, which is the wedged look
 * this module exists to prevent. With no growth at all the phase holds, so a
 * quiet moment does not flap the label back to "starting".
 */
export function phaseFor(
	thinkingChars: number,
	adviceChars: number,
	previous?: { thinkingChars: number; adviceChars: number; phase: ReviewerPhase },
): ReviewerPhase {
	if (!previous) {
		if (adviceChars > 0) return "writing";
		if (thinkingChars > 0) return "thinking";
		return "starting";
	}
	if (adviceChars > previous.adviceChars) return "writing";
	if (thinkingChars > previous.thinkingChars) return "thinking";
	if (previous.phase !== "starting") return previous.phase;
	if (adviceChars > 0) return "writing";
	if (thinkingChars > 0) return "thinking";
	return "starting";
}

/**
 * "45s", "1m 12s" — short enough to sit inside a status line.
 *
 * A fourth hand-written elapsed formatter in this repo, and deliberately so:
 * every extension here is independently installable, so none imports another's
 * helpers. The copies are not identical — ultracode's panel writes "4m02s"
 * without the space, and elapsed/duration.ts is the full duration format
 * transcribed, which carries rounding rules this line does not want. Divergence
 * is the cost of that rule, and it has already bitten once: a README sample was
 * written with ultracode's zero-padding for output this function cannot emit.
 * Match this function, not a sibling, when documenting the advisor.
 */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.floor(ms / 1000));
	if (total < 60) return `${total}s`;
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** "820", "1.4k" — a volume, not an exact figure, so it stays one glance wide. */
export function compactCount(value: number): string {
	if (value < 1000) return String(value);
	return `${(value / 1000).toFixed(1)}k`;
}

export interface StatusInput {
	model: string;
	progress: ReviewerProgress;
	elapsedMs: number;
	timeoutMs: number;
}

/**
 * The line shown while the consult runs.
 *
 * The elapsed time leads the variable part because a number that moves is the
 * actual answer to "is this stuck?" — the phase and volume say what it is busy
 * with, but the clock is what proves it is busy at all. The timeout is named
 * only in the back half of the budget, where the question stops being idle
 * curiosity and starts being "should I kill this?".
 */
export function advisorStatus({ model, progress, elapsedMs, timeoutMs }: StatusInput): string {
	const elapsed = formatElapsed(elapsedMs);
	const parts: string[] = [];

	if (progress.phase === "starting") {
		parts.push(`Consulting ${model}… ${elapsed}`);
	} else if (progress.phase === "thinking") {
		parts.push(`${model} is thinking… ${elapsed}`, `${compactCount(progress.thinkingChars)} chars of reasoning`);
	} else {
		parts.push(`${model} is writing advice… ${elapsed}`, `${compactCount(progress.adviceChars)} chars`);
	}

	// A retry is why the volume just fell back; saying so beats letting it look
	// like the consult lost its work.
	if (progress.attempt > 1) parts.push(`attempt ${progress.attempt}`);

	if (timeoutMs > 0 && elapsedMs > timeoutMs / 2) {
		parts.push(`gives up at ${formatElapsed(timeoutMs)}`);
	}
	return parts.join(" · ");
}
