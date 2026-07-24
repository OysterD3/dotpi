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
	"Ask the user a question and wait for their answer. Use this only when you are blocked on a decision that is genuinely the user's to make — one you cannot resolve from the request, the code, or a sensible default.",
	"",
	"The user is shown your question with your suggested options and can:",
	"  - pick one of your options (or several, when multiSelect is set),",
	'  - choose "Other" and type their own answer,',
	"  - attach an optional note to their answer, or",
	"  - decline to answer (optionally with a reason).",
	"",
	"Provide 2-4 concise, mutually exclusive options when you can; omit options entirely for an open-ended question. Whatever you pass, an \"Other\" choice is always added, so never add one yourself.",
	"",
	"Do NOT use this to ask permission for an action you should just take, to confirm something you can verify yourself, or to offload a judgment call the task already answers. Prefer acting on a reasonable default and telling the user what you assumed.",
	"",
	"Returns the user's selection (and any note), or that they declined or dismissed the question.",
].join("\n");

export const ASK_USER_SNIPPET = "Ask the user a question when blocked on a decision only they can make";

export const ASK_USER_GUIDELINES = [
	"Only ask the user (ask_user) when genuinely blocked on a decision that is theirs to make; otherwise pick a sensible default, act, and say what you assumed.",
	"When you do ask, offer 2-4 concrete, mutually exclusive options; an \"Other\" and a decline path are added automatically.",
];
