/**
 * Tests for the Qoder credit numbers.
 *
 * Run with:
 *   node --experimental-transform-types agent/extensions/statusline/credits.test.ts
 *
 * The balance must match what qodercli shows for the same account, so the first
 * case has the shape of a real /api/v2/quota/usage response (numbers invented). It
 * is the one that caught the org pack reporting `cap`, not `total`.
 */

import { parseQuota, sessionCredits } from "./credits.ts";

let failures = 0;

function check(label: string, got: unknown, want: unknown) {
	const ok = JSON.stringify(got) === JSON.stringify(want);
	if (!ok) failures++;
	console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
	if (!ok) {
		console.log(`      got=${JSON.stringify(got)}`);
		console.log(`     want=${JSON.stringify(want)}`);
	}
}

const real = {
	userId: "00000000-0000-0000-0000-000000000000",
	userType: "pro",
	usageType: "credits",
	totalUsagePercentage: 1,
	isQuotaExceeded: false,
	expiresAt: 1790000000000,
	upgradeUrl: "https://qoder.com/pricing?client=qoder",
	outerProviders: [],
	userQuota: { total: 1000, used: 1000, remaining: 0, percentage: 1, unit: "credits" },
	orgResourcePackage: { used: 1000, remaining: 3000, percentage: 0.25, unit: "credits", cap: 4000, available: true },
	isPlanQuotaProrated: false,
};

// --- balance: [label, response, want] ---
const balances: Array<[string, unknown, unknown]> = [
	[
		"real shape: plan spent, org pack left",
		real,
		{ available: 3000, usedPercent: 40, resetsAt: 1790000000 },
	],
	[
		"an add-on adds its remaining",
		{ ...real, addOnQuota: { total: 500, used: 100, remaining: 400 } },
		{ available: 3400, usedPercent: disp(2100 / 5500), resetsAt: 1790000000 },
	],
	[
		"an org pack that reports total instead of cap",
		{ userQuota: { total: 100, used: 40, remaining: 60 }, orgResourcePackage: { total: 200, used: 50, remaining: 150 } },
		{ available: 210, usedPercent: 30 },
	],
	[
		"missing remaining falls back to size - used",
		{ userQuota: { total: 100, used: 30 } },
		{ available: 70, usedPercent: 30 },
	],
	[
		"numbers sent as strings still count",
		{ userQuota: { total: "3000", used: "1500", remaining: "1500" } },
		{ available: 1500, usedPercent: 50 },
	],
	["no credit bucket at all", { userType: "pro" }, null],
	["not an object", "not json", null],
];

for (const [label, response, want] of balances) {
	const got = parseQuota(response);
	check(label, got && { ...got, usedPercent: disp(got.usedPercent / 100) }, want);
}

// --- session spend: [label, session entries, want] ---
const reply = (usage: Record<string, unknown>, provider = "qoder") => ({
	type: "message",
	message: { role: "assistant", provider, usage },
});
// What pi saved for a real Qoder turn (usage trimmed to the credit fields).
const realTurn = reply({ input: 18675, output: 31, credits: 0.16761607142857143, billable: false });
const sessions: Array<[string, Parameters<typeof sessionCredits>[0], number | undefined]> = [
	["billable replies add up", [reply({ credits: 14.1, billable: true }), reply({ credits: 4.8, billable: true })], 18.9],
	["a real non-billable turn counts as 0", [realTurn], 0],
	["no billable flag: not a credit report", [reply({ credits: 9 })], undefined],
	["other providers are ignored", [reply({ credits: 9, billable: true }, "openai-codex")], undefined],
	["qoder-cn counts too", [reply({ credits: 2.5, billable: true }, "qoder-cn")], 2.5],
	["a user message is not a reply", [{ type: "message", message: { role: "user" } }], undefined],
	[
		"compaction and branch summaries were billed too",
		[
			reply({ credits: 10, billable: true }),
			{ type: "compaction", usage: { credits: 3, billable: true } },
			{ type: "branch_summary", usage: { credits: 2, billable: true } },
		],
		15,
	],
	["a summary made by another provider has no credit report", [{ type: "compaction", usage: { input: 5 } }], undefined],
	["a Qoder usage entry counts", [{ type: "usage", provider: "qoder", usage: { credits: 1.5, billable: true } }], 1.5],
	[
		"a subagent's spend on its tool result counts",
		[reply({ credits: 4, billable: true }), { type: "message", message: { role: "toolResult", usage: { credits: 6.5, billable: true } } }],
		10.5,
	],
	["a tool result with no credit report", [{ type: "message", message: { role: "toolResult", usage: { input: 5 } } }], undefined],
	["no entries", [], undefined],
];

for (const [label, entries, want] of sessions) {
	const got = sessionCredits(entries);
	check(label, got === undefined ? got : Number(got.toFixed(4)), want);
}

/** Percent to two decimals, the way the cases above state it. */
function disp(fraction: number): number {
	return Number((fraction * 100).toFixed(2));
}

console.log(failures === 0 ? "\nall passed" : `\n${failures} failed`);
if (failures > 0) process.exit(1);
