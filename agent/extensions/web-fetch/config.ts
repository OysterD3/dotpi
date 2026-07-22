/**
 * Tunables for the web fetch tool.
 *
 * Token budget notes, measured against the live API rather than assumed:
 *   - `maxCharacters` genuinely caps the payload (asked 500, got exactly 500).
 *   - `text.verbosity: "compact"` made NO difference — a docs page returned an identical
 *     18,668 characters under both "compact" and "full". The documented knob does not
 *     appear to be implemented on /contents, so the character cap is the real control.
 *   - Options are TOP-LEVEL on /contents. Passing the /search-style nested `contents: {...}`
 *     is silently ignored: it returned the full 4,056-char default instead of the 500 cap,
 *     with no error. Getting this wrong wastes tokens invisibly.
 */

export const CONTENTS_URL = "https://api.exa.ai/contents";

export const CONFIG = {
	/** Characters of page text returned per URL. The main defense against context blowout. */
	maxCharsPerPage: 6000,
	/** Ceiling the model can request per page. */
	maxCharsCeiling: 20_000,
	/** URLs accepted in a single call. Batched into one request. */
	maxUrls: 5,
	/** Highlights kept per page when a focus query is supplied. */
	maxHighlights: 5,
	/** Cap on each individual highlight. */
	maxCharsPerHighlight: 400,
	/** Abort a fetch that takes longer than this. */
	timeoutMs: 30_000,
	/**
	 * Cache freshness in hours. Omitted by default (use cache, livecrawl as fallback).
	 * 0 forces a livecrawl and is markedly slower; -1 never livecrawls.
	 */
	maxAgeHours: undefined as number | undefined,
	/** Visual lines of result shown before the output is collapsed. Ctrl+O expands. */
	collapsedLines: 8,
	/** Schemes the tool will pass through. Everything else is refused. */
	allowedProtocols: ["http:", "https:"],
};

/**
 * Fence markers wrapping untrusted content. Randomised per process so a page author
 * cannot hard-code the closing marker to break out of the fence and inject text that
 * appears to come from the tool itself.
 */
export const FENCE_ID = Math.random().toString(36).slice(2, 10).toUpperCase();
export const FENCE_BEGIN = `<<<UNTRUSTED_WEB_CONTENT_${FENCE_ID}`;
export const FENCE_END = `UNTRUSTED_WEB_CONTENT_${FENCE_ID}>>>`;
