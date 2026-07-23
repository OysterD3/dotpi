/**
 * The decision to auto-recap on return — kept pure so it can be tested exactly.
 *
 * This is the pi-native stand-in for Claude Code's `qIS` gate plus its "away"
 * threshold. Claude Code knows you were away because the terminal lost focus; pi
 * exposes no focus events, so "away" is inferred from wall-clock idle: the gap
 * between the agent last going idle and your next interactive message. Every
 * other condition mirrors Claude Code:
 *
 *   - a minimum of user turns before a recap is worth it (BIS)
 *   - a minimum of user turns since the last recap, so the same spot is not
 *     recapped twice (UIS)
 *   - never while background work is pending
 */

import { CONFIG, ENTRY_TYPE } from "./config.ts";

/** Broad entry shape: recaps are custom entries, messages carry a role. */
export type GateEntry = {
	type: string;
	customType?: string;
	message?: { role?: string };
};

export type GateInput = {
	entries: GateEntry[];
	/** Milliseconds since the agent last went idle, or undefined if it never has. */
	idleMs: number | undefined;
	autoOnReturn: boolean;
	idleThresholdMs: number;
	minUserTurns: number;
	/** Whether pi has queued messages waiting — background work in flight. */
	hasPending: boolean;
};

export type GateDecision = { recap: true } | { recap: false; reason: string };

function isUserMessage(entry: GateEntry): boolean {
	return entry.type === "message" && entry.message?.role === "user";
}

function isRecapEntry(entry: GateEntry): boolean {
	return entry.type === "custom" && entry.customType === ENTRY_TYPE;
}

/** User turns after the most recent recap entry (all of them if none). */
export function userTurnsSinceLastRecap(entries: GateEntry[]): number {
	let lastRecap = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (isRecapEntry(entries[i])) {
			lastRecap = i;
			break;
		}
	}
	let count = 0;
	for (let i = lastRecap + 1; i < entries.length; i++) {
		if (isUserMessage(entries[i])) count++;
	}
	return count;
}

export function totalUserTurns(entries: GateEntry[]): number {
	let count = 0;
	for (const entry of entries) if (isUserMessage(entry)) count++;
	return count;
}

/** Has any recap been shown in this branch? */
export function hasPriorRecap(entries: GateEntry[]): boolean {
	return entries.some(isRecapEntry);
}

export function shouldAutoRecap(input: GateInput): GateDecision {
	if (!input.autoOnReturn) return { recap: false, reason: "auto-recap disabled" };
	if (input.idleMs === undefined) return { recap: false, reason: "agent has not run yet" };
	if (input.idleMs < input.idleThresholdMs) return { recap: false, reason: "not away long enough" };
	if (input.hasPending) return { recap: false, reason: "background work pending" };

	// The message that triggered this has not been appended yet, so the turn that
	// prompted the gate is not counted — require the history before it to qualify.
	if (totalUserTurns(input.entries) < input.minUserTurns) {
		return { recap: false, reason: "too early in the session" };
	}

	if (hasPriorRecap(input.entries) && userTurnsSinceLastRecap(input.entries) < CONFIG.minTurnsSinceLastRecap) {
		return { recap: false, reason: "recapped recently" };
	}

	return { recap: true };
}
