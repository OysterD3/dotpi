/**
 * self-update — keep this pi config current by pulling the repo in the
 * background at session start.
 *
 * Because ~/.pi is the git repo, "update" is a `git pull` in its root. This runs
 * one, throttled to `intervalHours` across launches (state.ts), only in
 * interactive sessions (never in headless subagents — those load no extensions
 * anyway), and only when pi exposes `exec`. The pull is fire-and-forget so it
 * never delays startup, uses rebase + autostash so a config machine's own
 * runtime writes don't block it (update.ts), and notifies only when HEAD moved.
 * New code applies on the next launch or `/reload`.
 *
 * Settings (agent settings.json — per-machine, not synced):
 *   selfUpdate.enabled        boolean, default true
 *   selfUpdate.intervalHours  number, default 6 (0 = every start)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG, DEFAULT_SETTINGS, type SelfUpdateSettings, SETTINGS_KEY } from "./config.ts";
import { isDue, readLastCheck, writeLastCheck } from "./state.ts";
import { type Exec, runUpdate } from "./update.ts";

export function loadSettings(agentDir: string): SelfUpdateSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		const intervalHours =
			typeof block?.intervalHours === "number" && Number.isFinite(block.intervalHours) && block.intervalHours >= 0
				? block.intervalHours
				: DEFAULT_SETTINGS.intervalHours;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
			intervalHours,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();

	pi.on("session_start", (_event, ctx) => {
		const settings = loadSettings(agentDir);
		if (!ctx.hasUI || !settings.enabled) return;
		const exec = (pi as { exec?: Exec }).exec;
		if (typeof exec !== "function") return;

		const now = Date.now();
		if (!isDue(now, readLastCheck(agentDir), settings.intervalHours)) return;
		// Stamp before running so a hang or failure still throttles the next start.
		writeLastCheck(agentDir, now);

		const notify = (message: string, level: "info" | "warning" | "error") => {
			try {
				if (ctx.hasUI) ctx.ui.notify(message, level);
			} catch {
				/* context may have been replaced by the time the pull returns */
			}
		};

		// Fire-and-forget: never block session start on the network.
		void runUpdate(exec, agentDir, notify, CONFIG.gitTimeoutMs).catch(() => {});
	});
}
