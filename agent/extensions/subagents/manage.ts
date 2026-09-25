/**
 * The interactive /subagents wizard — edit and pick a subagent through pi's
 * dialogs (input / select / confirm / editor), so a subagent can be changed
 * inside pi instead of by editing its file. Creating one is the
 * subagent-creator skill's job (index.ts). The flow returns a plain
 * SubagentDef (or undefined when cancelled); index.ts writes it back to the
 * agent's file.
 *
 * Kept separate from index.ts and free of pi imports so the whole wizard can be
 * driven by a scripted fake `ctx` in tests.
 */

import type { SubagentDef } from "./config.ts";

/** The subset of ExtensionContext the wizard uses; loose so tests can fake it. */
export interface WizardCtx {
	hasUI: boolean;
	modelRegistry: { getAll: () => Array<{ id: string; provider: string }> };
	ui: {
		input: (label: string, placeholder?: string) => Promise<string | undefined>;
		select: (label: string, options: string[]) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		editor: (label: string, prefilled?: string) => Promise<string | undefined>;
		notify: (message: string, level: "info" | "warning" | "error") => void;
	};
}

const MODEL_DEFAULT = "(session default)";
const REASONING_DEFAULT = "(inherit)";
const REASONING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"];

type Step<T> = { ok: true; value: T } | { ok: false };
const CANCEL = { ok: false } as const;

function modelOptions(ctx: WizardCtx, current?: string): string[] {
	const ids = ctx.modelRegistry.getAll().map((m) => `${m.provider}/${m.id}`);
	return [...new Set([MODEL_DEFAULT, ...(current ? [current] : []), ...ids.sort()])];
}

async function askModel(ctx: WizardCtx, current?: string): Promise<Step<string | undefined>> {
	const choice = await ctx.ui.select(current ? `Model [current: ${current}]` : "Model", modelOptions(ctx, current));
	if (choice === undefined) return CANCEL;
	return { ok: true, value: choice === MODEL_DEFAULT ? undefined : choice };
}

async function askReasoning(ctx: WizardCtx, current?: string): Promise<Step<string | undefined>> {
	const options = [REASONING_DEFAULT, ...REASONING_LEVELS];
	const choice = await ctx.ui.select(current ? `Reasoning [current: ${current}]` : "Reasoning", options);
	if (choice === undefined) return CANCEL;
	return { ok: true, value: choice === REASONING_DEFAULT ? undefined : choice };
}

async function askTools(ctx: WizardCtx, current?: string[]): Promise<Step<string[] | undefined>> {
	const currentLabel = current ? ` [current: ${current.join(", ")}]` : "";
	const choice = await ctx.ui.select(`Tools${currentLabel}`, ["All tools", `Read-only (${READ_ONLY_TOOLS.join(", ")})`, "Custom…"]);
	if (choice === undefined) return CANCEL;
	if (choice === "All tools") return { ok: true, value: undefined };
	if (choice.startsWith("Read-only")) return { ok: true, value: [...READ_ONLY_TOOLS] };
	const raw = await ctx.ui.input("Tools (comma-separated, e.g. read,bash,edit,write)", current?.join(",") ?? "");
	const list = (raw ?? "").split(",").map((tool) => tool.trim()).filter(Boolean);
	return { ok: true, value: list.length > 0 ? list : undefined };
}

async function askPrompt(ctx: WizardCtx, current?: string): Promise<Step<string | undefined>> {
	const want = await ctx.ui.confirm("Add a custom role prompt?", current ? "Edit the existing role prompt." : "Optional — defaults to the purpose.");
	if (!want) return { ok: true, value: current };
	const text = await ctx.ui.editor("Role prompt", current ?? "");
	const trimmed = (text ?? "").trim();
	return { ok: true, value: trimmed || undefined };
}

/** The one-glance description used by the wizard's confirm and the draft's. */
export function summary(def: SubagentDef): string {
	const model = def.model ?? "session model";
	const reasoning = def.reasoning ?? "session reasoning";
	const tools = def.tools ? def.tools.join(", ") : "all tools";
	return `${model} · ${reasoning} · ${tools}\n${def.purpose}`;
}

/**
 * Change a subagent. The fields are pre-seeded from `existing` and the name is
 * fixed (a rename is a new file). Returns the definition, or undefined if the
 * user backed out anywhere.
 */
export async function runWizard(ctx: WizardCtx, existing: SubagentDef): Promise<SubagentDef | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("Configuring subagents needs the interactive TUI.", "error");
		return undefined;
	}

	const purposeRaw = await ctx.ui.input("Purpose (one line — what it is for)", existing.purpose);
	// An empty submit keeps the current value.
	const purpose = purposeRaw?.trim() || existing.purpose;

	const model = await askModel(ctx, existing.model);
	if (!model.ok) return undefined;
	const reasoning = await askReasoning(ctx, existing.reasoning);
	if (!reasoning.ok) return undefined;
	const tools = await askTools(ctx, existing.tools);
	if (!tools.ok) return undefined;
	const prompt = await askPrompt(ctx, existing.prompt);
	if (!prompt.ok) return undefined;

	const def: SubagentDef = {
		name: existing.name,
		purpose,
		model: model.value,
		reasoning: reasoning.value,
		tools: tools.value,
		prompt: prompt.value,
	};

	const confirmed = await ctx.ui.confirm(`Save "${existing.name}"?`, summary(def));
	return confirmed ? def : undefined;
}

/** Choose a subagent name for edit/remove: use the arg if valid, else a picker. */
export async function pickName(ctx: WizardCtx, names: string[], verb: string, arg?: string): Promise<string | undefined> {
	if (arg && names.includes(arg)) return arg;
	if (arg) ctx.ui.notify(`No subagent named "${arg}".`, "error");
	if (names.length === 0) {
		ctx.ui.notify("No subagents configured yet. Use /subagents add.", "info");
		return undefined;
	}
	return await ctx.ui.select(`Which subagent to ${verb}?`, names);
}
