/**
 * provider — switch every model this config uses, in one command.
 *
 * Six extensions here resolve a model reference of their own (advisor, goal,
 * permissions' auto classifier, recap, subagents, ultracode), and pi has its
 * own `defaultProvider`/`defaultModel` on top. Written out concretely, changing
 * provider means finding eight fully-qualified `provider/id` strings across two
 * files — and every one you miss goes on quietly billing the old provider.
 *
 * So references become ROLES, and roles are defined per provider:
 *
 *   "models": {
 *     "active": "openai",
 *     "providers": {
 *       "openai":    { "session": "openai-codex/gpt-5.6-sol:max",  "cheap": "openai-codex/gpt-5.4-mini" },
 *       "anthropic": { "session": "anthropic/claude-opus-4-5:high", "cheap": "anthropic/claude-haiku-4-5" }
 *     }
 *   }
 *
 * With `permissions.auto.model: "cheap"` and `advisor.model: "session"`,
 * `/provider anthropic` moves all of it at once. A reference may end in
 * `:level` — pi's own `--model` syntax — to pin the thinking level that model
 * runs at; the session role's level is applied live and persisted as
 * `defaultThinkingLevel`.
 *
 *   config.ts    the contract, and the reserved `session` role
 *   roles.ts     reading the block; resolveRole is the copied part
 *   settings.ts  rewriting settings.json, atomically, preserving everything
 *
 * This extension is OPTIONAL. The role map is a data contract, not a module:
 * every consumer carries its own fifteen-line reader, so roles work with this
 * extension uninstalled — you just edit `models.active` by hand instead.
 */

import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG, SESSION_ROLE, SETTINGS_KEY } from "./config.ts";
import { parseBlock, planSwitch, profileFor, splitThinking, type ModelsBlock } from "./roles.ts";
import { readSettings, settingsPath, writeActive } from "./settings.ts";

function load(agentDir: string): { block: ModelsBlock; warnings: string[] } {
	return parseBlock(readSettings(agentDir));
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();

	pi.registerCommand("provider", {
		description: "Switch every model this config uses (<name> | list)",

		getArgumentCompletions: (prefix) => {
			const { block } = load(agentDir);
			return ["list", ...Object.keys(block.providers)]
				.filter((option) => option.startsWith(prefix))
				.map((value) => ({ value, label: value }));
		},

		handler: async (args, ctx) => {
			const text = args.trim();
			const { block, warnings } = load(agentDir);

			if (warnings.length > 0) ctx.ui.notify(`Provider:\n${warnings.join("\n")}`, "warning");

			const names = Object.keys(block.providers);
			if (names.length === 0) {
				ctx.ui.notify(
					[
						`No provider profiles defined. Add them to ${settingsPath(agentDir)}:`,
						"",
						`  "${SETTINGS_KEY}": {`,
						`    "active": "openai",`,
						`    "providers": {`,
						`      "openai":    { "${SESSION_ROLE}": "openai-codex/gpt-5.6-sol", "cheap": "openai-codex/gpt-5.4-mini" },`,
						`      "anthropic": { "${SESSION_ROLE}": "anthropic/claude-opus-4-5", "cheap": "anthropic/claude-haiku-4-5" }`,
						"    }",
						"  }",
						"",
						`Then name a role instead of a model: "permissions": { "auto": { "model": "cheap" } }.`,
					].join("\n"),
					"info",
				);
				return;
			}

			// Bare, or `list`: show where things stand rather than changing them.
			if (text.length === 0 || text === "list") {
				const active = profileFor(block, block.active);
				const lines = [
					block.active ? `Active: ${block.active}` : `Active: (none set — ${SETTINGS_KEY}.active is unset)`,
					"",
					...names.map((name) => {
						const roles = Object.entries(block.providers[name] ?? {});
						const shown = roles.slice(0, CONFIG.maxRolesShown);
						const suffix = roles.length > shown.length ? `, +${roles.length - shown.length} more` : "";
						return `  ${name === block.active ? "▸" : " "} ${name.padEnd(12)} ${shown.map(([role]) => role).join(", ")}${suffix}`;
					}),
				];
				if (active) {
					lines.push("", "Roles in the active profile:");
					for (const [role, reference] of Object.entries(active)) lines.push(`  ${role.padEnd(12)} ${reference}`);
				}
				lines.push("", "/provider <name> switches. Extensions naming a role follow automatically.");
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const plan = planSwitch(block, text);
			if ("error" in plan) {
				ctx.ui.notify(plan.error, "error");
				return;
			}

			if (text === block.active) {
				ctx.ui.notify(`Already on ${text}.`, "info");
				return;
			}

			// The session reference may carry a `:level` suffix. Whether that
			// trailing token is a thinking level or part of the id is the
			// registry's call: the full reference is tried first, and only a miss
			// splits — so a model whose id genuinely ends in a level name keeps it.
			const registry = ctx.modelRegistry.getAll();
			const find = (reference: string) =>
				registry.find((model) => `${model.provider}/${model.id}`.toLowerCase() === reference.toLowerCase());
			let sessionReference = plan.session;
			let thinking: string | undefined;
			let target = plan.session ? find(plan.session) : undefined;
			if (plan.session && !target) {
				const split = splitThinking(plan.session);
				if (split.thinking) {
					sessionReference = split.reference;
					thinking = split.thinking;
					target = find(split.reference);
				}
			}

			const written = writeActive(agentDir, text, sessionReference, thinking);
			if (!written.ok) {
				ctx.ui.notify(`Could not switch: ${written.error}`, "error");
				return;
			}

			const report = [`Provider: ${block.active ?? "(none)"} → ${text}`, ""];
			for (const move of plan.moved) {
				report.push(`  ${move.role.padEnd(12)} ${move.from ? `${move.from} → ` : ""}${move.to}`);
			}

			// Moved live, not just on disk. Without this the file says anthropic and
			// the model answering you is still the old one until a restart, which is
			// the kind of half-applied state that gets blamed on the model.
			if (plan.session) {
				if (!target) {
					report.push("", `The ${SESSION_ROLE} role names ${sessionReference}, which is not a model pi knows. Session model unchanged.`);
				} else if (!(await pi.setModel(target))) {
					// setModel's own answer, not a guess: it returns false when the
					// provider has no usable credential.
					report.push("", `Switched on disk, but ${sessionReference} has no API key configured — the session model is unchanged.`);
				} else {
					// Level after model, because pi clamps the level to what the model
					// supports — and the applied level is read back so a clamp is
					// reported instead of silently pretending the request took.
					let note = "";
					if (thinking) {
						pi.setThinkingLevel(thinking as Parameters<typeof pi.setThinkingLevel>[0]);
						const applied = pi.getThinkingLevel();
						note = applied === thinking ? ` (thinking: ${thinking})` : ` (thinking: ${thinking}, applied as ${applied})`;
					}
					report.push("", `Session model is now ${sessionReference}${note}.`);
				}
			} else {
				report.push("", `This profile defines no "${SESSION_ROLE}" role, so the session model is unchanged.`);
			}

			// The failure this command exists to prevent, so it is said loudly: a
			// role the new profile does not define stops being a role and is read as
			// a literal model reference by whichever extension names it.
			if (plan.dropped.length > 0) {
				report.push(
					"",
					`Not defined in ${text}: ${plan.dropped.join(", ")}.`,
					"Any extension naming one of those now resolves it as a literal model reference, which will probably fail.",
				);
			}

			ctx.ui.notify(report.join("\n"), plan.dropped.length > 0 ? "warning" : "info");
		},
	});
}
