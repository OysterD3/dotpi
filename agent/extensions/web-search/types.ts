/** Response shapes returned by Exa's /search endpoint. */

export type ExaResult = {
	title?: string;
	url?: string;
	publishedDate?: string;
	author?: string | null;
	text?: string;
	highlights?: string[];
};

export type ExaResponse = {
	requestId?: string;
	results?: ExaResult[];
	costDollars?: { total?: number };
};

/** The filters a search request may carry, independent of how the tool schema expresses them. */
export type SearchFilters = {
	category?: string;
	includeDomains?: string[];
	excludeDomains?: string[];
	startPublishedDate?: string;
	endPublishedDate?: string;
};
