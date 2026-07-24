/**
 * The throttle timestamp — a tiny local file so checks stay spaced out across
 * separate pi launches, not just within one session. Read/write are defensive:
 * a missing or corrupt file simply means "never checked", never a crash.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_FILE } from "./config.ts";

export function statePath(agentDir: string): string {
	return join(agentDir, STATE_FILE);
}

/** Epoch millis of the last check, or 0 if there is no usable record. */
export function readLastCheck(agentDir: string): number {
	try {
		const raw = JSON.parse(readFileSync(statePath(agentDir), "utf8")) as { lastCheckMs?: unknown };
		return typeof raw?.lastCheckMs === "number" && Number.isFinite(raw.lastCheckMs) ? raw.lastCheckMs : 0;
	} catch {
		return 0;
	}
}

export function writeLastCheck(agentDir: string, ms: number): void {
	try {
		writeFileSync(statePath(agentDir), `${JSON.stringify({ lastCheckMs: ms })}\n`);
	} catch {
		/* best effort — a failed write just means we may check again sooner */
	}
}

/** Due when never checked, the interval is non-positive, or enough time passed. */
export function isDue(nowMs: number, lastCheckMs: number, intervalHours: number): boolean {
	if (lastCheckMs <= 0) return true;
	if (intervalHours <= 0) return true;
	return nowMs - lastCheckMs >= intervalHours * 3_600_000;
}
