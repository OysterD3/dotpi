/**
 * Rich statusline (custom footer) for pi.
 *
 * Line 1:  <model>  │  <cwd>  │  <branch>  │  +added,-removed  │  v<pi-version>
 * Line 2:  Context: [████····] <tokens>/<window> (<pct>%)  Cached: <c>  In: <i>  Out: <o>  Total: <t>
 * Line 3:  Weekly: [████····] <pct>% (resets <time>)   [further windows, if any]
 *
 *   config.ts  tunables, colors, bar glyphs
 *   git.ts     working-tree diff counts
 *   usage.ts   subscription limit windows (Codex provider)
 *   render.ts  colors, number formatting, meters (pure)
 *   index.ts   footer wiring and layout
 *
 * Data sources:
 *   - model / cwd / usage tokens : ctx.model, ctx.cwd, ctx.sessionManager.getEntries()
 *   - context window / percent   : ctx.getContextUsage()
 *   - git branch                 : footerData.getGitBranch()
 *   - git diff (+/-)             : ./git.ts
 *   - subscription limits        : ./usage.ts
 *
 * Line 3 appears only when the provider actually reports limit windows. Each window is
 * labelled by its own reported duration, not by slot order — a Codex account reports
 * only a weekly window, in the slot Claude Code uses for its 5h session meter.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { CONFIG } from "./config.ts";
import { makeGitDiffCounter } from "./git.ts";
import {
	formatCwd,
	formatTokens,
	limitSegment,
	meter,
	meterColor,
	paint,
} from "./render.ts";
import { createUsageReader } from "./usage.ts";

/** pi's own version, resolved once (best-effort). */
function piVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		return req("@earendil-works/pi-coding-agent/package.json").version ?? "";
	} catch {
		return "";
	}
}

export default function (pi: ExtensionAPI) {
	const version = piVersion();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const gitDiff = makeGitDiffCounter(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const usage = CONFIG.showLimits ? createUsageReader(ctx, () => tui.requestRender()) : null;

			return {
				dispose() {
					unsub();
					usage?.dispose();
				},
				invalidate() {},
				render(width: number): string[] {
					// --- token totals from all assistant messages ---
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = (entry.message as AssistantMessage).usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
						}
					}
					const cached = cacheRead + cacheWrite;
					const total = input + output + cached;

					// --- context window usage ---
					const ctxUsage = ctx.getContextUsage();
					const window = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = ctxUsage?.tokens ?? null;
					const pct = ctxUsage?.percent ?? null;
					const pctStr = pct === null ? "?" : pct.toFixed(0);

					// --- line 1: model │ cwd │ branch │ diff │ version ---
					const parts1: string[] = [
						paint(theme, CONFIG.colors.model, ctx.model?.id || "no-model"),
						paint(
							theme,
							CONFIG.colors.cwd,
							formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE),
						),
					];

					const branch = footerData.getGitBranch();
					if (branch) parts1.push(paint(theme, CONFIG.colors.branch, branch));

					// null means "not a git work tree" — then there is genuinely nothing to show.
					// A clean tree still renders +0,-0 so the segment doesn't silently vanish.
					const diff = gitDiff();
					if (diff && (CONFIG.alwaysShowDiff || diff.added > 0 || diff.removed > 0)) {
						parts1.push(
							paint(theme, CONFIG.colors.added, `+${diff.added}`) +
								paint(theme, CONFIG.colors.separator, ",") +
								paint(theme, CONFIG.colors.removed, `-${diff.removed}`),
						);
					}

					if (version) parts1.push(paint(theme, CONFIG.colors.version, `v${version}`));
					const line1 = parts1.join(paint(theme, CONFIG.colors.separator, "  │  "));

					// --- line 2: context bar + token breakdown ---
					const ctxLabel =
						ctxTokens === null
							? `?/${formatTokens(window)}`
							: `${formatTokens(ctxTokens)}/${formatTokens(window)}`;
					const line2 =
						paint(theme, CONFIG.colors.label, "Context: ") +
						meter(theme, pct) +
						` ${paint(theme, meterColor(pct), ctxLabel)} ${paint(theme, CONFIG.colors.separator, `(${pctStr}%)`)}  ` +
						paint(theme, CONFIG.colors.label, "Cached: ") +
						paint(theme, CONFIG.colors.cached, formatTokens(cached)) +
						paint(theme, CONFIG.colors.label, "  In: ") +
						formatTokens(input) +
						paint(theme, CONFIG.colors.label, "  Out: ") +
						paint(theme, CONFIG.colors.out, formatTokens(output)) +
						paint(theme, CONFIG.colors.label, "  Total: ") +
						theme.bold(formatTokens(total));

					const lines = [truncateToWidth(line1, width), truncateToWidth(line2, width)];

					// --- line 3: subscription limits, when the provider supplies them ---
					const limits = usage?.get();
					if (limits && limits.windows.length > 0) {
						const segments = limits.windows.map((limit) => limitSegment(theme, limit));
						lines.push(truncateToWidth(segments.join("   "), width));
					}

					return lines;
				},
			};
		});
	});
}
