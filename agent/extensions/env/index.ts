/**
 * Loads `.env` files into `process.env` so secrets live in one file instead of your
 * shell profile.
 *
 * pi has no native dotenv support (no `dotenv` dependency; every `.env` string in its
 * shipped code is just a `process.env` read), so this fills that gap. Other extensions
 * that read `process.env` at call time — such as `web-search` reading `EXA_API_KEY`
 * inside `execute()` — pick these up automatically.
 *
 *   config.ts  tunables
 *   parse.ts   dotenv text -> key/value pairs (pure)
 *   load.ts    file discovery, permissions check, applying to process.env
 *   index.ts   extension wiring
 *
 * Precedence, most specific first:
 *   1. the real environment   (a var exported in your shell is never overwritten)
 *   2. <cwd>/.pi/.env         (project-local)
 *   3. ~/.pi/agent/.env       (global)
 *
 * SECURITY: `.env` is gitignored in this repo and must stay that way — this config
 * directory is a public repo. The loader warns if the file is readable by other users
 * on the machine; `chmod 600` it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { envFilePaths, loadEnvFiles } from "./load.ts";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		const { loaded, warnings } = loadEnvFiles(envFilePaths(ctx.cwd));

		if (ctx.mode !== "tui") return;

		for (const warning of warnings) {
			ctx.ui.notify(`env: ${warning}`, "warning");
		}
		if (CONFIG.announce && loaded.length > 0) {
			// Names only. Never log a value.
			ctx.ui.notify(`env: loaded ${loaded.join(", ")}`, "info");
		}
	});
}
