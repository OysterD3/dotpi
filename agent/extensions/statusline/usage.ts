/**
 * OpenAI Codex (ChatGPT subscription) usage-limit reader.
 *
 * Pi exposes no subscription rate-limit data of its own — `FooterDataProvider` only
 * carries git branch, extension statuses and provider count. The limits live behind
 * ChatGPT's own endpoint, so we resolve pi's stored credential and ask for them.
 *
 * Approach follows narumiruna/pi-extensions `pi-usage` (MIT), reimplemented lean:
 *   ctx.modelRegistry.getProviderAuth("openai-codex")  ->  Authorization header
 *   GET https://chatgpt.com/backend-api/wham/usage     ->  rate_limit.{primary,secondary}_window
 *
 * `primary_window` is the rolling ~5h window (Claude Code calls this "Session"),
 * `secondary_window` the weekly one. Each carries used_percent / reset_at /
 * limit_window_seconds.
 *
 * The footer renders synchronously, so this caches and refreshes in the background,
 * calling `onUpdate` when fresh numbers land. Every failure degrades to `null` — a
 * flaky network must never break the statusline.
 */

const PROVIDER_ID = "openai-codex";
const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const OFFICIAL_ORIGIN = "https://chatgpt.com";

export const USAGE_CONFIG = {
	/** How long a successful reading stays fresh. */
	refreshMs: 5 * 60 * 1000,
	/** Back-off after a failure, so a broken token isn't retried every render. */
	retryMs: 60 * 1000,
	/** Abort the request after this long. */
	timeoutMs: 10_000,
	/** Cap the response body we're willing to buffer. */
	maxBodyBytes: 64 * 1024,
};

export type LimitWindow = {
	/** 0-100. */
	usedPercent: number;
	/** Epoch *seconds* when this window rolls over, if the API reported it. */
	resetsAt?: number;
	/** Window length in minutes, if reported. */
	windowMinutes?: number;
};

export type CodexUsage = {
	/** Rolling ~5h window. */
	session?: LimitWindow;
	/** Weekly window. */
	weekly?: LimitWindow;
	planType?: string;
};

export type UsageReader = {
	/** Latest reading, or null if unavailable. Triggers a background refresh when stale. */
	get(): CodexUsage | null;
	dispose(): void;
};

/** Minimal shape of what we use off ctx — pi's own types don't export these narrowly. */
type AuthLike = {
	apiKey?: string;
	headers?: Record<string, string | null>;
	baseUrl?: string;
};
type RegistryLike = {
	getProviderAuth?(provider: string): Promise<{ auth: AuthLike } | undefined>;
	getProviderAuthStatus?(provider: string): { configured: boolean };
};
type CtxLike = { modelRegistry?: RegistryLike };

export function createUsageReader(ctx: CtxLike, onUpdate: () => void): UsageReader {
	let cached: CodexUsage | null = null;
	let nextAllowedFetch = 0;
	let inflight = false;
	let disposed = false;
	let controller: AbortController | null = null;

	function refresh(): void {
		if (disposed || inflight || Date.now() < nextAllowedFetch) return;
		inflight = true;
		controller = new AbortController();
		const timer = setTimeout(() => controller?.abort(), USAGE_CONFIG.timeoutMs);

		fetchUsage(ctx, controller.signal)
			.then((usage) => {
				if (disposed) return;
				cached = usage;
				nextAllowedFetch = Date.now() + USAGE_CONFIG.refreshMs;
				onUpdate();
			})
			.catch(() => {
				if (disposed) return;
				// Keep the last good reading rather than blanking the footer on a blip.
				nextAllowedFetch = Date.now() + USAGE_CONFIG.retryMs;
			})
			.finally(() => {
				clearTimeout(timer);
				controller = null;
				inflight = false;
			});
	}

	return {
		get() {
			refresh();
			return cached;
		},
		dispose() {
			disposed = true;
			controller?.abort();
		},
	};
}

async function fetchUsage(ctx: CtxLike, signal: AbortSignal): Promise<CodexUsage | null> {
	const authorization = await resolveAuthorization(ctx);
	if (!authorization) return null;

	const response = await fetch(USAGE_URL, {
		headers: { Authorization: authorization, "User-Agent": "pi-statusline" },
		signal,
	});
	if (!response.ok) {
		// Deliberately does not include the body — it can echo the credential back.
		throw new Error(`usage endpoint returned ${response.status}`);
	}

	const text = await readBounded(response, USAGE_CONFIG.maxBodyBytes);
	const payload: unknown = JSON.parse(text);
	if (!isObject(payload)) throw new Error("usage response was not an object");

	const rateLimit = isObject(payload.rate_limit) ? payload.rate_limit : undefined;
	const usage: CodexUsage = {
		session: parseWindow(rateLimit?.primary_window),
		weekly: parseWindow(rateLimit?.secondary_window),
		planType: typeof payload.plan_type === "string" ? payload.plan_type : undefined,
	};
	return usage.session || usage.weekly ? usage : null;
}

/**
 * Resolve the credential pi already holds for the Codex provider.
 *
 * Refuses to proceed when the provider is pointed at a non-official base URL: sending
 * a ChatGPT bearer token to someone's proxy because they reconfigured the provider
 * would leak it. pi-usage guards the same way.
 */
async function resolveAuthorization(ctx: CtxLike): Promise<string | undefined> {
	const registry = ctx.modelRegistry;
	if (typeof registry?.getProviderAuth !== "function") return undefined;

	try {
		if (registry.getProviderAuthStatus?.(PROVIDER_ID)?.configured === false) return undefined;
	} catch {
		// Status is advisory; fall through and let the auth lookup decide.
	}

	const result = await registry.getProviderAuth(PROVIDER_ID);
	const auth = result?.auth;
	if (!auth) return undefined;
	if (auth.baseUrl && !isOfficialOrigin(auth.baseUrl)) return undefined;

	const header = headerValue(auth.headers, "Authorization");
	if (header) return header;
	return auth.apiKey ? `Bearer ${auth.apiKey}` : undefined;
}

function parseWindow(raw: unknown): LimitWindow | undefined {
	if (!isObject(raw)) return undefined;
	const used = asNumber(raw.used_percent);
	if (used === undefined) return undefined;
	const seconds = asNumber(raw.limit_window_seconds);
	const resetsAt = asNumber(raw.reset_at);
	return {
		usedPercent: Math.min(100, Math.max(0, used)),
		...(resetsAt !== undefined ? { resetsAt } : {}),
		...(seconds !== undefined && seconds > 0 ? { windowMinutes: Math.ceil(seconds / 60) } : {}),
	};
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total + value.byteLength > maxBytes) {
				await reader.cancel();
				throw new Error("usage response too large");
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	const body = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		body.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(body);
}

function isOfficialOrigin(value: string): boolean {
	try {
		return new URL(value).origin === OFFICIAL_ORIGIN;
	} catch {
		return false;
	}
}

function headerValue(
	headers: Record<string, string | null> | undefined,
	name: string,
): string | undefined {
	const entry = Object.entries(headers ?? {}).find(
		([key]) => key.toLowerCase() === name.toLowerCase(),
	);
	return entry?.[1] ?? undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}
	return undefined;
}
