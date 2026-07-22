/**
 * Tunables for the Exa-backed web search tool.
 *
 * Everything adjustable lives here so the client and formatting modules stay logic-only.
 */

export const SEARCH_URL = "https://api.exa.ai/search";

/** Exa's documented category filter values. */
export const CATEGORIES = [
	"company",
	"publication",
	"news",
	"personal site",
	"financial report",
	"people",
] as const;

/**
 * Categories that make Exa reject `excludeDomains` and both date filters with a 400.
 * See the "COMMON PARAMETER MISTAKES" section of the coding-agent guide.
 */
export const RESTRICTIVE_CATEGORIES = new Set<string>(["company", "people"]);

export const CONFIG = {
	/** Results returned when the model doesn't ask for a specific number. */
	defaultNumResults: 5,
	/** Hard ceiling, regardless of what the model asks for. Exa's own max is 100. */
	maxNumResults: 25,
	/**
	 * Request Exa's query-relevant highlight excerpts. This is the recommended default for
	 * agent workflows — token cost stays predictable because Exa only returns the relevant
	 * sentences rather than whole pages.
	 */
	includeHighlights: true,
	/**
	 * Also request full page text. Off by default: requesting text you don't use still
	 * transfers (and bills for) it. Turn on when downstream reasoning genuinely needs
	 * broad page context rather than excerpts.
	 */
	includeText: false,
	/** Hard cap on extracted text length, only applies when includeText is true. */
	maxCharsPerResult: 1200,
	/** Highlights kept per result. */
	maxHighlights: 3,
	/**
	 * Cap on each highlight. Exa's highlights are not short — a single one can run past
	 * 1500 characters, so three of them across five results is a five-figure character
	 * dump. Truncating here is what actually makes token cost predictable.
	 */
	maxCharsPerHighlight: 300,
	/**
	 * Drop results whose URL matches an earlier one once the query string and fragment are
	 * removed. Exa readily returns `/pricing`, `/pricing?tab=api` and `/pricing?tab=websets`
	 * as three separate hits, which otherwise eats the whole result budget on one page.
	 */
	dedupeByUrl: true,
	/**
	 * When deduping, ask Exa for this many results even if fewer were requested, so
	 * duplicates don't eat the result budget. Exa's base price covers up to 10 results per
	 * request ("Base price, with up to 10 results"; additional results bill separately), so
	 * over-fetching to 10 costs nothing. Raise only if you accept the extra per-result cost.
	 */
	freeResultCeiling: 10,
	/**
	 * Cache freshness in hours. Omitted by default, which is Exa's recommended balance
	 * (use cache when present, livecrawl as fallback). 0 forces a livecrawl on every
	 * result and is markedly slower; -1 never livecrawls.
	 */
	maxAgeHours: undefined as number | undefined,
	/** Abort a search that takes longer than this. */
	timeoutMs: 20_000,
	/**
	 * Exa search mode. "auto" lets Exa pick between keyword and neural search.
	 * Options: instant | fast | auto | deep-lite | deep | deep-reasoning.
	 * The deep modes cost significantly more and are much slower.
	 */
	searchType: "auto",
	/** Visual lines of result shown before the output is collapsed. Ctrl+O expands. */
	collapsedLines: 8,
};
