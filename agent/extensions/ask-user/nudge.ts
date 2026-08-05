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
 *
 * All of the above assumes the model is willing to be moved by wording at all,
 * and that assumption held for exactly one side of an A/B benchmark run in this
 * harness. claude-opus-5, given OPENING_NUDGE below on a task with a real open
 * decision, asked four batched questions at minute six — the nudge worked
 * precisely as designed. gpt-5.6-sol, same task, same nudge, and a user prompt
 * that additionally said outright "if you don't understand anything, ask before
 * you do", called ask_user zero times across ten hours, guessed wrong on the one
 * question that mattered (a real data source vs. a demo fixture), and burned $93
 * building on the guess. The nudge did not arrive late — it rode in on turn one,
 * same as always — and it was not unread; it was read and not acted on. Every
 * sentence in OPENING_NUDGE is a judgment call dressed as an instruction ("if
 * any exist, ask"; "if none exist, do not ask"), and a judgment call is exactly
 * the shape of guidance OpenAI-family models are trained to weigh against
 * finishing the task, and lose. What survived that same training, the benchmark
 * suggests, is the opposite shape: an unconditional protocol with a mandatory,
 * checkable output artifact — no "if", a forced choice between calling ask_user
 * and printing a visible block, every time. style.ts scopes that wording
 * (CONTRACT_NUDGE, below) to the models it was built for rather than replacing
 * OPENING_NUDGE outright: a model that already asks does not need to be handed a
 * rigid protocol in place of the judgment call it was already making correctly.
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

/**
 * The contract style's opening nudge — style.ts's other wording, delivered at
 * the exact same point as OPENING_NUDGE above (see index.ts's
 * before_agent_start handler, which picks one or the other fresh on every
 * turn rather than caching the choice). Where OPENING_NUDGE offers a
 * judgment call, this offers a forced choice with a checkable artifact,
 * because a judgment call is what the benchmark this file's header describes
 * showed OpenAI-family models routing around.
 *
 * No "if any exist, ask": every request gets one of the two things below, and
 * (b)'s exact marker line — "ASSUMPTIONS:" — is what index.ts's
 * hasAssumptionsBlock, below, actually looks for in the model's own output,
 * so this is not merely instructing the model, it is defining the thing
 * compliance is checked against. The six decision kinds are OPENING_NUDGE's
 * three bullets, split further and made concrete enough to name without
 * reading a sentence twice — a model that is not going to weigh "is this
 * genuinely the user's to decide" on its own needs the list to be
 * recognisable at a glance, not argued for.
 *
 * The mid-task re-application is the other half of the same fix as the
 * compliance follow-up in index.ts: the opening nudge, of either style, only
 * fires once, and a model that stops finding new decisions after turn one
 * needs telling that the gate is not a one-time formality.
 */
export const CONTRACT_NUDGE = [
	"Decision gate — complete ONE of these before your first file write, not after:",
	"(a) Call ask_user ONCE, batching every decision below that applies to this request; or",
	"(b) Print a visible block starting with the exact line 'ASSUMPTIONS:' — one numbered line per assumption, each naming the decision, the choice you are making, and what becomes wrong if the user disagrees.",
	"",
	"Decisions that always qualify: data source (real system vs mock/fixture/demo); schema, API, or contract shapes other work will build on; framework/library/dependency choices; file and module layout; scope boundaries (what you will NOT do); any instruction with two materially different readings.",
	"",
	"This gate re-applies MID-TASK: the moment you discover a new decision of these kinds, ask or extend ASSUMPTIONS before building on it. Silent assumptions are defects. If genuinely none apply, print 'ASSUMPTIONS: none — <one line why>' and proceed.",
].join("\n");

/** Wrap a reminder the way pi's own hidden-message reminders are wrapped. */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}

/**
 * The compliance follow-up: the second and last line of defence after the
 * opening nudge above, and the one the benchmark this exists for never got to
 * see. The opening nudge fires once, on the turn that opens the work — after
 * that it is sitting in context exactly like the tool description and the
 * guidelines it was written to work around, easy for a model that has decided
 * to build to read past and not act on. The gpt-5.6-sol run did precisely
 * that: the nudge rode in with the opening request, and the model spent
 * $93 over 10 hours building on a guessed data source without ever calling
 * ask_user.
 *
 * So this is gated on cost actually being spent, not on a clock or a turn
 * count: index.ts tracks the DISTINCT files touched by write/edit tool calls
 * session-wide, starting only once a nudge has actually gone out (before that
 * there is nothing to be a backstop for), and clears that set — re-arming the
 * latch — on every actual ask_user call. Reaching CONFIG.followUp.afterMutations
 * distinct files with none in between means several files now exist that were
 * never checked against the opening questions, which is exactly the state the
 * codex run was in for ten hours straight. Distinct files, not calls: five
 * edits to one file is one file still unchecked against the opening
 * questions, not five, and a count of tool calls would say otherwise.
 *
 * Counted from tool_call, not tool_result: a write that later errors was
 * still a decision made without asking, whether or not the file landed.
 *
 * The message names the count that actually tripped it, not the configured
 * threshold, so it stays accurate if CONFIG.followUp.afterMutations changes —
 * same reason guidance.ts interpolates CONFIG.maxQuestions instead of writing
 * "four". It also names the concrete questions from OPENING_NUDGE (data
 * source, schema, layout) rather than repeating the abstract categories,
 * because by this point the model has stopped reading the abstract version.
 *
 * This is the socratic style's version specifically — see style.ts. It stays
 * word-for-word what it always was, one-shot per arming, because socratic
 * models were never the gap this schedule closes. contractFollowUpReminder
 * and hasAssumptionsBlock, below, are the contract style's versions of this
 * same idea, with a re-arming schedule instead of a single latch — see
 * CONFIG.followUp and index.ts for why that difference exists.
 */
export function followUpReminder(fileCount: number): string {
	return systemReminder(
		`You have now created or edited ${fileCount} files without putting a single decision to the user. Re-check the opening questions (data source real vs fixture, schema, layout): if any decision is genuinely the user's, call ask_user NOW; otherwise state your assumptions in one line and continue.`,
	);
}

/**
 * The contract style's compliance follow-up — same trigger as
 * followUpReminder above (index.ts's tool_call handler, CONFIG.followUp),
 * different wording because a different thing is being checked for.
 * followUpReminder's fallback ("state your assumptions in one line and
 * continue") is prose the model merely claims to have followed; nothing
 * downstream reads it back. CONTRACT_NUDGE asked for a checkable artifact
 * instead, so this follow-up does not offer a fallback at all — it names the
 * artifact and says print it now, and index.ts's hasAssumptionsBlock, below,
 * is what actually checks whether that happened.
 *
 * Restates the exact marker line ('ASSUMPTIONS:'), not just the word: by the
 * time this fires, several turns and CONFIG.followUp.afterMutations files
 * separate the model from CONTRACT_NUDGE, and context compaction can drop the
 * opening nudge entirely before this ever fires. Without the literal format
 * repeated here, a model that still remembers there IS a gate has no spec
 * left in context for what printing it correctly looks like.
 */
export function contractFollowUpReminder(fileCount: number): string {
	return systemReminder(
		`You have modified ${fileCount} files and neither asked a question nor printed an ASSUMPTIONS block. Print it NOW — a visible block starting with the exact line 'ASSUMPTIONS:', one numbered line per assumption you have already made silently (data source, schemas, layout), naming the decision and what becomes wrong if the user disagrees — then continue. If any line is genuinely the user's call, use ask_user instead.`,
	);
}

/**
 * Does `text` — an assistant message's text content, as index.ts extracts it
 * from message_end — contain a visible ASSUMPTIONS block? This is the other
 * half of contract-style compliance alongside an ask_user call (see
 * index.ts's tool_call and message_end handlers): CONTRACT_NUDGE asks the
 * model to print a block starting with the exact line "ASSUMPTIONS:", and
 * this is what checks that it did.
 *
 * Line-start, not substring: matched against each line's trimmed text, not
 * against the raw string. "I'll note my assumptions: this looks like mock
 * data" mid-sentence is prose ABOUT assumptions, not the block the gate asks
 * for — treating it as compliance would let the exact silent-assumption
 * failure this style exists to catch (see the header above) count as having
 * been caught.
 *
 * Not literal-exact, though: a line is stripped of one leading markdown
 * heading ("#" through "######" plus a space) and one leading emphasis
 * wrapper ("**", "__", or "*") before matching, and the marker itself is
 * matched case-insensitively. CONTRACT_NUDGE asks for the artifact, not for
 * markdown-free plain text, and a model that renders its own output as
 * "**ASSUMPTIONS:**" or "## Assumptions:" has still printed the block the
 * gate asked for — treating that as non-compliance would be exactly the kind
 * of false accusation this style exists to avoid.
 *
 * Two further exclusions keep this from firing on text that merely CONTAINS
 * the marker rather than asserting it: lines inside a fenced code block
 * (``` or ~~~, tracked by toggling on any fence-delimiter line) and
 * blockquote lines (leading ">"). Both are ways of quoting or citing the
 * marker without printing it as this message's own compliance — the fenced
 * case is not hypothetical: this very extension's test files contain over a
 * dozen lines starting with "ASSUMPTIONS:" inside fenced examples, and a
 * model that quotes the gate back (in an explanation, in a diff, in a code
 * comment it is writing) must not register as having satisfied it.
 *
 * Pure and total, like opensWork above — no I/O, any string in, a boolean
 * out — so index.ts's glue (finding the right event, pulling text out of
 * content blocks) stays separate from the logic worth testing on its own.
 * index.ts calls this once per content block rather than concatenating a
 * message's blocks into one string first — see its message_end handler for
 * why.
 */
export function hasAssumptionsBlock(text: string): boolean {
	let inFence = false;
	return text.split("\n").some((rawLine) => {
		const trimmed = rawLine.trim();
		// A fence delimiter line toggles the state rather than being matched
		// itself — three or more backticks or tildes, optionally followed by a
		// language tag, which is the entire line either way.
		if (/^(`{3,}|~{3,})/.test(trimmed)) {
			inFence = !inFence;
			return false;
		}
		if (inFence || trimmed.startsWith(">")) return false;
		// Strip one leading heading marker, then one leading emphasis wrapper —
		// "## **ASSUMPTIONS:**" needs both, in that order, to expose the marker.
		const unheaded = trimmed.replace(/^#{1,6}\s+/, "");
		const unwrapped = unheaded.startsWith("**") || unheaded.startsWith("__") ? unheaded.slice(2) : unheaded.startsWith("*") ? unheaded.slice(1) : unheaded;
		return /^assumptions:/i.test(unwrapped);
	});
}
