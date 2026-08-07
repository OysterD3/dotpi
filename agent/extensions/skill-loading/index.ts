/**
 * skill-loading — decide, per skill, what it costs you every turn.
 *
 * pi lists every skill it finds in the system prompt: name, description and
 * path, for all of them, on every request. That is already the cheap end of the
 * design — it never inlines a skill's body, and the model reads the file when a
 * task matches — but "cheap per skill" and "cheap" are different claims once a
 * few packages have each contributed half a dozen. The listing is fixed cost you
 * pay whether or not this session was ever going to use `pptx`.
 *
 * So each skill gets a mode (config.ts):
 *
 *   name     pi's behaviour, unchanged. The default.
 *   command  not in the prompt at all. `/skill:<name>` still works.
 *   preload  in the prompt with its whole body, ready to act on.
 *
 * `command` is the one worth understanding, because "hidden" sounds like
 * "disabled" and is not. pi builds its `/skill:<name>` commands from the loaded
 * skill list rather than from what reached the prompt
 * (modes/interactive/interactive-mode.js), so hiding a skill costs the model the
 * ability to *notice* it and costs you nothing else. For a skill you invoke
 * deliberately — a deck generator, a scaffolder — that is the whole transaction:
 * you already know when you want it.
 *
 *   config.ts   the modes, the settings, and what each mode costs
 *   parse.ts    finding and rewriting pi's `<available_skills>` block (pure)
 *   select.ts   name and glob patterns to a mode (pure)
 *   body.ts     reading preloaded bodies within a budget
 *
 * `/skills` shows what each skill is doing to your context, and what the current
 * configuration is saving.
 *
 * Settings (agent settings.json):
 *   skillLoading.enabled           boolean, default true
 *   skillLoading.default           mode for anything unmatched, default "name"
 *   skillLoading.skills            { "<name or glob>": "<mode>" }
 *   skillLoading.maxCharsPerSkill  number, default 12000
 *   skillLoading.maxChars          number, default 24000
 *
 *   { "skillLoading": {
 *       "skills": {
 *         "chrome-devtools-mcp:*": "command",
 *         "pptx": "command",
 *         "dataviz": "preload"
 *       }
 *   } }
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadBodies, renderBodies } from "./body.ts";
import {
	defaultSettings,
	isMode,
	MODE_HELP,
	MODES,
	type Mode,
	SETTINGS_KEY,
	type SkillLoadingSettings,
} from "./config.ts";
import { findSkillsSection, renderSection, type SkillEntry } from "./parse.ts";
import { decide } from "./select.ts";

export function loadSettings(agentDir: string): SkillLoadingSettings {
	const base = defaultSettings();
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;

		const skills: Record<string, Mode> = {};
		const configured = block?.skills;
		if (configured && typeof configured === "object" && !Array.isArray(configured)) {
			for (const [pattern, mode] of Object.entries(configured as Record<string, unknown>)) {
				// An unknown mode is dropped rather than defaulted. Defaulting would
				// silently apply `name` to a skill someone typed "hidden" for and
				// believed they had turned off.
				if (isMode(mode) && pattern.trim().length > 0) skills[pattern.trim()] = mode;
			}
		}

		const positive = (value: unknown, fallback: number) =>
			typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;

		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : base.enabled,
			default: isMode(block?.default) ? block.default : base.default,
			skills,
			maxCharsPerSkill: positive(block?.maxCharsPerSkill, base.maxCharsPerSkill),
			maxChars: positive(block?.maxChars, base.maxChars),
		};
	} catch {
		return base;
	}
}

export type Applied = {
	prompt: string;
	/** Every skill pi listed, with the mode it resolved to. */
	decided: Array<{ name: string; mode: Mode; location: string }>;
	/** Characters removed from the listing, minus anything preloading added. */
	delta: number;
};

/**
 * Rewrite one system prompt. Returns undefined when there is nothing to change,
 * which is also what an unrecognised prompt gets — see parse.ts on failing open.
 */
export function apply(prompt: string, settings: SkillLoadingSettings): Applied | undefined {
	if (!settings.enabled) return undefined;

	const section = findSkillsSection(prompt);
	if (!section) return undefined;

	const decided = decide(section.entries, settings);
	const kept = decided.filter((d) => d.mode !== "command").map((d) => d.entry);
	const preloaded = decided.filter((d) => d.mode === "preload").map((d) => d.entry);

	// Nothing hidden and nothing preloaded is pi's own prompt. Returning it
	// unmodified rather than a rebuilt copy keeps the no-configuration case
	// byte-identical, so installing this extension and setting nothing cannot
	// change a single token.
	if (kept.length === section.entries.length && preloaded.length === 0) return undefined;

	const bodies = preloaded.length > 0
		? loadBodies(preloaded, { maxCharsPerSkill: settings.maxCharsPerSkill, maxChars: settings.maxChars })
		: [];

	const replacement = renderSection(prompt, section, kept) + renderBodies(bodies);
	const original = prompt.slice(section.start, section.end);

	return {
		prompt: prompt.slice(0, section.start) + replacement + prompt.slice(section.end),
		decided: decided.map((d) => ({ name: d.entry.name, mode: d.mode, location: d.entry.location })),
		delta: original.length - replacement.length,
	};
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);

	/**
	 * What the last rewrite saw.
	 *
	 * `/skills` reports from this rather than discovering skills itself, which is
	 * the same choice parse.ts makes and for the same reason: the only list worth
	 * showing is the one that actually reached the model. Undefined before the
	 * first turn, and the command says so instead of inventing one.
	 */
	let last: Applied | undefined;
	let sawSection = false;

	pi.on("session_start", () => {
		settings = loadSettings(agentDir);
		last = undefined;
		sawSection = false;
	});

	pi.on("before_agent_start", (event) => {
		sawSection = findSkillsSection(event.systemPrompt) !== undefined;

		const applied = apply(event.systemPrompt, settings);
		if (!applied) return;

		last = applied;
		return { systemPrompt: applied.prompt };
	});

	pi.registerCommand("skills", {
		description: "Show what each skill costs your context (/skills [modes])",
		getArgumentCompletions: (prefix: string) =>
			["modes"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			if (args.trim() === "modes") {
				ctx.ui.notify(
					[
						"Skill load modes — set them under skillLoading.skills in settings.json:",
						"",
						...MODES.map((mode) => `  ${mode.padEnd(9)} ${MODE_HELP[mode]}`),
						"",
						'Keys are skill names or globs, most specific wins: { "chrome-devtools-mcp:*": "command" }',
					].join("\n"),
					"info",
				);
				return;
			}

			ctx.ui.notify(status(), "info");
		},
	});

	const status = (): string => {
		if (!settings.enabled) return "Skill loading is off (skillLoading.enabled is false) — pi lists every skill.";

		if (!last) {
			if (!sawSection) {
				return [
					"No skills block has reached the model yet.",
					"",
					"Either no skills are loaded, or no turn has started in this session.",
					"Run a turn and try again; /skills modes lists the modes.",
				].join("\n");
			}
			return [
				"Every skill is in `name` mode — pi's own behaviour, nothing rewritten.",
				"",
				'Set skillLoading.skills in settings.json to change that, e.g. { "pptx": "command" }.',
				"/skills modes explains each mode.",
			].join("\n");
		}

		const byMode = (mode: Mode) => last!.decided.filter((entry) => entry.mode === mode);
		const lines: string[] = [];

		for (const mode of MODES) {
			const listed = byMode(mode);
			if (listed.length === 0) continue;
			lines.push(`${mode} (${listed.length}) — ${MODE_HELP[mode]}`);
			for (const entry of listed) lines.push(`  ${entry.name}`);
			lines.push("");
		}

		const delta = last.delta;
		const verdict =
			delta > 0
				? `Saving about ${delta.toLocaleString()} characters (~${Math.round(delta / 4).toLocaleString()} tokens) per request.`
				: delta < 0
					? `Costing about ${(-delta).toLocaleString()} more characters (~${Math.round(-delta / 4).toLocaleString()} tokens) per request, which is what preload buys.`
					: "No net change to the prompt.";

		return [...lines, verdict, "Hidden skills are still available as /skill:<name>."].join("\n");
	};
}
