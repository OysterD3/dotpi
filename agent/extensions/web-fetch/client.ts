/**
 * HTTP client for Exa's /contents endpoint.
 *
 * Verified against the live API, not just the docs:
 *   - Options are TOP-LEVEL here (`text`, `summary`, `highlights`), unlike /search where
 *     they nest under `contents`. Passing the nested shape is silently ignored — it
 *     returned full default text instead of the requested cap, with no error.
 *   - `maxCharacters` and `max_characters` are both accepted; camelCase is used here.
 *   - `summary: {query}` and `highlights: {query}` both work and are dramatically cheaper
 *     in tokens than full text (490 vs 18,668 characters on a docs page).
 *   - Failed URLs do NOT appear in `results`; they appear only in `statuses` with an
 *     error tag such as SOURCE_NOT_AVAILABLE or CRAWL_NETWORK_ERROR.
 *
 * Because Exa performs the fetch, this tool cannot reach the local network. That rules
 * out SSRF against localhost and private ranges by construction, and it also means
 * intranet URLs simply will not work.
 */

import { CONFIG, CONTENTS_URL } from "./config.ts";
import type { ContentsResponse, FetchMode } from "./types.ts";

/**
 * Reject anything that isn't a plain web URL before it leaves the machine.
 * Returns an error message, or undefined when the URL is acceptable.
 */
export function validateUrl(raw: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		return `Not a valid absolute URL: ${raw}`;
	}
	if (!CONFIG.allowedProtocols.includes(parsed.protocol)) {
		return `Refusing ${parsed.protocol} URL (only ${CONFIG.allowedProtocols.join(", ")} are allowed): ${raw}`;
	}
	return undefined;
}

/** Build the request body. Options are top-level; see the note above. */
export function buildBody(urls: string[], mode: FetchMode, maxChars: number, query?: string) {
	const focused = query?.trim();
	return {
		urls,
		...(mode === "summary" && focused
			? {
					summary: { query: focused },
					highlights: { query: focused },
				}
			: { text: { maxCharacters: maxChars } }),
		...(CONFIG.maxAgeHours !== undefined ? { maxAgeHours: CONFIG.maxAgeHours } : {}),
	};
}

/**
 * POST to Exa, honoring both the caller's abort signal and our own timeout.
 * Error bodies are surfaced; the request headers, which carry the key, never are.
 */
export async function getContents(
	apiKey: string,
	body: unknown,
	signal: AbortSignal | undefined,
): Promise<ContentsResponse> {
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
		const response = await fetch(CONTENTS_URL, {
			method: "POST",
			headers: { "x-api-key": apiKey, "Content-Type": "application/json" },
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
			throw new Error(`Exa fetch failed: ${response.status} ${response.statusText}. ${detail}`);
		}

		return (await response.json()) as ContentsResponse;
	} catch (error) {
		if (timedOut) {
			throw new Error(`Exa fetch timed out after ${Math.round(CONFIG.timeoutMs / 1000)}s.`);
		}
		if (signal?.aborted) throw new Error("Fetch aborted.");
		throw error;
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
