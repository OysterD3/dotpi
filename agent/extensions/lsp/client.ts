/**
 * A single language server process, spoken to over stdio.
 *
 * Lifecycle: spawn -> initialize -> initialized -> [didOpen / collect diagnostics] -> shutdown.
 *
 * Diagnostics are push-based in LSP: the server sends `textDocument/publishDiagnostics`
 * whenever it feels like it, with no request to correlate against. So collection is
 * "open the file, then wait until it goes quiet", not "call a method and read the reply".
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { CONFIG } from "./config.ts";
import { createMessageReader, encodeMessage, pathToUri, type JsonRpcMessage } from "./protocol.ts";
import { languageIdFor, type ServerSpec } from "./servers.ts";

export type Diagnostic = {
	range: { start: { line: number; character: number }; end: { line: number; character: number } };
	severity?: 1 | 2 | 3 | 4;
	code?: string | number;
	source?: string;
	message: string;
};

export class LspClient {
	private process: ChildProcessWithoutNullStreams | undefined;
	private reader = createMessageReader();
	private nextId = 1;
	private pending = new Map<number | string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	private diagnostics = new Map<string, Diagnostic[]>();
	private diagnosticListeners = new Set<(uri: string) => void>();
	private openDocuments = new Set<string>();
	private startError: Error | undefined;
	private ready: Promise<void> | undefined;

	lastUsed = Date.now();

	constructor(
		readonly serverName: string,
		private readonly spec: ServerSpec,
		readonly root: string,
	) {}

	/** Spawn and initialize once; subsequent calls await the same promise. */
	start(): Promise<void> {
		if (!this.ready) this.ready = this.doStart();
		return this.ready;
	}

	private async doStart(): Promise<void> {
		const argv = this.spec.cmd();
		const [command, ...args] = argv;
		if (!command) throw new Error(`${this.serverName}: empty command`);

		try {
			this.process = spawn(command, args, {
				cwd: this.root,
				stdio: ["pipe", "pipe", "pipe"],
				env: process.env,
			});
		} catch (error) {
			throw this.spawnFailure(error);
		}

		this.process.on("error", (error) => {
			this.startError = this.spawnFailure(error);
			for (const { reject } of this.pending.values()) reject(this.startError);
			this.pending.clear();
		});

		this.process.stdout.on("data", (chunk: Buffer) => {
			for (const message of this.reader.push(chunk)) this.handle(message);
		});

		if (CONFIG.debug) {
			this.process.stderr.on("data", (chunk: Buffer) => {
				process.stderr.write(`[${this.serverName}] ${chunk.toString("utf8")}`);
			});
		} else {
			// Drain stderr regardless; a full pipe buffer will deadlock the child.
			this.process.stderr.resume();
		}

		const result = (await this.request(
			"initialize",
			{
				processId: process.pid,
				rootUri: pathToUri(this.root),
				workspaceFolders: [{ uri: pathToUri(this.root), name: this.root.split("/").pop() ?? "root" }],
				capabilities: {
					textDocument: {
						synchronization: { dynamicRegistration: false, didSave: true },
						publishDiagnostics: { relatedInformation: true, versionSupport: false },
					},
					workspace: { configuration: true, workspaceFolders: true, didChangeConfiguration: {} },
				},
				...(this.spec.initializationOptions !== undefined
					? { initializationOptions: this.spec.initializationOptions }
					: {}),
			},
			CONFIG.initializeTimeoutMs,
		)) as { capabilities?: unknown };

		void result;
		this.notify("initialized", {});

		if (this.spec.settings !== undefined) {
			this.notify("workspace/didChangeConfiguration", { settings: this.spec.settings });
		}
	}

	private spawnFailure(error: unknown): Error {
		const reason = error instanceof Error ? error.message : String(error);
		const hint = this.spec.installHint ? ` Install it with: ${this.spec.installHint}` : "";
		return new Error(`Could not start ${this.serverName} (${reason}).${hint}`);
	}

	private handle(message: JsonRpcMessage): void {
		// Response to something we sent.
		if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
			const entry = this.pending.get(message.id);
			if (!entry) return;
			this.pending.delete(message.id);
			if (message.error) entry.reject(new Error(message.error.message));
			else entry.resolve(message.result);
			return;
		}

		// Server-to-client request. Answering the common ones keeps servers from stalling.
		if (message.id !== undefined && message.method) {
			if (message.method === "workspace/configuration") {
				const items = (message.params as { items?: unknown[] } | undefined)?.items ?? [];
				this.respond(
					message.id,
					items.map(() => this.spec.settings ?? {}),
				);
			} else if (message.method === "client/registerCapability" || message.method === "client/unregisterCapability") {
				this.respond(message.id, null);
			} else if (message.method === "workspace/workspaceFolders") {
				this.respond(message.id, [{ uri: pathToUri(this.root), name: "root" }]);
			} else {
				// Unknown request: reply with an error so the server doesn't wait forever.
				this.respondError(message.id, -32601, `Unhandled request: ${message.method}`);
			}
			return;
		}

		// Notification.
		if (message.method === "textDocument/publishDiagnostics") {
			const params = message.params as { uri?: string; diagnostics?: Diagnostic[] } | undefined;
			if (params?.uri) {
				this.diagnostics.set(params.uri, params.diagnostics ?? []);
				for (const listener of this.diagnosticListeners) listener(params.uri);
			}
		}
	}

	private send(payload: unknown): void {
		if (!this.process?.stdin.writable) return;
		this.process.stdin.write(encodeMessage(payload));
	}

	private respond(id: number | string, result: unknown): void {
		this.send({ jsonrpc: "2.0", id, result });
	}

	private respondError(id: number | string, code: number, message: string): void {
		this.send({ jsonrpc: "2.0", id, error: { code, message } });
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	request(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		if (this.startError) return Promise.reject(this.startError);
		const id = this.nextId++;

		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`${this.serverName}: ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);

			this.pending.set(id, {
				resolve: (value) => {
					clearTimeout(timer);
					resolve(value);
				},
				reject: (error) => {
					clearTimeout(timer);
					reject(error);
				},
			});

			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	/**
	 * Open a file and wait for its diagnostics.
	 *
	 * Returns as soon as the server has published and then gone quiet for `settleMs`,
	 * because servers routinely publish an empty batch before analysis finishes. If
	 * nothing ever arrives, resolves empty at the timeout — a clean file is
	 * indistinguishable from a silent one, and blocking forever is not an option.
	 */
	async diagnosticsFor(path: string, extension: string): Promise<Diagnostic[]> {
		await this.start();
		this.lastUsed = Date.now();

		const uri = pathToUri(path);
		const text = readFileSync(path, "utf8");

		if (this.openDocuments.has(uri)) {
			// Already open: re-sync so edits since the last call are reflected.
			this.notify("textDocument/didChange", {
				textDocument: { uri, version: Date.now() },
				contentChanges: [{ text }],
			});
		} else {
			this.openDocuments.add(uri);
			this.notify("textDocument/didOpen", {
				textDocument: {
					uri,
					languageId: languageIdFor(this.spec, extension),
					version: 1,
					text,
				},
			});
		}

		return await this.waitForDiagnostics(uri);
	}

	private waitForDiagnostics(uri: string): Promise<Diagnostic[]> {
		return new Promise((resolve) => {
			let settleTimer: NodeJS.Timeout | undefined;

			const finish = () => {
				clearTimeout(overallTimer);
				if (settleTimer) clearTimeout(settleTimer);
				this.diagnosticListeners.delete(listener);
				resolve(this.diagnostics.get(uri) ?? []);
			};

			const overallTimer = setTimeout(finish, CONFIG.diagnosticsTimeoutMs);

			const listener = (published: string) => {
				if (published !== uri) return;
				// Restart the settle window on every publish, so a late batch replaces an
				// early empty one.
				if (settleTimer) clearTimeout(settleTimer);
				settleTimer = setTimeout(finish, CONFIG.settleMs);
			};

			this.diagnosticListeners.add(listener);

			// A previous call may already have diagnostics cached for this URI.
			if (this.diagnostics.has(uri)) listener(uri);
		});
	}

	async dispose(): Promise<void> {
		if (!this.process) return;
		try {
			await this.request("shutdown", null, 2000).catch(() => {});
			this.notify("exit", null);
		} catch {
			// Best effort; we kill below regardless.
		}
		this.process.kill();
		this.process = undefined;
	}
}
