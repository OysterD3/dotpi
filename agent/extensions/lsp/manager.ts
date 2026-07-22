/**
 * Picks the right server for a file, finds its project root, and keeps one client alive
 * per (server, root) pair.
 *
 * Reuse matters: tsserver and gopls take seconds to load a project, so spawning per call
 * would make the tool unusable. Idle servers are reaped so they don't sit on memory
 * forever.
 */

import { existsSync } from "node:fs";
import { dirname, extname, isAbsolute, resolve, sep } from "node:path";
import { LspClient, type Diagnostic } from "./client.ts";
import { CONFIG } from "./config.ts";
import { serverForExtension, type ServerSpec } from "./servers.ts";

export type FileDiagnostics = {
	path: string;
	server?: string;
	diagnostics: Diagnostic[];
	error?: string;
};

/**
 * Nearest ancestor containing a root marker, else the file's own directory.
 * Walks upward so a monorepo package resolves to the package, not the repo root.
 */
export function findRoot(filePath: string, markers: string[]): string {
	let dir = dirname(resolve(filePath));
	const seen = new Set<string>();

	while (!seen.has(dir)) {
		seen.add(dir);
		for (const marker of markers) {
			if (existsSync(`${dir}${sep}${marker}`)) return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}

	return dirname(resolve(filePath));
}

export class LspManager {
	private clients = new Map<string, LspClient>();
	private reaper: NodeJS.Timeout | undefined;

	private ensureReaper(): void {
		if (this.reaper) return;
		this.reaper = setInterval(() => {
			const cutoff = Date.now() - CONFIG.idleShutdownMs;
			for (const [key, client] of this.clients) {
				if (client.lastUsed < cutoff) {
					this.clients.delete(key);
					void client.dispose();
				}
			}
		}, 60_000);
		// Don't hold the process open just to reap idle servers.
		this.reaper.unref?.();
	}

	private clientFor(name: string, spec: ServerSpec, root: string): LspClient {
		const key = `${name}::${root}`;
		let client = this.clients.get(key);
		if (!client) {
			client = new LspClient(name, spec, root);
			this.clients.set(key, client);
			this.ensureReaper();
		}
		return client;
	}

	/** Diagnostics for one file. Never throws — failures land in the `error` field. */
	async diagnose(filePath: string): Promise<FileDiagnostics> {
		const absolute = isAbsolute(filePath) ? filePath : resolve(filePath);

		if (!existsSync(absolute)) {
			return { path: filePath, diagnostics: [], error: "File not found" };
		}

		const extension = extname(absolute).replace(/^\./, "").toLowerCase();
		const match = serverForExtension(extension);
		if (!match) {
			return {
				path: absolute,
				diagnostics: [],
				error: `No language server configured for .${extension} files`,
			};
		}

		const root = findRoot(absolute, match.spec.rootMarkers);

		try {
			const client = this.clientFor(match.name, match.spec, root);
			const diagnostics = await client.diagnosticsFor(absolute, extension);
			return { path: absolute, server: match.name, diagnostics };
		} catch (error) {
			return {
				path: absolute,
				server: match.name,
				diagnostics: [],
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	async disposeAll(): Promise<void> {
		if (this.reaper) clearInterval(this.reaper);
		this.reaper = undefined;
		const clients = [...this.clients.values()];
		this.clients.clear();
		await Promise.all(clients.map((client) => client.dispose()));
	}
}
