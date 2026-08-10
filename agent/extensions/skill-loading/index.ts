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
 *   config.ts   the modes, and what each one costs
 *   store.ts    the machine-local preferences file, and why it is not in settings
 *   parse.ts    finding and rewriting pi's `<available_skills>` block (pure)
 *   select.ts   name and glob patterns to a mode (pure)
 *   body.ts     reading preloaded bodies within a budget
 *
 * ## Configured by picker, not by hand
 *
 * `/skills` opens a list of every skill with what it is currently doing to your
 * context; pick one, pick a mode, and it is saved and in force for the next
 * request. Nothing to look up, nothing to spell correctly, and no settings file
 * to edit — which matters because the natural home for this, `agent/settings.json`,
 * is tracked in git and would publish one person's
 * preferences to everyone who clones this config. See store.ts.
 *
 * The picker's skill list comes from `ctx.getSystemPromptOptions().skills` — pi's
 * own loaded list, before any extension touched it. That is what lets the picker
 * show, and un-hide, a skill this extension is currently hiding: reading back
 * `ctx.getSystemPrompt()` would show it the already-filtered text and the hidden
 * ones would be unreachable, which is the bug that makes a toggle one-way.
 */

import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadBodies, renderBodies } from "./body.ts";
import { MODE_HELP, MODES, type Mode, type SkillLoadingSettings } from "./config.ts";
import { findSkillsSection, renderSection, stripDescription } from "./parse.ts";
import { decide, modeFor } from "./select.ts";
import { read, storePath, write } from "./store.ts";

export type Applied = {
	prompt: string;
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
	// `brief` keeps its entry and loses its description; the cut is made on the
	// entry's own text so everything else pi wrote survives it.
	const kept = decided
		.filter((d) => d.mode !== "command")
		.map((d) => (d.mode === "brief" ? { ...d.entry, raw: stripDescription(d.entry.raw) } : d.entry));
	const preloaded = decided.filter((d) => d.mode === "preload").map((d) => d.entry);
	const briefed = decided.filter((d) => d.mode === "brief").length;

	// Nothing hidden, shortened or preloaded is pi's own prompt. Returning it
	// unmodified rather than a rebuilt copy keeps the no-configuration case
	// byte-identical, so installing this extension and setting nothing cannot
	// change a single token.
	if (kept.length === section.entries.length && preloaded.length === 0 && briefed === 0) return undefined;

	const bodies =
		preloaded.length > 0
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

/** One row of the picker: a skill, its mode, and what it is costing right now. */
export type Row = { name: string; mode: Mode; chars: number };

/**
 * What the picker shows.
 *
 * `chars` is the skill's own contribution to the listing, measured from the
 * block pi built rather than estimated, so the number beside a skill is the
 * number that goes away when you hide it. Skills pi loaded but did not list —
 * `disable-model-invocation: true` ones, which pi already excludes — get 0 and
 * are still shown, because they are still reachable as `/skill:<name>` and
 * leaving them out of the list would make the picker disagree with `/help`.
 */
export function buildRows(
	skills: ReadonlyArray<{ name: string }>,
	prompt: string,
	settings: SkillLoadingSettings,
): Row[] {
	const section = findSkillsSection(prompt);
	const costs = new Map<string, number>();
	for (const entry of section?.entries ?? []) {
		// The two spaces and newline pi puts before each entry go with it.
		costs.set(entry.name, entry.raw.length + 3);
	}

	return skills.map((skill) => ({
		name: skill.name,
		mode: modeFor(skill.name, settings),
		chars: costs.get(skill.name) ?? 0,
	}));
}

const DONE = "Done";
const RESET = "Reset every skill to the default";

function rowLabel(row: Row): string {
	const cost = row.chars > 0 ? `${row.chars} chars` : "not listed";
	return `[${row.mode}]`.padEnd(10) + `${row.name}  —  ${cost}`;
}

export default function (pi: ExtensionAPI) {
	let settings = read();

	/** The skills the last rewrite saw, for the summary `/skills` prints. */
	let last: Applied | undefined;

	/**
	 * The last system prompt pi built, BEFORE this extension edited it.
	 *
	 * Kept because `ctx.getSystemPrompt()` returns the edited one, and the picker
	 * needs the other. Measuring a skill's cost against the edited prompt gives 0
	 * for every skill currently hidden — so the row that should read "hiding this
	 * saves 380 chars" would read "not listed", and the one number the picker
	 * exists to show would be missing from exactly the skills you are deciding
	 * about.
	 */
	let unedited: string | undefined;

	pi.on("session_start", () => {
		// Re-read rather than trust the in-memory copy: another pi window may have
		// changed the store since this one started, and the file is the truth.
		settings = read();
		last = undefined;
		unedited = undefined;
	});

	pi.on("before_agent_start", (event) => {
		unedited = event.systemPrompt;

		const applied = apply(event.systemPrompt, settings);
		if (!applied) return;

		last = applied;
		return { systemPrompt: applied.prompt };
	});

	pi.registerCommand("skills", {
		description: "Choose what each skill costs your context (/skills)",
		handler: async (_args, ctx) => {
			settings = read();

			if (!ctx.hasUI) {
				ctx.ui.notify(summary(ctx), "info");
				return;
			}

			await pick(ctx);
		},
	});

	/** The picker loop: a list, a mode, saved, back to the list. */
	const pick = async (ctx: ExtensionCommandContext): Promise<void> => {
		for (;;) {
			const skills = loadedSkills(ctx);
			if (skills.length === 0) {
				ctx.ui.notify("No skills are loaded, so there is nothing to tune.", "info");
				return;
			}

			// Before the first turn nothing has been edited yet, so pi's live prompt
			// is already the unedited one — the fallback is correct, not a guess.
			const rows = buildRows(skills, unedited ?? ctx.getSystemPrompt(), settings);
			const labels = rows.map(rowLabel);
			const footer = `Default for anything unlisted: ${settings.default}`;

			const picked = await ctx.ui.select(
				[
					"Skill loading — pick a skill to change what it costs",
					"",
					...MODES.map((mode) => `  ${mode.padEnd(9)} ${MODE_HELP[mode]}`),
					"",
					footer,
					`Saved in ${storePath()}`,
				].join("\n"),
				[...labels, RESET, DONE],
			);

			if (picked === undefined || picked === DONE) return;

			if (picked === RESET) {
				settings = { ...settings, skills: {} };
				write(settings);
				ctx.ui.notify(`Every skill is back to ${settings.default}. Takes effect on the next request.`, "info");
				continue;
			}

			const row = rows[labels.indexOf(picked)];
			if (!row) return;

			const chosen = await ctx.ui.select(
				`${row.name}\n\nCurrently ${row.mode}.`,
				MODES.map((mode) => `${mode.padEnd(9)} ${MODE_HELP[mode]}`),
			);
			if (chosen === undefined) continue;

			const mode = MODES[MODES.findIndex((m) => chosen.startsWith(m))];
			if (!mode) continue;

			// An exact entry, always — even when it matches what a glob already said.
			// Writing it down is what makes the next glob edit not silently move this
			// skill, and it is what the picker just promised the user it did.
			settings = { ...settings, skills: { ...settings.skills, [row.name]: mode } };
			write(settings);
			ctx.ui.notify(`${row.name} → ${mode}. Takes effect on the next request.`, "info");
		}
	};

	/** pi's own loaded skills, before any extension filtered them. */
	const loadedSkills = (ctx: ExtensionCommandContext): Array<{ name: string }> => {
		try {
			return ctx.getSystemPromptOptions().skills ?? [];
		} catch {
			return [];
		}
	};

	/** The read-only report, for print/JSON mode where there are no dialogs. */
	const summary = (ctx: ExtensionCommandContext): string => {
		if (!settings.enabled) return "Skill loading is off — pi lists every skill.";

		const rows = buildRows(loadedSkills(ctx), unedited ?? ctx.getSystemPrompt(), settings);
		if (rows.length === 0) return "No skills are loaded.";

		const lines: string[] = [];
		for (const mode of MODES) {
			const listed = rows.filter((row) => row.mode === mode);
			if (listed.length === 0) continue;
			lines.push(`${mode} (${listed.length}) — ${MODE_HELP[mode]}`);
			for (const row of listed) lines.push(`  ${row.name}`);
			lines.push("");
		}

		const delta = last?.delta ?? 0;
		lines.push(
			delta > 0
				? `Saving about ${delta.toLocaleString()} characters (~${Math.round(delta / 4).toLocaleString()} tokens) per request.`
				: delta < 0
					? `Costing about ${(-delta).toLocaleString()} more characters (~${Math.round(-delta / 4).toLocaleString()} tokens) per request, which is what preload buys.`
					: "No change to pi's own prompt yet.",
		);
		lines.push("Hidden skills are still available as /skill:<name>.");
		lines.push(`Preferences: ${storePath()}`);
		return lines.join("\n");
	};
}
