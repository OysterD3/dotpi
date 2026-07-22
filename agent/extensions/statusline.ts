/**
 * Rich statusline (custom footer) for pi.
 *
 * Line 1:  <model>  |  <cwd>  |  <branch>  |  (+added,-removed)  |  v<pi-version>
 * Line 2:  Context: [====------] <tokens>/<window> (<pct>%)  Cached: <c>  In: <i>  Out: <o>  Total: <t>
 *
 * Data sources:
 *   - model / cwd / usage tokens : ctx.model, ctx.cwd, ctx.sessionManager.getEntries()
 *   - context window / percent   : ctx.getContextUsage()
 *   - git branch                 : footerData.getGitBranch()
 *   - git diff (+/-)             : `git diff --numstat HEAD` (shelled out, cached briefly)
 *
 * NOT shown: Session / Weekly usage-limit meters — pi does not expose subscription
 * rate-limit data, so those cannot be replicated here.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** pi's own version, resolved once (best-effort). */
function piVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		return req("@earendil-works/pi-coding-agent/package.json").version ?? "";
	} catch {
		return "";
	}
}

/** Sum of added/removed lines vs HEAD, cached for a short window to avoid spawning git on every render. */
function makeGitDiffCounter(cwd: string) {
	let cache: { added: number; removed: number } | null = null;
	let stamp = 0;
	return (): { added: number; removed: number } | null => {
		const now = Date.now();
		if (cache && now - stamp < 2000) return cache;
		stamp = now;
		try {
			const out = execFileSync("git", ["diff", "--numstat", "HEAD"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1500,
			});
			let added = 0;
			let removed = 0;
			for (const line of out.split("\n")) {
				const [a, r] = line.split("\t");
				if (a && a !== "-") added += Number(a) || 0;
				if (r && r !== "-") removed += Number(r) || 0;
			}
			cache = { added, removed };
		} catch {
			cache = null;
		}
		return cache;
	};
}

function bar(percent: number, cells = 12): string {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	return "█".repeat(filled) + "░".repeat(cells - filled);
}

export default function (pi: ExtensionAPI) {
	const version = piVersion();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const gitDiff = makeGitDiffCounter(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose: unsub,
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
					const usage = ctx.getContextUsage();
					const window = usage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = usage?.tokens ?? null;
					const pct = usage?.percent ?? null;
					const pctStr = pct === null ? "?" : pct.toFixed(0);
					const pctColor = pct !== null && pct > 90 ? "error" : pct !== null && pct > 70 ? "warning" : "accent";

					// --- line 1: model | cwd | branch | diff | version ---
					const parts1: string[] = [];
					parts1.push(theme.fg("accent", ctx.model?.id || "no-model"));
					parts1.push(theme.fg("dim", formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE)));
					const branch = footerData.getGitBranch();
					if (branch) parts1.push(theme.fg("mdListBullet", branch));
					const diff = gitDiff();
					if (diff && (diff.added > 0 || diff.removed > 0)) {
						parts1.push(
							theme.fg("success", `+${diff.added}`) +
								theme.fg("dim", ",") +
								theme.fg("error", `-${diff.removed}`),
						);
					}
					if (version) parts1.push(theme.fg("dim", `v${version}`));
					const sep1 = theme.fg("dim", "  │  ");
					const line1 = parts1.join(sep1);

					// --- line 2: context bar + token breakdown ---
					const barStr =
						theme.fg("dim", "[") + theme.fg(pctColor, bar(pct ?? 0)) + theme.fg("dim", "]");
					const ctxLabel =
						ctxTokens === null
							? `?/${formatTokens(window)}`
							: `${formatTokens(ctxTokens)}/${formatTokens(window)}`;
					const line2 =
						theme.fg("muted", "Context: ") +
						barStr +
						` ${theme.fg(pctColor, ctxLabel)} ${theme.fg("dim", `(${pctStr}%)`)}  ` +
						theme.fg("muted", "Cached: ") +
						theme.fg("mdCode", formatTokens(cached)) +
						theme.fg("muted", "  In: ") +
						formatTokens(input) +
						theme.fg("muted", "  Out: ") +
						theme.fg("warning", formatTokens(output)) +
						theme.fg("muted", "  Total: ") +
						theme.bold(formatTokens(total));

					return [truncateToWidth(line1, width), truncateToWidth(line2, width)];
				},
			};
		});
	});
}
