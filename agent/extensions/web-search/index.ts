/**
 * Web search for pi, backed by Exa (https://exa.ai).
 *
 * Registers a single `web_search` tool the model can call. Results come back as compact
 * markdown — title, URL, date, and bounded snippets — rather than raw page dumps, so a
 * search costs a predictable slice of context instead of blowing the window.
 *
 *   config.ts  tunables and endpoint constants
 *   types.ts   Exa response shapes
 *   client.ts  request building, filter validation, HTTP
 *   format.ts  dedupe and markdown rendering (pure)
 *   index.ts   tool registration and orchestration
 *
 * Credentials: read from the EXA_API_KEY environment variable only, which
 * `extensions/env` populates from `~/.pi/agent/.env`. Deliberately never from
 * settings.json — this config directory is a public git repo, and a key committed there
 * is a key leaked. Get one at https://dashboard.exa.ai/api-keys.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { buildBody, search, validateFilters } from "./client.ts";
import { CATEGORIES, CONFIG } from "./config.ts";
import { dedupe, formatResults } from "./format.ts";

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
			// "company" and "people" disable excludeDomains and both date filters; Exa returns
			// 400 if they're combined, and validateFilters rejects it before the request.
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
					"EXA_API_KEY is not set. Add it to ~/.pi/agent/.env (see .env.example) or " +
						"export it in your shell, then /reload. Get a key at https://dashboard.exa.ai/api-keys.",
				);
			}

			const filterError = validateFilters(params);
			if (filterError) throw new Error(filterError);

			onUpdate?.({ content: [{ type: "text", text: `Searching: ${params.query}` }] });

			const wanted = Math.min(params.numResults ?? CONFIG.defaultNumResults, CONFIG.maxNumResults);
			// Over-fetch into the free tier so dedupe can't shrink the set below what was asked for.
			const numResults = CONFIG.dedupeByUrl ? Math.max(wanted, CONFIG.freeResultCeiling) : wanted;

			const payload = await search(apiKey, buildBody(params.query, numResults, params), signal);
			const raw = payload.results ?? [];
			const unique = dedupe(raw);
			const results = unique.slice(0, wanted);

			if (results.length === 0) {
				return {
					content: [{ type: "text", text: `No results for "${params.query}".` }],
					details: { query: params.query, results: [], requestId: payload.requestId },
				};
			}

			return {
				content: [
					{
						type: "text",
						text: formatResults(
							params.query,
							results,
							raw.length - unique.length,
							payload.costDollars?.total,
						),
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
