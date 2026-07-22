/**
 * HTTP client for Exa's /search endpoint.
 *
 * Verified against the canonical coding-agent guide:
 * https://exa.ai/docs/reference/search-api-guide-for-coding-agents
 *
 *   POST https://api.exa.ai/search
 *   Header: x-api-key: <key>
 *   Body:   { query, type, numResults, category?, includeDomains?, excludeDomains?,
 *             startPublishedDate?, endPublishedDate?, contents: {...} }
 *   Reply:  { requestId, results: [...], costDollars: { total } }
 *
 * Note that `text`/`highlights` must be nested inside `contents` on /search — they are
 * top-level only on /contents. Getting that wrong is the most common Exa mistake.
 */

import { CONFIG, RESTRICTIVE_CATEGORIES, SEARCH_URL } from "./config.ts";
import type { ExaResponse, SearchFilters } from "./types.ts";

/**
 * Reject filter combinations Exa answers with a 400, before spending a request on them.
 * Returns an error message, or undefined when the combination is fine.
 */
export function validateFilters(filters: SearchFilters): string | undefined {
	if (!filters.category || !RESTRICTIVE_CATEGORIES.has(filters.category)) return undefined;

	const unsupported = [
		filters.excludeDomains?.length ? "excludeDomains" : undefined,
		filters.startPublishedDate ? "startPublishedDate" : undefined,
		filters.endPublishedDate ? "endPublishedDate" : undefined,
	].filter((field): field is string => field !== undefined);

	if (unsupported.length === 0) return undefined;
	return (
		`Exa rejects category "${filters.category}" combined with ${unsupported.join(", ")}. ` +
		"Retry without those filters, or drop the category."
	);
}

/** Build the request body, omitting every filter the caller didn't set. */
export function buildBody(query: string, numResults: number, filters: SearchFilters) {
	return {
		query,
		type: CONFIG.searchType,
		numResults,
		...(filters.category ? { category: filters.category } : {}),
		...(filters.includeDomains?.length ? { includeDomains: filters.includeDomains } : {}),
		...(filters.excludeDomains?.length ? { excludeDomains: filters.excludeDomains } : {}),
		...(filters.startPublishedDate ? { startPublishedDate: filters.startPublishedDate } : {}),
		...(filters.endPublishedDate ? { endPublishedDate: filters.endPublishedDate } : {}),
		contents: {
			...(CONFIG.includeHighlights ? { highlights: true } : {}),
			...(CONFIG.includeText ? { text: { maxCharacters: CONFIG.maxCharsPerResult } } : {}),
			...(CONFIG.maxAgeHours !== undefined ? { maxAgeHours: CONFIG.maxAgeHours } : {}),
		},
	};
}

/**
 * POST to Exa, honoring both the caller's abort signal and our own timeout.
 *
 * Error bodies are surfaced because Exa returns useful validation messages, but the
 * request headers — which carry the key — never are.
 */
export async function search(
	apiKey: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<ExaResponse> {
	const controller = new AbortController();
	const onAbort = () => controller.abort();
	if (signal?.aborted) controller.abort();
	else signal?.addEventListener("abort", onAbort, { once: true });

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, CONFIG.timeoutMs);

	try {
		const response = await fetch(SEARCH_URL, {
			method: "POST",
			headers: {
				"x-api-key": apiKey,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: controller.signal,
		});

		if (!response.ok) {
			const detail = (await response.text().catch(() => "")).slice(0, 500);
			if (response.status === 401 || response.status === 403) {
				throw new Error(`Exa rejected the API key (${response.status}). Check EXA_API_KEY.`);
			}
			if (response.status === 429) {
				throw new Error("Exa rate limit reached (429). Wait a moment and retry.");
			}
			throw new Error(`Exa search failed: ${response.status} ${response.statusText}. ${detail}`);
		}

		return (await response.json()) as ExaResponse;
	} catch (error) {
		if (timedOut) {
			throw new Error(`Exa search timed out after ${Math.round(CONFIG.timeoutMs / 1000)}s.`);
		}
		if (signal?.aborted) throw new Error("Search aborted.");
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
