/**
 * LSP base protocol framing over stdio.
 *
 * Every message is `Content-Length: <bytes>\r\n\r\n<json>`. The length counts BYTES, not
 * characters, so anything non-ASCII (a diagnostic quoting a symbol, say) will desync a
 * naive character-based reader. Buffers are used throughout for that reason.
 *
 * Pure and dependency-free, so it is directly testable without spawning a server.
 */

export type JsonRpcMessage = {
	jsonrpc: "2.0";
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string; data?: unknown };
};

/** Frame a message for the wire. */
export function encodeMessage(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
	return Buffer.concat([header, body]);
}

/**
 * Incremental decoder. Servers write whenever they please, so a single chunk may hold
 * half a message, several messages, or a header split across chunks.
 */
export function createMessageReader() {
	// Typed loosely on purpose: Buffer.concat returns Buffer<ArrayBufferLike>, which does
	// not assign to the stricter Buffer<ArrayBuffer> that Buffer.alloc infers.
	let buffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);

	return {
		/** Feed raw stdout bytes; returns every complete message now available. */
		push(chunk: Buffer): JsonRpcMessage[] {
			buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
			const messages: JsonRpcMessage[] = [];

			while (true) {
				const headerEnd = buffer.indexOf("\r\n\r\n");
				if (headerEnd === -1) break;

				const header = buffer.subarray(0, headerEnd).toString("ascii");
				const match = /content-length:\s*(\d+)/i.exec(header);
				if (!match) {
					// Unparseable header: drop it rather than spin forever on the same bytes.
					buffer = buffer.subarray(headerEnd + 4);
					continue;
				}

				const length = Number(match[1]);
				const start = headerEnd + 4;
				if (buffer.length < start + length) break; // body still incomplete

				const body = buffer.subarray(start, start + length).toString("utf8");
				buffer = buffer.subarray(start + length);

				try {
					messages.push(JSON.parse(body) as JsonRpcMessage);
				} catch {
					// A malformed body must not kill the session; skip it.
				}
			}

			return messages;
		},

		/** Bytes still held awaiting a complete message. Exposed for tests. */
		pending(): number {
			return buffer.length;
		},
	};
}

/** Convert a filesystem path to a file:// URI, percent-encoding as LSP requires. */
export function pathToUri(path: string): string {
	const encoded = path
		.split("/")
		.map((segment) => encodeURIComponent(segment))
		.join("/");
	return `file://${encoded}`;
}

/** Inverse of pathToUri. */
export function uriToPath(uri: string): string {
	const withoutScheme = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
	return decodeURIComponent(withoutScheme);
}
