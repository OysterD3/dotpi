/**
 * Web search for pi, backed by Exa (https://exa.ai).
 *
 * Registers a single `web_search` tool the model can call. Results come back as compact
 * markdown — title, URL, date, and a snippet per hit — rather than raw page dumps, so a
 * search costs a predictable slice of context instead of blowing the window.
 *
 * API (verified against the canonical coding-agent guide:
 * https://exa.ai/docs/reference/search-api-guide-for-coding-agents):
 *   POST https://api.exa.ai/search
 *   Header: x-api-key: <key>
 *   Body:   { query, type, numResults, category?, includeDomains?, excludeDomains?,
 *             startPublishedDate?, endPublishedDate?, contents: {...} }
 *   Reply:  { requestId, results: [{title, url, publishedDate, author, text, highlights}],
 *             costDollars: { total } }
 *
 * Credentials: read from the EXA_API_KEY environment variable only. Deliberately not from
 * settings.json — this config directory is a public git repo, and a key committed there is
 * a key leaked. Get one at https://dashboard.exa.ai/api-keys, then add to your shell rc:
 *
 *   export EXA_API_KEY="..."
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SEARCH_URL = "https://api.exa.ai/search";

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
	/** Append Exa's reported dollar cost to the tool output. */
	showCost: true,
};

/** Exa's documented category filter values. */
const CATEGORIES = [
	"company",
	"publication",
	"news",
	"personal site",
	"financial report",
	"people",
] as const;

type ExaResult = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string | null;
	text?: string;
	highlights?: string[];
};

type ExaResponse = {
	requestId?: string;
	results?: ExaResult[];
	costDollars?: { total?: number };
};

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description:
			"Search the web via Exa and return ranked results with titles, URLs, publication " +
			"dates and content snippets. Use for current events, documentation, or any fact " +
			"that may postdate your training data. Prefer a specific natural-language query " +
			"over keywords.",
		promptSnippet: "Search the web for current information via Exa",
		promptGuidelines: [
			"Use web_search when a question depends on information that may be newer than your training data, or when you need to cite a source.",
			"Cite the URL returned by web_search when reporting anything it found; do not present searched claims as your own knowledge.",
		],
		parameters: Type.Object({
			query: Type.String({
				minLength: 1,
				description: "The search query, phrased as a natural-language sentence.",
			}),
			numResults: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: CONFIG.maxNumResults,
					description: `How many results to return (default ${CONFIG.defaultNumResults}).`,
				}),
			),
			// Note for the model: "company" and "people" disable excludeDomains and both date
			// filters. Exa returns 400 if they're combined; execute() rejects that up front.
			category: Type.Optional(StringEnum(CATEGORIES)),
			includeDomains: Type.Optional(
				Type.Array(Type.String(), {
					description: "Only return results from these domains, e.g. ['arxiv.org'].",
				}),
			),
			excludeDomains: Type.Optional(
				Type.Array(Type.String(), { description: "Never return results from these domains." }),
			),
			startPublishedDate: Type.Optional(
				Type.String({ description: "Only results published on/after this ISO 8601 date." }),
			),
			endPublishedDate: Type.Optional(
				Type.String({ description: "Only results published on/before this ISO 8601 date." }),
			),
		}),

		async execute(_toolCallId, params, signal, onUpdate) {
			const apiKey = process.env.EXA_API_KEY?.trim();
			if (!apiKey) {
				throw new Error(
					"EXA_API_KEY is not set. Get a key at https://dashboard.exa.ai/api-keys and " +
						'add `export EXA_API_KEY="..."` to your shell profile, then restart pi.',
				);
			}

			// Exa returns 400 when these categories are combined with domain exclusion or date
			// filters. Fail here with an actionable message instead of burning a request on a
			// rejection the model can't interpret.
			if (params.category === "company" || params.category === "people") {
				const unsupported = [
					params.excludeDomains?.length ? "excludeDomains" : undefined,
					params.startPublishedDate ? "startPublishedDate" : undefined,
					params.endPublishedDate ? "endPublishedDate" : undefined,
				].filter(Boolean);
				if (unsupported.length > 0) {
					throw new Error(
						`Exa rejects category "${params.category}" combined with ${unsupported.join(", ")}. ` +
							"Retry without those filters, or drop the category.",
					);
				}
			}

			onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

			const wanted = Math.min(params.numResults ?? CONFIG.defaultNumResults, CONFIG.maxNumResults);
			// Over-fetch into the free tier so dedupe doesn't shrink the result set below what
			// was asked for.
			const numResults = CONFIG.dedupeByUrl ? Math.max(wanted, CONFIG.freeResultCeiling) : wanted;

			const body = {
				query: params.query,
				type: CONFIG.searchType,
				numResults,
				...(params.category ? { category: params.category } : {}),
				...(params.includeDomains?.length ? { includeDomains: params.includeDomains } : {}),
				...(params.excludeDomains?.length ? { excludeDomains: params.excludeDomains } : {}),
				...(params.startPublishedDate ? { startPublishedDate: params.startPublishedDate } : {}),
				...(params.endPublishedDate ? { endPublishedDate: params.endPublishedDate } : {}),
				contents: {
					...(CONFIG.includeHighlights ? { highlights: true } : {}),
					...(CONFIG.includeText ? { text: { maxCharacters: CONFIG.maxCharsPerResult } } : {}),
					...(CONFIG.maxAgeHours !== undefined ? { maxAgeHours: CONFIG.maxAgeHours } : {}),
				},
			};

			const payload = await postSearch(apiKey, body, signal);
			const raw = payload.results ?? [];
			const unique = dedupe(raw);
			const results = unique.slice(0, wanted);
			const dropped = raw.length - unique.length;
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${params.query}".` }],
					details: { query: params.query, results: [], requestId: payload.requestId },
				};
			}

			const rendered = results.map((result, index) => formatResult(result, index + 1)).join("\n\n");
			// Say so rather than silently returning fewer results than were asked for.
			const deduped = dropped > 0 ? ` (${dropped} duplicate URL(s) omitted)` : "";
			const cost =
				CONFIG.showCost && typeof payload.costDollars?.total === "number"
					? `\n\n_Exa cost: $${payload.costDollars.total.toFixed(4)}_`
					: "";

			return {
				content: [
					{
						type: "text",
						text: `${results.length} result(s) for "${params.query}"${deduped}:\n\n${rendered}${cost}`,
					},
				],
				details: {
					query: params.query,
					requestId: payload.requestId,
					costDollars: payload.costDollars?.total,
					results: results.map((result) => ({ title: result.title, url: result.url })),
				},
			};
		},
	});
}

/**
 * POST to Exa, honoring both the caller's abort signal and our own timeout.
 *
 * Error bodies are included because Exa returns useful validation messages, but the
 * request headers (which carry the key) never are.
 */
async function postSearch(
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

function formatResult(result: ExaResult, position: number): string {
	const title = result.title?.trim() || "(untitled)";
	const lines = [`${position}. **${title}**`];
	if (result.url) lines.push(`   ${result.url}`);

	const meta = [
		result.publishedDate ? result.publishedDate.slice(0, 10) : undefined,
		result.author?.trim() || undefined,
	].filter(Boolean);
	if (meta.length > 0) lines.push(`   ${meta.join(" · ")}`);

	const highlights = result.highlights?.filter((h) => h.trim()) ?? [];
	if (highlights.length > 0) {
		for (const highlight of highlights.slice(0, CONFIG.maxHighlights)) {
			lines.push(`   > ${truncate(collapse(highlight), CONFIG.maxCharsPerHighlight)}`);
		}
	} else if (result.text?.trim()) {
		lines.push(`   ${truncate(collapse(result.text), CONFIG.maxCharsPerResult)}`);
	}

	return lines.join("\n");
}

/**
 * Flatten whitespace so a snippet stays on one line, and strip any leading blockquote
 * markers the source page already had — otherwise our own "> " prefix renders as "> >".
 */
function collapse(text: string): string {
	return text
		.replace(/\s+/g, " ")
		.replace(/^(?:>\s*)+/, "")
		.trim();
}

function truncate(text: string, limit: number): string {
	return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}

/**
 * URL with query string and fragment stripped, for dedupe purposes.
 * Falls back to the raw string when it isn't parseable.
 */
function canonicalUrl(url: string | undefined): string | undefined {
	if (!url) return undefined;
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

/** Drop later results that collapse to the same canonical URL as an earlier one. */
function dedupe(results: ExaResult[]): ExaResult[] {
	if (!CONFIG.dedupeByUrl) return results;
	const seen = new Set<string>();
	const kept: ExaResult[] = [];
	for (const result of results) {
		const key = canonicalUrl(result.url);
		if (key !== undefined) {
			if (seen.has(key)) continue;
			seen.add(key);
		}
		kept.push(result);
	}
	return kept;
}
