/** Response shapes returned by Exa's /contents endpoint. */

export type ContentsResult = {
	id?: string;
	url?: string;
	title?: string;
	author?: string | null;
	publishedDate?: string;
	text?: string;
	summary?: string;
	highlights?: string[];
};

/**
 * Per-URL outcome. Crucially, a URL that fails to fetch is absent from `results`
 * entirely and reported only here — without reading this, a failed fetch silently looks
 * like an empty page.
 */
export type ContentsStatus = {
	id?: string;
	status?: "success" | "error" | string;
	source?: string;
	error?: { httpStatusCode?: number; tag?: string };
};

export type ContentsResponse = {
	requestId?: string;
	results?: ContentsResult[];
	statuses?: ContentsStatus[];
	costDollars?: { total?: number };
};

/** How much of each page to pull back. */
export type FetchMode = "text" | "summary";
