/**
 * The opening nudge: a one-shot reminder, on the turn a new task arrives, that
 * now is the moment to ask.
 *
 * Everything else in this extension is wording, and wording had already been
 * fixed — the description names the cases where asking is right, the guidelines
 * repeat them. It changed nothing, because the problem was never what the model
 * was told. It was WHEN. The description, the prompt snippet and the guidelines
 * all live in the cached prefix: read once, above twenty other tools, long
 * before there is a request to weigh them against. By the time a request lands
 * that has three unresolved decisions in it, the only thing in recent context is
 * the request, and a model trained to be autonomous starts working.
 *
 * The agents that do ask — Claude Code, Qoder — ask at turn zero, before the
 * first file is touched, because that is the only cheap moment: a question asked
 * first costs one interruption, and the same question asked after an hour costs
 * the hour. So this fires exactly there. `opensWork` looks at the human's text
 * for a request that starts something rather than continuing it, and index.ts
 * rides the reminder into that turn as a hidden custom message.
 *
 * The detector is deliberately narrow, and biased toward silence:
 *
 *   - a continuation ("also...", "now do the other one") is work already framed,
 *     and its decisions were settled on the turn that opened it;
 *   - an informational HEAD ("why does...", "check whether...", "can you
 *     explain...") asks about the code, and the answer is to go and find out,
 *     never to ask back. Judged at the head only: an earlier version scanned the
 *     first five words for any of 34 common verbs, which killed "I need you to
 *     DO a full rewrite of the sync layer" on the word "do" and "write a script
 *     to FIND the dead runs" on the word "find" — the exact requests this
 *     exists to catch;
 *   - anything short is a follow-up. Real task statements are not four words.
 *
 * A false positive costs the tokens below and a model that reads them and
 * decides there is nothing to ask — the reminder says so explicitly, in the same
 * breath as the instruction to ask. A false negative costs what it already cost:
 * a task built on a guess. That asymmetry is why the verb list is generous and
 * the guards are cheap, rather than the other way round.
 */

/**
 * Words that, in the first position, mark this as a turn inside work already
 * under way. The decisions belong to the turn that opened it, and re-asking
 * mid-task is the failure mode the tool description spends four lines on.
 */
const CONTINUATION = new Set([
	"actually",
	"again",
	"also",
	"and",
	"carry",
	"continue",
	"go",
	"instead",
	"keep",
	"next",
	"no",
	"now",
	"ok",
	"okay",
	"plus",
	"proceed",
	"resume",
	"retry",
	"revert",
	"then",
	"undo",
	"yes",
]);

/**
 * Politeness that sits in front of the real verb. Skipped, not judged.
 */
const POLITENESS = new Set(["can", "could", "would", "will", "please", "pls", "kindly", "you"]);

/**
 * Interrogatives. These only make a message a question when they LEAD it —
 * "what is the difference…" is a question, but "rewrite the parser so it knows
 * what to skip" is not, and an earlier version that scanned five words for any
 * of these suppressed the second one too.
 */
const QUESTION_LEAD = new Set([
	"are",
	"did",
	"do",
	"does",
	"how",
	"is",
	"was",
	"were",
	"what",
	"whats",
	"when",
	"where",
	"which",
	"who",
	"why",
]);

/**
 * Verbs that ask for a look rather than a change. Judged only in the GOVERNING
 * position — the head of the request, or the head of what an intent opener
 * governs. Anywhere else they are ordinary words: "write a script to find the
 * dead runs" and "build the exporter, then check it against the fixture" are
 * both work, and both were being thrown away.
 */
const LOOKUP_VERBS = new Set([
	"analyse",
	"analyzed",
	"analyze",
	"check",
	"compare",
	"curious",
	"describe",
	"diagnose",
	"explain",
	"find",
	"inspect",
	"investigate",
	"know",
	"list",
	"look",
	"read",
	"review",
	"search",
	"show",
	"summarise",
	"summarize",
	"tell",
	"understand",
	"wondering",
]);

/**
 * Words that carry no meaning between an intent opener and the verb it governs:
 * "I need YOU TO do X", "I want THE agent to X".
 */
const FILLER = new Set(["a", "an", "it", "me", "my", "our", "some", "that", "the", "this", "to", "us", "you"]);


/**
 * Verbs that ask for something to exist that does not exist yet. These are the
 * requests whose decisions get baked in — a schema, an API shape, a layout —
 * and so the requests where a wrong guess is expensive rather than merely
 * wasteful.
 */
const WORK_VERBS = new Set([
	"add",
	"build",
	"convert",
	"create",
	"design",
	"develop",
	"extend",
	"generate",
	"implement",
	"integrate",
	"make",
	"migrate",
	"port",
	"rearchitect",
	"rebuild",
	"redesign",
	"refactor",
	"rewrite",
	"scaffold",
	"setup",
	"write",
]);

/**
 * A determiner in front of a work verb turns it into a noun — "the build
 * failed", "my design is wrong" — and those are reports, not requests.
 */
const DETERMINERS = new Set(["a", "an", "another", "her", "his", "its", "my", "our", "that", "the", "their", "this", "your"]);

/**
 * Openers that state an intent without ever reaching a verb: "I want the agent
 * to be faster", "we need something that...". These carry no work verb at all,
 * and they are how a substantial task is most often phrased.
 */
const INTENT_OPENERS = [
	"can you",
	"could you",
	"help me",
	"i need",
	"i want",
	"i would like",
	"id like",
	"ill need",
	"we need",
	"we should",
	"we want",
	"lets",
	"let us",
];

/**
 * Below this, it is a follow-up. A request carrying decisions worth a question
 * has to say enough to have decisions in it, and "fix it for me" does not.
 */
const MIN_WORDS = 6;

/** Strip surrounding punctuation and apostrophes so "let's" and "lets" are one word. */
function normalizeWord(word: string): string {
	return word.replace(/['’`]/g, "").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
}

/**
 * Does this human message open new work, as opposed to continuing it or asking
 * about the code?
 *
 * Pure and total: no I/O, and any input at all yields a boolean.
 */
export function opensWork(text: string): boolean {
	const trimmed = text.trim();
	// A slash command or a `!` bash line is not a request to the model at all.
	if (!trimmed || trimmed.startsWith("/") || trimmed.startsWith("!")) return false;

	const words = trimmed
		.toLowerCase()
		.split(/\s+/)
		.map(normalizeWord)
		.filter((word) => word.length > 0);
	if (words.length < MIN_WORDS) return false;

	if (CONTINUATION.has(words[0]!)) return false;

	// The HEAD of the request: the first word that is not mere politeness. This
	// is the only position an interrogative or a lookup verb is judged in, which
	// is what separates "check whether the threshold fires" (a question) from
	// "build the exporter, then check it against the fixture" (work).
	let head = 0;
	while (head < words.length && POLITENESS.has(words[head]!)) head++;
	const headWord = words[head] ?? "";
	if (QUESTION_LEAD.has(headWord) || LOOKUP_VERBS.has(headWord)) return false;

	// An intent opener states a goal without ever reaching a verb ("I want the
	// agent to be faster"). What it governs decides: "I want to KNOW why…" is a
	// question, "I need you to DO a full rewrite" is not.
	const lead = words.slice(0, 4).join(" ");
	if (INTENT_OPENERS.some((opener) => lead.startsWith(opener))) {
		const opener = INTENT_OPENERS.find((candidate) => lead.startsWith(candidate))!;
		let governed = opener.split(" ").length;
		while (governed < words.length && FILLER.has(words[governed]!)) governed++;
		return !LOOKUP_VERBS.has(words[governed] ?? "");
	}

	return words.some((word, index) => WORK_VERBS.has(word) && !DETERMINERS.has(words[index - 1] ?? ""));
}

/**
 * What the model is told on that turn.
 *
 * Both halves are load-bearing and the second is the one that keeps this from
 * becoming the opposite bug. An instruction to consider asking, on its own,
 * reads as an instruction to ask — so the same reminder that says "ask now"
 * also says, in as many words, that finding nothing is the common case and the
 * correct response to it is to state the assumption and start working.
 *
 * The cost framing is there because it is the actual decision rule, and it is
 * one a model can apply without knowing anything about this user: not "am I
 * unsure" (it always is, a little) but "what does being wrong cost here".
 */
export const OPENING_NUDGE = [
	"This request opens new work, and now is the cheapest moment to be wrong about it.",
	"",
	"Before you touch a file, read it once for decisions that are the user's to make and that you cannot settle from the request or the codebase:",
	"  - a choice that gets baked into something later work depends on — a schema, an API shape, a data model, a dependency, a file layout;",
	"  - a preference, a priority, or a business rule that exists nowhere in the repo and cannot be derived from it;",
	"  - two readings of the request that lead to materially different work, rather than to different wording.",
	"",
	"If any exist, put them to the user with ask_user now, in a single call, before you start building. One question asked first costs one interruption. The same question answered by guessing costs everything built on top of the guess, and you cannot give that back.",
	"",
	"If none exist — the common case — do not ask. Say in one line what you are assuming and get on with the work.",
].join("\n");

/** Wrap a reminder the way pi's own hidden-message reminders are wrapped. */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
