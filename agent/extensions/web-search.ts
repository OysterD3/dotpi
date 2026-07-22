/**
 * Web search for pi, backed by Exa (https://exa.ai).
 *
 * Registers a single `web_search` tool the model can call. Results come back as compact
 * markdown — title, URL, date, and a snippet per hit — rather than raw page dumps, so a
 * search costs a predictable slice of context instead of blowing the window.
 *
 * API (verified against https://exa.ai/docs/reference/search):
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
	 * Characters of page text kept per result. The whole point of the tool is to summarize
	 * the web into context, so this stays small; raise it if you want fuller extracts.
	 */
	maxCharsPerResult: 1200,
	/** Include Exa's extracted highlight sentences alongside the text snippet. */
	includeHighlights: true,
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

			onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

			const numResults = Math.min(
				params.numResults ?? CONFIG.defaultNumResults,
				CONFIG.maxNumResults,
			);

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
					text: { maxCharacters: CONFIG.maxCharsPerResult },
					...(CONFIG.includeHighlights ? { highlights: true } : {}),
				},
			};

			const payload = await postSearch(apiKey, body, signal);
			const results = payload.results ?? [];
			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${params.query}".` }],
					details: { query: params.query, results: [], requestId: payload.requestId },
				};
			}

			const rendered = results.map((result, index) => formatResult(result, index + 1)).join("\n\n");
			const cost =
				CONFIG.showCost && typeof payload.costDollars?.total === "number"
					? `\n\n_Exa cost: $${payload.costDollars.total.toFixed(4)}_`
					: "";

			return {
				content: [
					{
						type: "text",
						text: `${results.length} result(s) for "${params.query}":\n\n${rendered}${cost}`,
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
		for (const highlight of highlights.slice(0, 3)) {
			lines.push(`   > ${collapse(highlight)}`);
		}
	} else if (result.text?.trim()) {
		lines.push(`   ${collapse(result.text).slice(0, CONFIG.maxCharsPerResult)}`);
	}

	return lines.join("\n");
}

/** Flatten whitespace so a snippet stays on one line in the transcript. */
function collapse(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}
