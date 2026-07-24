/**
 * Duration formatting, transcribed from Claude Code 2.1.217's `formatDuration`
 * (the same function it uses for both the spinner's elapsed time and the
 * end-of-turn line), so a pi turn reads the way a Claude Code turn does.
 *
 * The shape worth knowing: a hard cut at one minute. Below it, seconds are
 * FLOORED ("45s"), so a ticking counter never shows a second that has not
 * fully passed. At or above it, seconds are ROUNDED with carry, so 60,500ms is
 * "1m 1s". Days never show seconds.
 */

export interface DurationOptions {
	/** Only the largest unit: "1d", "2h", "9m". */
	mostSignificantOnly?: boolean;
	/** Drop trailing zero units: 3600000 becomes "1h" rather than "1h 0m 0s". */
	hideTrailingZeros?: boolean;
}

export function formatDuration(ms: number, options?: DurationOptions): string {
	if (ms < 60_000) {
		if (ms === 0) return "0s";
		if (ms < 1) return `${(ms / 1000).toFixed(1)}s`;
		return `${Math.floor(ms / 1000)}s`;
	}

	let days = Math.floor(ms / 86_400_000);
	let hours = Math.floor((ms % 86_400_000) / 3_600_000);
	let minutes = Math.floor((ms % 3_600_000) / 60_000);
	let seconds = Math.round((ms % 60_000) / 1000);
	// Rounding can carry: 119,600ms rounds to 60s, which is 2m 0s.
	if (seconds === 60) {
		seconds = 0;
		minutes++;
	}
	if (minutes === 60) {
		minutes = 0;
		hours++;
	}
	if (hours === 24) {
		hours = 0;
		days++;
	}

	if (options?.mostSignificantOnly) {
		if (days > 0) return `${days}d`;
		if (hours > 0) return `${hours}h`;
		if (minutes > 0) return `${minutes}m`;
		return `${seconds}s`;
	}

	const hideZeros = options?.hideTrailingZeros;
	if (days > 0) {
		if (hideZeros && hours === 0 && minutes === 0) return `${days}d`;
		if (hideZeros && minutes === 0) return `${days}d ${hours}h`;
		return `${days}d ${hours}h ${minutes}m`;
	}
	if (hours > 0) {
		if (hideZeros && minutes === 0 && seconds === 0) return `${hours}h`;
		if (hideZeros && seconds === 0) return `${hours}h ${minutes}m`;
		return `${hours}h ${minutes}m ${seconds}s`;
	}
	if (minutes > 0) {
		if (hideZeros && seconds === 0) return `${minutes}m`;
		return `${minutes}m ${seconds}s`;
	}
	return `${seconds}s`;
}
