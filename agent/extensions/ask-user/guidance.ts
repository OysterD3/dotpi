/**
 * The main-agent guidance for ask_user: the tool description the model reads,
 * the one-line prompt snippet, and the guideline bullets pi appends to the
 * system prompt while the tool is active.
 *
 * The guidance is written against TWO failure modes, and it used to name only
 * one. Asking permission instead of doing the work is the noisy one, and every
 * line here pushed against it: "only when", "genuinely", "cannot resolve",
 * "do NOT", "prefer acting on a reasonable default". Nothing said when asking
 * was right, so the tool went unused where it mattered — the model guessed on
 * decisions it had no way to guess, and the guess surfaced at the end as work
 * built on the wrong premise.
 *
 * The quiet failure is worse because it is invisible: a needless question costs
 * one interruption, and a wrong assumption can cost the whole task. So the
 * positive case is stated first and concretely — different readings leading to
 * different work, choices that get baked in, facts that live only in the user's
 * head — and the prohibitions keep their force but come after, scoped to what
 * they were always about: permission, verification, and handing back judgment
 * the task already settles.
 *
 * The question cap is interpolated from CONFIG rather than written out, because
 * the schema derives its `maxItems` from the same constant: a hardcoded "4" here
 * would go on telling the model to send four after the constant dropped to
 * three, and the validator would reject every call it made.
 */
import { CONFIG } from "./config.ts";

export const ASK_USER_DESCRIPTION = [
	`Put your open decisions to the user — up to ${CONFIG.maxQuestions} of them in one call — and wait for the answers. Use it for decisions that are genuinely the user's to make: the ones you cannot settle from the request, the code, or a sensible default.`,
	"",
	"Ask when being wrong is expensive. The test is not whether you COULD pick something — you almost always could — but what it costs if the pick is wrong. Ask when:",
	"  - two readings of the request lead to materially different work, so the answer changes what you build rather than how you word it;",
	"  - the choice gets baked into something later work depends on — a schema, an API shape, a data model, a dependency, a file layout;",
	"  - the answer is a preference, a priority, or a business rule that exists nowhere in the repo and cannot be derived from it;",
	"  - you are about to spend significant time or money on an assumption, and confirming it first is cheap by comparison.",
	"",
	"One question before the work costs the user a single interruption. Discovering at the end that the whole thing was built on the wrong premise costs them the work, and you cannot give that back. When the two are close, ask.",
	"",
	`Ask the related decisions together. Before calling, look at what else you are already blocked on: every question that stands on its own belongs in this call, up to ${CONFIG.maxQuestions}. The user sees them together, moves between them with the arrow keys, and reviews every answer before anything is sent, so ${CONFIG.maxQuestions} questions in one call cost them one interruption while ${CONFIG.maxQuestions} calls cost them ${CONFIG.maxQuestions}.`,
	"",
	"Never batch a question whose premise another answer could remove. All the questions are shown at once and there is no branching, so a follow-up that only makes sense given one particular answer ('which Postgres migration tool?' alongside 'Postgres or SQLite?') forces the user to answer something meaningless and hands you a contradictory answer set. Ask that one afterwards, once you know.",
	"",
	"For each question the user can:",
	"  - pick one of your options (or several, when multiSelect is set),",
	"  - type their own answer into the free-text row, or",
	"  - annotate any answer with a note.",
	"",
	"Provide 2-4 concise, mutually exclusive options when you can; omit options entirely for an open-ended question. A free-text row is always present, so never add an \"Other\" option yourself.",
	"",
	"If you lean one way, set `recommended: true` on that one option and give the reason in its description. It is badged \"Recommended\" and starts focused, so the user accepts it with a single key. Recommend at most one option per question, and only when you actually have a view — marking every question's first option teaches the user to ignore the badge. Do not put \"(Recommended)\" in the label.",
	"",
	"A note is the user qualifying an answer, not the answer itself — it arrives labelled as a note. Treat it as a constraint on how you carry the answer out.",
	"",
	"Do NOT use this to ask permission for an action you should just take, to confirm something you could verify yourself, or to hand back a judgment call the task already answers. The line is whether the answer is information only the user has: if the code or the request can tell you, go and find out instead, act on it, and say what you assumed.",
	"",
	"Returns each question with the user's answer and any notes, or that they dismissed the questions.",
].join("\n");

/**
 * The one line about this tool that is in the system prompt on every turn, so
 * it is the only place the batching is certain to be read *before* the model
 * has framed a question. "A decision" here taught the singular by omission.
 */
export const ASK_USER_SNIPPET = `Ask the user up to ${CONFIG.maxQuestions} questions at once when blocked on decisions only they can make`;

export const ASK_USER_GUIDELINES = [
	"Ask the user (ask_user) when the answer is theirs to give and being wrong is expensive: two readings that lead to different work, a choice that gets baked into a schema or an API other work depends on, a preference or business rule that is nowhere in the repo, or a long piece of work about to rest on an assumption. One interruption is cheaper than building the wrong thing.",
	"Do not ask for permission to act, for confirmation of something you could check yourself, or to hand back a judgment the task already settles — find out, act, and say what you assumed.",
	"When you do ask, offer 2-4 concrete, mutually exclusive options; a free-text row is added automatically, so never add an \"Other\" option.",
	"Mark your own pick with `recommended: true` on that one option (with the reason in its description) when you have a view — it is badged and pre-focused. Skip it when you genuinely don't, rather than recommending something for the sake of it.",
	`Send the decisions you are already blocked on in one ask_user call (up to ${CONFIG.maxQuestions} questions), never one call per question — the user answers a batch in a single pass but pays for each separate call. Leave out any question whose premise one of the others could remove; there is no branching, so ask that one afterwards.`,
	"A note attached to an answer is the user's qualification of that answer; honour it as a constraint rather than folding it into the choice.",
];
