/**
 * The main-agent guidance for ask_user: the tool description the model reads,
 * the one-line prompt snippet, and the guideline bullets pi appends to the
 * system prompt while the tool is active.
 *
 * Adapted from Claude Code's AskUserQuestion tool (its guidance ships in the
 * client and steers the model toward using the tool only for genuine user
 * decisions, not for anything it can resolve itself). Reworded for pi and this
 * tool's shape; not a verbatim copy.
 *
 * The question cap is interpolated from CONFIG rather than written out, because
 * the schema derives its `maxItems` from the same constant: a hardcoded "4" here
 * would go on telling the model to send four after the constant dropped to
 * three, and the validator would reject every call it made.
 */
import { CONFIG } from "./config.ts";

export const ASK_USER_DESCRIPTION = [
	`Put your open decisions to the user — up to ${CONFIG.maxQuestions} of them in one call — and wait for the answers. Use this only when you are blocked on a decision that is genuinely the user's to make, one you cannot resolve from the request, the code, or a sensible default.`,
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
	"Do NOT use this to ask permission for an action you should just take, to confirm something you can verify yourself, or to offload a judgment call the task already answers. Prefer acting on a reasonable default and telling the user what you assumed.",
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
	"Only ask the user (ask_user) when genuinely blocked on a decision that is theirs to make; otherwise pick a sensible default, act, and say what you assumed.",
	"When you do ask, offer 2-4 concrete, mutually exclusive options; a free-text row is added automatically, so never add an \"Other\" option.",
	"Mark your own pick with `recommended: true` on that one option (with the reason in its description) when you have a view — it is badged and pre-focused. Skip it when you genuinely don't, rather than recommending something for the sake of it.",
	`Send the decisions you are already blocked on in one ask_user call (up to ${CONFIG.maxQuestions} questions), never one call per question — the user answers a batch in a single pass but pays for each separate call. Leave out any question whose premise one of the others could remove; there is no branching, so ask that one afterwards.`,
	"A note attached to an answer is the user's qualification of that answer; honour it as a constraint rather than folding it into the choice.",
];
