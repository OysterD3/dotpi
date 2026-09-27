/**
 * Qoder credit reader: the account balance, and what this session spent.
 *
 * Qoder bills in credits, not rate-limit windows, so this is a sibling of usage.ts
 * rather than more windows in it. Both numbers follow qodercli (1.1.64) exactly, so
 * the footer agrees with what `qodercli` shows for the same account:
 *
 *   balance : GET <openapi>/api/v2/quota/usage (bearer = pi's stored Qoder token).
 *             Available = userQuota + addOnQuota + orgResourcePackage `remaining`.
 *             The org pack reports its size as `cap`, not `total`.
 *   session : the provider copies each response's `usage.credits` / `billable` onto
 *             its usage, which pi saves on the assistant message (or on the
 *             compaction / branch summary it produced). A `task` subagent adds
 *             its requests up onto its tool result's usage. A request counts once
 *             `billable` is a boolean; a non-billable one counts as 0.
 *
 * The footer renders synchronously, so the balance is cached and refreshed in the
 * background, calling `onUpdate` when fresh numbers land. Every failure degrades to
 * `null`: a flaky network must never break the statusline.
 */

/** pi provider id -> Qoder OpenAPI origin. The token is only ever sent to these. */
const OPENAPI_ORIGINS: Record<string, string> = {
	qoder: "https://openapi.qoder.sh",
	"qoder-cn": "https://openapi.qoder.com.cn",
};
const QUOTA_PATH = "/api/v2/quota/usage";

export const CREDITS_CONFIG = {
	/** How long a successful reading stays fresh when nothing is spending credits. */
	refreshMs: 5 * 60 * 1000,
	/** Minimum gap between two fetches. qodercli caches the same endpoint for 15 s. */
	minGapMs: 15_000,
	/** Back-off after a failure, so a broken token isn't retried every render. */
	retryMs: 60 * 1000,
	/** Abort the request after this long. */
	timeoutMs: 10_000,
	/** Cap the response body we're willing to buffer. */
	maxBodyBytes: 64 * 1024,
};

export type QoderBalance = {
	/** Credits left across the plan, add-on and org pack. */
	available: number;
	/** 0-100, used over size, summed across the same buckets. */
	usedPercent: number;
	/** Epoch *seconds* when the quota period ends, if the API reported it. */
	resetsAt?: number;
};

export type CreditsReader = {
	/** Latest balance for `provider`, or null. Triggers a background refresh when stale. */
	get(provider: string | undefined): QoderBalance | null;
	/** Credits were just spent: refetch as soon as the minimum gap allows. */
	markStale(): void;
	dispose(): void;
};

type RegistryLike = { getApiKeyForProvider?(provider: string): Promise<string | undefined> };
type CtxLike = { modelRegistry?: RegistryLike };

export function isQoderProvider(provider: string | undefined): boolean {
	return provider !== undefined && Object.hasOwn(OPENAPI_ORIGINS, provider);
}

export function createCreditsReader(ctx: CtxLike, onUpdate: () => void): CreditsReader {
	let cached: QoderBalance | null = null;
	let cachedFor: string | undefined;
	let lastProvider: string | undefined;
	let lastFetchAt = 0;
	let staleAt = 0;
	let nextAllowedFetch = 0;
	let inflight = false;
	let disposed = false;
	let controller: AbortController | null = null;
	let wakeTimer: ReturnType<typeof setTimeout> | null = null;

	// A render is what fetches, and nothing may render while pi sits idle, so
	// ask for one when a refetch becomes allowed.
	function wakeAt(time: number): void {
		if (wakeTimer) clearTimeout(wakeTimer);
		wakeTimer = setTimeout(onUpdate, Math.max(0, time - Date.now()));
	}

	function refresh(provider: string): void {
		if (disposed || inflight || Date.now() < nextAllowedFetch) return;
		inflight = true;
		const startedAt = Date.now();
		lastFetchAt = startedAt;
		controller = new AbortController();
		const timer = setTimeout(() => controller?.abort(), CREDITS_CONFIG.timeoutMs);

		fetchBalance(ctx, provider, controller.signal)
			.then((balance) => {
				if (disposed || provider !== lastProvider) return;
				cached = balance;
				cachedFor = provider;
				if (staleAt >= startedAt) {
					// Credits spent while this was in flight are not in it yet.
					nextAllowedFetch = startedAt + CREDITS_CONFIG.minGapMs;
					wakeAt(nextAllowedFetch);
				} else {
					nextAllowedFetch = Date.now() + CREDITS_CONFIG.refreshMs;
				}
				onUpdate();
			})
			.catch(() => {
				if (disposed || provider !== lastProvider) return;
				// Keep the last good reading rather than blanking the footer on a blip.
				nextAllowedFetch = Date.now() + CREDITS_CONFIG.retryMs;
				wakeAt(nextAllowedFetch);
			})
			.finally(() => {
				clearTimeout(timer);
				controller = null;
				inflight = false;
				// The region changed mid-flight: fetch the new one now.
				if (!disposed && provider !== lastProvider) onUpdate();
			});
	}

	return {
		get(provider) {
			if (!isQoderProvider(provider)) return null;
			if (provider !== lastProvider) {
				// Switched region: the old balance belongs to another account.
				lastProvider = provider;
				nextAllowedFetch = 0;
			}
			refresh(provider as string);
			return cachedFor === provider ? cached : null;
		},
		markStale() {
			if (disposed) return;
			staleAt = Date.now();
			nextAllowedFetch = Math.min(nextAllowedFetch, lastFetchAt + CREDITS_CONFIG.minGapMs);
			wakeAt(nextAllowedFetch);
		},
		dispose() {
			disposed = true;
			if (wakeTimer) clearTimeout(wakeTimer);
			controller?.abort();
		},
	};
}

async function fetchBalance(ctx: CtxLike, provider: string, signal: AbortSignal): Promise<QoderBalance | null> {
	const registry = ctx.modelRegistry;
	if (typeof registry?.getApiKeyForProvider !== "function") return null;
	// pi returns undefined when a token refresh fails, too: treat it as a blip.
	const token = await registry.getApiKeyForProvider(provider);
	if (!token) throw new Error("no Qoder token");

	const response = await fetch(`${OPENAPI_ORIGINS[provider]}${QUOTA_PATH}`, {
		headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "pi-statusline" },
		signal,
	});
	if (!response.ok) {
		// Deliberately does not include the body — it can echo the credential back.
		throw new Error(`quota endpoint returned ${response.status}`);
	}
	return parseQuota(JSON.parse(await readBounded(response, CREDITS_CONFIG.maxBodyBytes)));
}

/** The quota response -> balance, or null when it carries no credit bucket. */
export function parseQuota(payload: unknown): QoderBalance | null {
	if (!isObject(payload)) return null;
	const buckets = [payload.userQuota, payload.addOnQuota, payload.orgResourcePackage]
		.map(parseBucket)
		.filter((bucket) => bucket !== undefined);
	if (buckets.length === 0) return null;

	const used = buckets.reduce((sum, bucket) => sum + bucket.used, 0);
	const size = buckets.reduce((sum, bucket) => sum + bucket.size, 0);
	const expiresAt = asNumber(payload.expiresAt);
	return {
		available: buckets.reduce((sum, bucket) => sum + bucket.remaining, 0),
		usedPercent: size > 0 ? Math.min(100, Math.max(0, (used / size) * 100)) : 100,
		...(expiresAt !== undefined && expiresAt > 0 ? { resetsAt: Math.floor(expiresAt / 1000) } : {}),
	};
}

function parseBucket(raw: unknown): { used: number; size: number; remaining: number } | undefined {
	if (!isObject(raw)) return undefined;
	const used = asNumber(raw.used) ?? 0;
	const size = asNumber(raw.cap) ?? asNumber(raw.total) ?? 0;
	return { used, size, remaining: asNumber(raw.remaining) ?? Math.max(size - used, 0) };
}

type EntryLike = {
	type: string;
	provider?: string;
	usage?: unknown;
	message?: { role?: string; provider?: string; usage?: unknown };
};

/** Credits this session spent, or undefined when no Qoder response reported any. */
export function sessionCredits(entries: Iterable<EntryLike>): number | undefined {
	let total: number | undefined;
	for (const entry of entries) {
		const usage = billedUsage(entry);
		if (!isObject(usage) || typeof usage.billable !== "boolean") continue;
		total = (total ?? 0) + (usage.billable ? (asNumber(usage.credits) ?? 0) : 0);
	}
	return total;
}

/** The usage a session entry recorded, walked the way pi's own session stats walk it. */
function billedUsage(entry: EntryLike): unknown {
	switch (entry.type) {
		case "message":
			// A tool result records no provider either: it is a subagent's spend,
			// and only a Qoder child sets `billable` on it.
			if (entry.message?.role === "toolResult") return entry.message.usage;
			return entry.message?.role === "assistant" && isQoderProvider(entry.message.provider)
				? entry.message.usage
				: undefined;
		case "usage":
			return isQoderProvider(entry.provider) ? entry.usage : undefined;
		case "compaction":
		case "branch_summary":
			// Summaries record no provider; only the Qoder stream sets `billable`.
			// A split-turn compaction merges two usages, and pi's merge keeps no credits.
			return entry.usage;
		default:
			return undefined;
	}
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
				throw new Error("quota response too large");
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
