/**
 * Language server registry — the nvim-lspconfig equivalent, and the only file you should
 * need to touch to add a language.
 *
 * Adding a server is one entry:
 *
 *   rust_analyzer: {
 *     cmd: () => [resolve("rust-analyzer")],
 *     extensions: ["rs"],
 *     languageId: "rust",
 *     rootMarkers: ["Cargo.toml", ".git"],
 *   },
 *
 * Fields mirror lspconfig's vocabulary: `cmd`, `filetypes` (here `extensions`, since we
 * match by file extension), `root_dir` markers, `settings`, `init_options`.
 *
 * `cmd` is a function so a missing binary is reported when the server is actually needed,
 * rather than throwing at import time and taking the whole extension down.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Servers installed under ~/.pi/agent/lsp by `pnpm install` there. */
const LOCAL_BIN = join(homedir(), ".pi", "agent", "lsp", "node_modules", ".bin");
/** Go tools installed with GOBIN pointed at ~/.pi/agent/lsp/bin. */
const LOCAL_GO_BIN = join(homedir(), ".pi", "agent", "lsp", "bin");

/**
 * Prefer the pinned local install, then a Go-installed copy, then whatever is on PATH.
 * Returning the bare name lets the OS resolve it via PATH.
 */
export function resolveBin(name: string): string {
	for (const dir of [LOCAL_BIN, LOCAL_GO_BIN]) {
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return name;
}

export type ServerSpec = {
	/** Argv. Evaluated lazily so a missing binary surfaces as a clear runtime error. */
	cmd: () => string[];
	/** File extensions, without the dot, that this server handles. */
	extensions: string[];
	/** LSP languageId sent in didOpen. A function when it varies by extension. */
	languageId: string | ((extension: string) => string);
	/** Files or directories marking the project root, nearest match wins. */
	rootMarkers: string[];
	/** Sent as `initializationOptions` in the initialize request. */
	initializationOptions?: unknown;
	/** Sent via `workspace/didChangeConfiguration` after initialize. */
	settings?: unknown;
	/** Set false to keep the entry but stop it being used. */
	enabled?: boolean;
	/** Shown when the binary is missing. */
	installHint?: string;
};

export const SERVERS: Record<string, ServerSpec> = {
	/**
	 * TypeScript and JavaScript.
	 * Drives tsserver from the pinned typescript 5.x install — TypeScript 7 dropped the
	 * tsserver binary entirely, so this must not float to latest.
	 */
	ts_ls: {
		cmd: () => [resolveBin("typescript-language-server"), "--stdio"],
		extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
		languageId: (ext) =>
			ext === "ts" || ext === "mts" || ext === "cts"
				? "typescript"
				: ext === "tsx"
					? "typescriptreact"
					: ext === "jsx"
						? "javascriptreact"
						: "javascript",
		rootMarkers: ["tsconfig.json", "jsconfig.json", "package.json", ".git"],
		installHint: "cd ~/.pi/agent/lsp && pnpm install",
	},

	/** Python. */
	pyright: {
		cmd: () => [resolveBin("pyright-langserver"), "--stdio"],
		extensions: ["py", "pyi"],
		languageId: "python",
		rootMarkers: ["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", ".git"],
		settings: {
			python: {
				analysis: {
					// Match what a plain `pyright` run reports, rather than a stricter mode
					// that would flood the agent with style-level complaints.
					typeCheckingMode: "standard",
					diagnosticMode: "openFilesOnly",
				},
			},
		},
		installHint: "cd ~/.pi/agent/lsp && pnpm install",
	},

	/** Go. gopls speaks LSP over stdio with no arguments. */
	gopls: {
		cmd: () => [resolveBin("gopls")],
		extensions: ["go"],
		languageId: "go",
		rootMarkers: ["go.work", "go.mod", ".git"],
		installHint: "GOBIN=~/.pi/agent/lsp/bin go install golang.org/x/tools/gopls@latest",
	},

	/**
	 * Java. Configured but intentionally not installed — eclipse.jdt.ls is 100MB+ with a
	 * slow cold start. Install it and this entry starts working; until then the tool says
	 * so plainly instead of failing obscurely.
	 */
	jdtls: {
		cmd: () => [resolveBin("jdtls")],
		extensions: ["java"],
		languageId: "java",
		rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", ".git"],
		installHint: "brew install jdtls (or download eclipse.jdt.ls and put jdtls on PATH)",
	},
};

/** The server responsible for a file, by extension. */
export function serverForExtension(extension: string): { name: string; spec: ServerSpec } | undefined {
	for (const [name, spec] of Object.entries(SERVERS)) {
		if (spec.enabled === false) continue;
		if (spec.extensions.includes(extension)) return { name, spec };
	}
	return undefined;
}

/** Resolve the languageId for a given extension. */
export function languageIdFor(spec: ServerSpec, extension: string): string {
	return typeof spec.languageId === "function" ? spec.languageId(extension) : spec.languageId;
}
