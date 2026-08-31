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
 *   store.ts    the `skillOverrides` block in settings.json, and how it is written
 *   parse.ts    finding and rewriting pi's `<available_skills>` block (pure)
 *   select.ts   name and glob patterns to a mode (pure)
 *   body.ts     reading preloaded bodies within a budget
 *
 * ## Configured by picker, or by hand
 *
 * `/skills` opens a list of every skill with what it is currently doing to your
 * context. Space cycles the one under the cursor through the five states in
 * place, Esc saves the lot — Claude Code's interaction, for the same reason the
 * settings key is its key. Nothing to look up and nothing to spell correctly.
 *
 * What it saves into is the `skillOverrides` block in `agent/settings.json`, so
 * the same choices can be written by hand, read by opening the one file that
 * describes this agent, and reproduced on a new machine from a clone. That is a
 * reversal — these modes used to be kept in a machine-local file specifically so
 * a toggle would not be a diff in a tracked file — and store.ts records the
 * argument on both sides. One Esc is one write, and it has to merge rather than
 * replace, because the file it lands in holds everything else too; store.ts
 * again. The `*` row at the bottom of the list is how the default is set, since
 * a flat map of skill names has nowhere else to put one.
 *
 * The picker's skill list comes from `ctx.getSystemPromptOptions().skills` — pi's
 * own loaded list, before any extension touched it. That is what lets the picker
 * show, and un-hide, a skill this extension is currently hiding: reading back
 * `ctx.getSystemPrompt()` would show it the already-filtered text and the hidden
 * ones would be unreachable, which is the bug that makes a toggle one-way.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadBodies, renderBodies } from "./body.ts";
import { CONFIG, DEFAULT_MODE, MODE_HELP, MODES, SETTINGS_KEY, type Mode, type SkillLoadingSettings } from "./config.ts";
import { findSkillsSection, renderSection, stripDescription } from "./parse.ts";
import { DEFAULT_ROW, PICKER_ROWS_FALLBACK, pickerRows, SkillsPicker, type PickerResult } from "./picker.ts";
import { decide, modeFor } from "./select.ts";
import { read, settingsPath, write } from "./store.ts";

/** States that keep a skill out of the model's prompt entirely. */
const HIDDEN = new Set<Mode>(["user-invocable-only", "off"]);

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
	const section = findSkillsSection(prompt);
	if (!section) return undefined;

	const decided = decide(section.entries, settings);
	// `user-invocable-only` and `off` differ only in whether YOU can still see
	// the skill in the `/` menu; to the model they are the same absence, so the
	// prompt rewrite treats them together and the menu half lives on its own in
	// the autocomplete filter below.
	const kept = decided
		.filter((d) => !HIDDEN.has(d.mode))
		// `name-only` keeps its entry and loses its description; the cut is made on
		// the entry's own text so everything else pi wrote survives it.
		.map((d) => (d.mode === "name-only" ? { ...d.entry, raw: stripDescription(d.entry.raw) } : d.entry));
	const preloaded = decided.filter((d) => d.mode === "preload").map((d) => d.entry);
	const briefed = decided.filter((d) => d.mode === "name-only").length;

	// Nothing hidden, shortened or preloaded is pi's own prompt. Returning it
	// unmodified rather than a rebuilt copy keeps the no-configuration case
	// byte-identical, so installing this extension and setting nothing cannot
	// change a single token.
	if (kept.length === section.entries.length && preloaded.length === 0 && briefed === 0) return undefined;

	const bodies =
		preloaded.length > 0
			? loadBodies(preloaded, { maxCharsPerSkill: CONFIG.maxCharsPerSkill, maxChars: CONFIG.maxChars })
			: [];

	const replacement = renderSection(prompt, section, kept) + renderBodies(bodies);
	const original = prompt.slice(section.start, section.end);

	return {
		prompt: prompt.slice(0, section.start) + replacement + prompt.slice(section.end),
		decided: decided.map((d) => ({ name: d.entry.name, mode: d.mode, location: d.entry.location })),
		delta: original.length - replacement.length,
	};
}

/**
 * Drop the `/skill:<name>` rows of every `off` skill from a suggestion list.
 *
 * Pure, and exported, so the one thing worth asserting about the menu filter —
 * that it removes exactly those rows and leaves every other suggestion alone —
 * can be checked without a terminal. The value pi puts on a slash-command
 * suggestion is the bare command name, no leading slash (pi-tui's
 * CombinedAutocompleteProvider), so `skill:` is the whole prefix to match.
 *
 * Returns the input unchanged when nothing matched, so the common keystroke
 * allocates nothing and a null (pi's "no suggestions") passes straight through.
 */
export function dropOffSkills<T extends { items: Array<{ value?: string }> } | null | undefined>(
	suggestions: T,
	settings: SkillLoadingSettings,
): T {
	if (!suggestions?.items?.length) return suggestions;
	const items = suggestions.items.filter((item) => {
		if (typeof item.value !== "string" || !item.value.startsWith("skill:")) return true;
		return modeFor(item.value.slice("skill:".length), settings) !== "off";
	});
	return items.length === suggestions.items.length ? suggestions : ({ ...suggestions, items } as T);
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



export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = read(agentDir);

	/** Where the picker tells you your choices went. */
	const where = `${settingsPath(agentDir)} ("${SETTINGS_KEY}")`;

	/**
	 * Save, and say so when it fails.
	 *
	 * The store refuses to write over a settings.json it cannot parse, and a
	 * toggle that silently did nothing would be worse than one that errors: the
	 * picker would keep showing the new mode while the next request kept using
	 * the old one.
	 */
	const save = (next: SkillLoadingSettings, ctx: ExtensionCommandContext): boolean => {
		const result = write(next, agentDir);
		if (!result.ok) {
			ctx.ui.notify(`Could not save: ${result.error}`, "error");
			return false;
		}
		settings = next;
		return true;
	};

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

	/**
	 * `off` also takes the skill out of the `/` menu — the half of the state that
	 * `user-invocable-only` does not do.
	 *
	 * Done by stacking a wrapper on the autocomplete provider and dropping the
	 * `skill:<name>` items an `off` skill contributes. pi builds those from its
	 * own loaded skill list inside interactive-mode, so there is nothing else an
	 * extension can reach: the wrapper filters what is offered, and everything
	 * else — applyCompletion, the trigger characters, file completion — is
	 * delegated untouched, so a bug here can hide a row but cannot break
	 * completion.
	 *
	 * **It hides, it does not block.** Claude Code's `off` refuses the invocation
	 * too; pi's `skillCommands` map is private to interactive-mode, so typing
	 * `/skill:<name>` in full still runs an `off` skill here. That is the one
	 * place this vocabulary is not literally Claude Code's, and it is documented
	 * rather than papered over.
	 *
	 * Installed once per process, not per session_start — that event fires on
	 * every resume and reload, and stacking a wrapper each time would leave a
	 * chain of them filtering the same list.
	 */
	let filterInstalled = false;
	const installMenuFilter = (ctx: { ui: { addAutocompleteProvider?: (factory: unknown) => void } }) => {
		if (filterInstalled || typeof ctx.ui.addAutocompleteProvider !== "function") return;
		filterInstalled = true;
		ctx.ui.addAutocompleteProvider((current: any) => ({
			...current,
			// Bound, not spread: these are prototype methods on pi's own provider
			// and would lose `this` if they were copied off it by the spread above.
			applyCompletion: (...args: unknown[]) => current.applyCompletion(...args),
			shouldTriggerFileCompletion: current.shouldTriggerFileCompletion?.bind(current),
			// `settings` is read live rather than captured, so a toggle in the
			// picker takes the row out of the menu without a restart.
			getSuggestions: async (...args: unknown[]) => dropOffSkills(await current.getSuggestions(...args), settings),
		}));
	};

	pi.on("session_start", (_event, ctx) => {
		// Re-read rather than trust the in-memory copy: another pi window may have
		// changed the file since this one started, and the file is the truth.
		settings = read(agentDir);
		last = undefined;
		unedited = undefined;
		installMenuFilter(ctx as never);
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
			settings = read(agentDir);

			if (!ctx.hasUI) {
				ctx.ui.notify(summary(ctx), "info");
				return;
			}

			await pick(ctx);
		},
	});

	/**
	 * The picker: one list, Space cycles, Esc saves.
	 *
	 * Everything about the interaction is in picker.ts; this is the mount and the
	 * one write. `overlay: false` puts it in the editor's slot, the same place
	 * pi's own selector and `/workflows` go — a list you scroll and type at wants
	 * the bottom of the screen, not a box over the middle of the transcript.
	 */
	const pick = async (ctx: ExtensionCommandContext): Promise<void> => {
		const skills = loadedSkills(ctx);
		if (skills.length === 0) {
			ctx.ui.notify("No skills are loaded, so there is nothing to tune.", "info");
			return;
		}

		// Before the first turn nothing has been edited yet, so pi's live prompt
		// is already the unedited one — the fallback is correct, not a guess.
		const rows = pickerRows(buildRows(skills, unedited ?? ctx.getSystemPrompt(), settings), modeFor(DEFAULT_ROW, settings));

		const result = await ctx.ui.custom<PickerResult>(
			(tui, theme, _keybindings, done) =>
				new SkillsPicker(rows, settings.skills, theme, () => tui.terminal?.rows ?? PICKER_ROWS_FALLBACK, done),
			{ overlay: false },
		);
		// Undefined is both "cancelled" and "saved with nothing changed", and both
		// want the same thing: leave the file alone.
		if (!result) return;

		if (save({ skills: result }, ctx)) {
			const changed = rows.filter((row, index) => (result[row.name] ?? DEFAULT_MODE) !== row.mode).length;
			ctx.ui.notify(`${changed} skill${changed === 1 ? "" : "s"} updated. Takes effect on the next request.`, "info");
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
		lines.push(`Preferences: ${where}`);
		return lines.join("\n");
	};
}
