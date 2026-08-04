/**
 * Rich statusline (custom footer) for pi.
 *
 * Line 1:  <model>  │  <cwd>  │  <branch>  │  +added,-removed  │  v<pi-version>
 * Line 2:  Context: [████····] <tokens>/<window> (<pct>%)  Cached: <c>  In: <i>  Out: <o>  Total: <t>
 * Line 3:  Weekly: [████····] <pct>% (resets <time>)   [further windows, if any]
 * Last:    one line per active workflow run, while any is in flight
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
 * only a weekly window, in the slot normally used for a 5h session meter.
 *
 * The workflow lines are the one piece of footer content this extension does not
 * source itself: ultracode announces its active runs on WORKFLOW_CHANNEL and they
 * are appended last, so long-running background work is visible without opening
 * /workflows. Nothing is drawn when no run is in flight. This is content, not a
 * presence chip — setStatus() chips stay unrendered (see the note in render).
 *
 * The footer draws nothing at all while ask_user has a question up (announced the
 * same way, on ASK_CHANNEL): that question stands in for the editor, and this
 * gets out of its way for the duration. Same for ultracode's /workflows control
 * panel (WORKFLOW_PANEL_CHANNEL), which stands in for the editor too — and is
 * showing those run lines in full while it is up.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createRequire } from "node:module";
import { ASK_CHANNEL, CONFIG, SHELL_CHANNEL, SHELL_PANEL_CHANNEL, WORKFLOW_CHANNEL, WORKFLOW_PANEL_CHANNEL } from "./config.ts";
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

			// ultracode re-announces on every panel tick while runs are live and
			// once more when the last one settles, so this both fills and clears
			// itself — there is nothing to poll from this side.
			let workflowLines: string[] | undefined;
			const unsubWorkflows = pi.events.on(WORKFLOW_CHANNEL, (data) => {
				const next = (data as { lines?: string[] } | undefined)?.lines;
				workflowLines = next?.length ? next : undefined;
				tui.requestRender();
			});

			// ask_user replaces the editor with its question; this footer steps
			// aside for as long as that lasts, so the question has the prompt and
			// the footer to itself.
			let asking = false;
			const unsubAsk = pi.events.on(ASK_CHANNEL, (data) => {
				asking = (data as { active?: boolean } | undefined)?.active === true;
				tui.requestRender();
			});

			// The /workflows panel takes the editor's place the way a question
			// does, so this stands down for it too — including the run lines
			// below, which the panel is showing in full anyway.
			let panelOpen = false;
			const unsubPanel = pi.events.on(WORKFLOW_PANEL_CHANNEL, (data) => {
				panelOpen = (data as { active?: boolean } | undefined)?.active === true;
				tui.requestRender();
			});

			// Background shells, same contract as the workflow lines: announced,
			// re-announced while any is running, cleared with undefined.
			let shellLines: string[] | undefined;
			const unsubShells = pi.events.on(SHELL_CHANNEL, (data) => {
				const next = (data as { lines?: string[] } | undefined)?.lines;
				shellLines = next?.length ? next : undefined;
				tui.requestRender();
			});

			// And its shift+up panel replaces the editor the way /workflows does.
			let shellPanelOpen = false;
			const unsubShellPanel = pi.events.on(SHELL_PANEL_CHANNEL, (data) => {
				shellPanelOpen = (data as { active?: boolean } | undefined)?.active === true;
				tui.requestRender();
			});

			return {
				dispose() {
					unsub();
					unsubWorkflows();
					unsubAsk();
					unsubPanel();
					unsubShells();
					unsubShellPanel();
					usage?.dispose();
				},
				invalidate() {},
				render(width: number): string[] {
					if (asking || panelOpen || shellPanelOpen) return [];

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

					// Extension status chips (set via ctx.ui.setStatus()) are deliberately
					// NOT rendered: the footer ends at the git segment. A custom footer
					// replaces the built-in one, so simply not drawing them here hides
					// every extension's chip at once, present and future.

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

					// --- last: active workflow runs, while any is in flight ---
					for (const line of workflowLines ?? []) {
						lines.push(truncateToWidth(paint(theme, CONFIG.colors.workflow, line), width));
					}

					// --- and running background shells, the same way ---
					for (const line of shellLines ?? []) {
						lines.push(truncateToWidth(paint(theme, CONFIG.colors.workflow, line), width));
					}

					return lines;
				},
			};
		});
	});
}
