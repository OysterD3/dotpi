/**
 * LSP diagnostics for pi.
 *
 * pi ships no LSP support of any kind, so this is a complete client: it spawns language
 * servers, speaks the JSON-RPC base protocol over stdio, and exposes an `lsp_diagnostics`
 * tool the model can call to check its own work without running a build.
 *
 *   servers.ts   the registry — the nvim-lspconfig equivalent, edit this to add a language
 *   protocol.ts  Content-Length framing and URI helpers (pure)
 *   client.ts    one server process: spawn, initialize, didOpen, collect diagnostics
 *   manager.ts   server selection, project-root detection, client reuse and reaping
 *   format.ts    compact `path:line:col: severity: message` rendering (pure)
 *   render.ts    collapsed/expanded TUI view
 *   config.ts    timeouts and limits
 *
 * Servers live under ~/.pi/agent/lsp, installed with `pnpm install` there, so nothing
 * touches your global environment.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG } from "./config.ts";
import { formatResults, summarize } from "./format.ts";
import { LspManager } from "./manager.ts";
import { bodyText, renderCollapsible } from "./render.ts";
import { SERVERS } from "./servers.ts";

export default function (pi: ExtensionAPI) {
	const manager = new LspManager();

	const languages = [...new Set(Object.values(SERVERS).flatMap((spec) => spec.extensions))]
		.map((extension) => `.${extension}`)
		.join(", ");

	// Servers are spawned lazily by the tool, never from this factory — pi's docs are
	// explicit that factories may run in invocations that never start a session, so
	// background processes must not start here. This handler is idempotent and reaps
	// whatever the tool did start.
	pi.on("session_shutdown", async () => {
		await manager.disposeAll();
	});

	pi.registerTool({
		name: "lsp_diagnostics",
		label: "LSP Diagnostics",
		description:
			`Report compiler and linter diagnostics (errors, warnings) for source files using ` +
			`their language server. Supports ${languages}. Use this after editing code to verify ` +
			`the change compiles, instead of guessing or running a full build. The first call ` +
			`for a project is slow while the server indexes it; later calls are fast.`,
		promptSnippet: "Check source files for compile errors via their language server",
		promptGuidelines: [
			"Call lsp_diagnostics on files you have just created or edited, before telling the user the work is done.",
			"Prefer lsp_diagnostics over running a full build or type-check command when you only need to know whether the code is valid.",
		],
		parameters: Type.Object({
			paths: Type.Array(Type.String(), {
				minItems: 1,
				maxItems: CONFIG.maxFiles,
				description: `Absolute or relative paths of source files to check (max ${CONFIG.maxFiles}).`,
			}),
			severity: Type.Optional(
				Type.Integer({
					minimum: 1,
					maximum: 4,
					description:
						"Minimum severity to report: 1=error, 2=warning, 3=info, 4=hint. Defaults to 2 " +
						"(errors and warnings).",
				}),
			),
		}),

		async execute(_toolCallId, params, _signal, onUpdate, ctx) {
			const threshold = params.severity ?? 2;

			onUpdate?.({
				content: [{ type: "text", text: `Checking ${params.paths.length} file(s)…` }],
				details: { files: [] },
			});

			// Sequential rather than parallel: several files usually share one server, and
			// the first call pays the whole project-indexing cost. Racing them would just
			// pile identical work onto one cold server.
			const files = [];
			for (const path of params.paths) {
				const result = await manager.diagnose(path);
				files.push({
					...result,
					diagnostics: result.diagnostics.filter((d) => (d.severity ?? 1) <= threshold),
				});
			}

			return {
				content: [{ type: "text", text: formatResults(files, ctx.cwd) }],
				details: {
					files: files.map((file) => ({
						path: file.path,
						server: file.server,
						count: file.diagnostics.length,
						error: file.error,
					})),
					summary: summarize(files),
				},
			};
		},

		renderResult(result, { expanded }, theme) {
			return renderCollapsible(bodyText(result.content), expanded, theme);
		},
	});
}
