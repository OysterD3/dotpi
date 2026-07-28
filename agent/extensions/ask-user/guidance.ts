/**
 * The main-agent guidance for ask_user: the tool description the model reads,
 * the one-line prompt snippet, and the guideline bullets pi appends to the
 * system prompt while the tool is active.
 *
 * Adapted from Claude Code's AskUserQuestion tool (its guidance ships in the
 * client and steers the model toward using the tool only for genuine user
 * decisions, not for anything it can resolve itself). Reworded for pi and this
 * tool's shape; not a verbatim copy.
 */

export const ASK_USER_DESCRIPTION = [
	"Ask the user one or more questions and wait for their answers. Use this only when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or a sensible default.",
	"",
	"Pass 1-4 questions in `questions`. They are shown together: the user moves between them with the arrow keys and reviews every answer before anything is sent, so asking two related questions in one call is better than two calls.",
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

export const ASK_USER_SNIPPET = "Ask the user when blocked on a decision only they can make";

export const ASK_USER_GUIDELINES = [
	"Only ask the user (ask_user) when genuinely blocked on a decision that is theirs to make; otherwise pick a sensible default, act, and say what you assumed.",
	"When you do ask, offer 2-4 concrete, mutually exclusive options; a free-text row is added automatically, so never add an \"Other\" option.",
	"Mark your own pick with `recommended: true` on that one option (with the reason in its description) when you have a view — it is badged and pre-focused. Skip it when you genuinely don't, rather than recommending something for the sake of it.",
	"Ask related questions together in one ask_user call (up to 4) rather than one call each — the user answers them in a single pass.",
	"A note attached to an answer is the user's qualification of that answer; honour it as a constraint rather than folding it into the choice.",
];
