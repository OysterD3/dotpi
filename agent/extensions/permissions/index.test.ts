/**
 * Tests for index.ts's pure, exported helpers.
 *
 *     pnpm dlx jiti agent/extensions/permissions/index.test.ts
 *
 * Everything else in index.ts either needs a live ExtensionAPI (the tool_call
 * handler, the /permissions command) or is already exercised through decide.ts
 * and auto.test.ts. What lands here is the wording the promptTimeoutMs
 * deadline hands back to the model on expiry — load-bearing in the sense the
 * top-level header cares about: get it wrong and a timed-out agent retries the
 * exact command that just stalled, instead of doing something that does not
 * need a human.
 */

import { formatDuration, timeoutReason } from "./index.ts";

let failures = 0;

function check(name: string, condition: boolean, detail?: string): void {
	if (condition) return;
	failures++;
	console.log(`  FAIL  ${name}${detail ? `\n          ${detail}` : ""}`);
}

function eq(name: string, actual: unknown, expected: unknown): void {
	check(name, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
console.log("formatDuration — the units shown in the timeout reason and /permissions");

eq("the shipped default reads as a bare '5m'", formatDuration(300_000), "5m");
eq("a sub-minute value still prints something", formatDuration(45_000), "45s");
eq("minutes and seconds both show when both are non-zero", formatDuration(90_000), "1m 30s");
eq("hours, minutes, and seconds can all show at once", formatDuration(3_661_000), "1h 1m 1s");
eq("an exact hour drops the zero minutes and seconds", formatDuration(3_600_000), "1h");
eq("zero floors to '0s' rather than an empty string", formatDuration(0), "0s");
eq("sub-second values floor down, not up", formatDuration(999), "0s");

// ---------------------------------------------------------------------------
console.log("timeoutReason — the block reason handed to the model on expiry");

const reason = timeoutReason(300_000);

check("names the actual configured duration, not a hardcoded one", reason.includes("5m"));
check("says nobody was there to answer", reason.toLowerCase().includes("nobody at the keyboard"));
// Each clause below heads off one way the benchmarked run kept re-failing the
// same way: retrying the identical call, a pkill wide enough to catch more
// than the one process, an rm -rf wide enough to take more than one file.
check("tells the model not to retry the same command", reason.includes("Do not retry this exact command"));
check("steers a kill toward an exact PID instead of pkill", reason.includes("pidfile") && reason.includes("pkill"));
check("steers a delete toward named files instead of rm -rf", reason.includes("rm -rf"));
check("offers a way forward that needs no human", reason.toLowerCase().includes("defer this step"));

eq("a different configured duration is reflected, not memorized", timeoutReason(45_000).includes("45s"), true);
check("the two reasons differ when the duration does", timeoutReason(45_000) !== reason);

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
if (failures > 0) process.exitCode = 1;
