/**
 * Shared constants and types for the ask-user extension.
 *
 * ask_user is a tool the main agent calls to pause and put a decision back to
 * the human. One call may carry
 * several questions; each offers suggested options plus a free-text row, any
 * answer can be annotated with a note, and the user reviews everything before it
 * is sent.
 *
 * This needs a bespoke component with in-dialog key bindings. pi's
 * select/input/confirm dialogs cannot bind keys inside themselves, so this uses
 * `ctx.ui.custom()` — a real focused component (prompt.ts) driving a pure state
 * machine (interaction.ts).
 *
 * There is deliberately NO off switch. An agent that asks when a decision is
 * genuinely the user's is not a preference to be tuned, it is how the agent is
 * supposed to behave, and every knob here was a way to end up back where this
 * started: a tool that exists and never gets used. The only condition on it is
 * a real user being present to answer, which is a fact about the session
 * rather than a choice. Everything below is a tunable — a cap, a placeholder,
 * a badge, a mutation threshold — not a switch.
 *
 * The one settings key this file's DEFAULTS feed (askUser.contractModels, read
 * by settings.ts) is not an exception to that: it does not silence anything.
 * It only chooses which of two always-on nudge wordings a model gets — see
 * style.ts and nudge.ts's header for why a second wording exists.
 */

/** The tool name the model calls. Snake_case, as requested. */
export const TOOL_NAME = "ask_user";

/**
 * customType on the hidden message carrying the opening nudge. It marks the
 * entry in the session file, which is how a resumed session can tell that the
 * reminder already went out on an earlier turn.
 */
export const NUDGE_ENTRY_TYPE = "ask-user-nudge";

/**
 * customType on the hidden message carrying the compliance follow-up (see
 * CONFIG.followUp below and nudge.ts). Distinct from NUDGE_ENTRY_TYPE so the
 * two are told apart in the session file — one is the opening reminder, the
 * other is what fires when that reminder was read and ignored.
 */
export const FOLLOWUP_ENTRY_TYPE = "ask-user-followup";

/**
 * pi.events channel announcing that a question owns the prompt. Payload:
 * `{ active, blocking, question, header?, count, sessionId?, cwd? }` when it
 * opens, and `{ active: false, blocking }` when it is answered or dismissed.
 *
 * Three subscribers today, for three different reasons:
 *   - the statusline blanks itself while a question is up, so the question owns
 *     the bottom of the screen. This extension cannot do that itself —
 *     `ui.setFooter(undefined)` restores pi's *built-in* footer, so swapping and
 *     restoring here would retire another extension's footer for good.
 *   - cmux-notify raises the pane, because a question stops pi on a human just
 *     as a permission prompt does.
 *   - elapsed stops the turn clock, so a turn's duration keeps meaning how long
 *     the agent worked rather than how long someone took to decide.
 *
 * `blocking` is false for the `/ask-user test` demo: the prompt is on screen but
 * the agent is not stuck behind it. The two subscribers that act on "the agent
 * has stopped" honour it; the statusline does not, because the demo does own the
 * bottom of the screen either way.
 *
 * The payload carries the question and not merely the flag because a subscriber
 * that has to interrupt someone needs to say what for. Same decoupling ultracode
 * uses for its workflow lines — announce, and let the listener decide.
 */
export const ASK_CHANNEL = "ask-user:asking";

export const CONFIG = {
	/**
	 * Shown in the free-text row while it is empty. This row replaces the old
	 * "Other" entry: there is nothing to select and then be prompted by — the
	 * user simply types here.
	 */
	customPlaceholder: "Type my own answer",
	/**
	 * Badge on the option the model recommends. Kept short so it rides on the end
	 * of the label line rather than pushing the answer around, and glyph-led so it
	 * scans as a mark rather than as part of the answer text.
	 */
	recommendedBadge: "★ Recommended",
	/** Hard cap on options per question; extra are dropped. */
	maxOptions: 8,
	/** Hard cap on questions per call. */
	maxQuestions: 4,
	/**
	 * Rows kept for the conversation above the prompt. A tall question scrolls
	 * its option list rather than shoving the whole transcript off screen.
	 */
	screenReserve: 8,
	/** Row count assumed when the host cannot report one (tests, odd terminals). */
	assumedRows: 24,
	/**
	 * The opening nudge fires at most once in this many interactive turns.
	 * Guards against a session of successive task statements each pulling the
	 * same reminder in; the previous one is still in context and still applies.
	 */
	nudgeCooldownTurns: 8,
	/**
	 * The compliance follow-up: once the opening nudge has gone out, this is how
	 * many files may be created or edited with zero ask_user calls in between
	 * before a second, sharper reminder rides in. This is what closes the actual
	 * benchmark gap — a model that reads the opening nudge and keeps building
	 * regardless has no other checkpoint, and by the time it stops on its own
	 * the wrong guess is already load-bearing across every file it touched.
	 *
	 * A threshold, not a toggle, for the same reason nudgeCooldownTurns is one:
	 * tunable, but there is no value that turns it off, because a model that
	 * never checks back in is exactly the failure this exists to catch.
	 */
	followUp: {
		afterMutations: 5,
		/**
		 * Contract style only (see style.ts): once the follow-up has fired and
		 * the model is STILL neither asking nor printing an ASSUMPTIONS block,
		 * this is how many FURTHER distinct files buy it another reminder. The
		 * socratic path has no equivalent — it stays a one-shot latch per
		 * arming, because the benchmark this schedule answers for
		 * (nudge.ts's header) is specifically the OpenAI-family failure mode:
		 * a model that reads one reminder, does not comply, and keeps going
		 * for the rest of the run. One reminder was already proven not to be
		 * enough for that model family; re-arming on a schedule is what a
		 * second, unconditional checkpoint looks like.
		 */
		rearmMutations: 15,
		/**
		 * Contract style only: hard cap on firings per unsatisfied run, so
		 * persistent silence gets a bounded number of reminders rather than
		 * one every rearmMutations forever — a schedule that never stopped
		 * would just be nudgeCooldownTurns's failure mode again, spam that
		 * trains the model to skim past it. Compliance — an ask_user call OR
		 * a printed ASSUMPTIONS block, see index.ts and nudge.ts's
		 * hasAssumptionsBlock — resets this alongside the mutation count, the
		 * same re-arm-on-ask semantics the socratic latch already has, so a
		 * session that goes quiet again after complying gets the full budget
		 * back rather than being silenced for the rest of the run.
		 */
		maxFollowUps: 3,
	},
	/**
	 * The "asking contract": which models get CONTRACT_NUDGE (imperative,
	 * artifact-bearing) instead of OPENING_NUDGE (judgment-based) — see
	 * style.ts and nudge.ts's header for why a second wording exists at all.
	 * Provider-level by default, because the benchmark gap this closes is
	 * provider-wide (OpenAI-family models across the board do not ask on
	 * their own), not one specific model ID.
	 *
	 * Entries are "provider" (matches every model under that provider) or
	 * "provider/modelId" (matches one model; either half may end in "*" as a
	 * wildcard). REPLACED, not merged, by askUser.contractModels in
	 * settings.json — see settings.ts. This is the one settings key this
	 * extension has, and it does not turn anything off: an unmatched model
	 * still gets a nudge, just the other wording. That is why it does not
	 * compromise the "no off switch" stance in the file header above.
	 *
	 * "openai" and "openai-codex" are not the whole surface: pi-ai's
	 * KnownProvider list (@earendil-works/pi-ai's types.d.ts) has GPT-family
	 * models reachable through several OTHER providers, each missed by those
	 * two alone, and each entry below exists for one of them:
	 *
	 *   - "azure-openai-responses" — Azure's Responses API surface for OpenAI
	 *     models is its OWN KnownProvider, distinct from "openai"; the model
	 *     is the same model with the same benchmark gap, only routed
	 *     differently, so this is bare-provider like the two above.
	 *   - "openrouter/openai/gpt-*" and "vercel-ai-gateway/openai/gpt-*" —
	 *     both aggregators publish OpenAI models under an "openai/" namespace
	 *     IN THE MODEL ID itself (e.g. "openai/gpt-5.6-sol"), not as a
	 *     separate provider, so a bare "openrouter"/"vercel-ai-gateway" entry
	 *     would net every OTHER vendor's models those gateways also carry —
	 *     matchesPattern (style.ts) builds its match target as
	 *     `${provider}/${id}` and compares the WHOLE pattern against that
	 *     whole string (no split on the pattern side), so a slash inside the
	 *     model id is just more literal text to match, not a delimiter to
	 *     trip over.
	 *   - "github-copilot/gpt-*" — same GPT-family gap, but Copilot's ids are
	 *     bare ("gpt-5.6-sol", no "openai/" namespace), so the glob omits it.
	 */
	contractModels: [
		"openai",
		"openai-codex",
		"azure-openai-responses",
		"openrouter/openai/gpt-*",
		"github-copilot/gpt-*",
		"vercel-ai-gateway/openai/gpt-*",
	],
} as const;
