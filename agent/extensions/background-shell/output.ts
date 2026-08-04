/**
 * A shell's captured output, in memory: a byte ring holding the last
 * `capacity` bytes of stdout+stderr, interleaved as they arrived — the same
 * stream a terminal would have shown.
 *
 * Nothing about a background shell is written to disk. Shells do not survive
 * their session (session_shutdown kills them), so a record that outlives the
 * process is a record nobody reads — it was only ever litter in the agent dir.
 * The cost of that choice is stated where it bites: a pi killed outright
 * leaves an orphaned process group that nothing is left to report.
 *
 * Offsets are absolute positions in the VIRTUAL stream — every byte the shell
 * ever wrote, including the ones since evicted — so the model's bash_output
 * cursor stays "bytes I have already seen" and never has to be rebased.
 * Reading from a cursor whose bytes are gone is not an error: those bytes are
 * counted into `skipped`, exactly like the firehose cap, and the tool tells
 * the model how much it missed.
 */

export interface OutputRead {
	text: string;
	/** Where the next read should start — the stream length at read time. */
	nextOffset: number;
	/** Bytes between the cursor and where reading began: evicted, or skipped by the cap. */
	skipped: number;
	/**
	 * Absolute BYTE offset where the read's final (possibly torn) line begins —
	 * the position just after the last newline, or where reading began when the
	 * whole read is one line. Byte-exact by construction (newline is a single
	 * byte in UTF-8), which is what makes it safe to rewind a cursor to: byte
	 * lengths recomputed from the DECODED text overcount when the read tore a
	 * multibyte character, since the torn bytes decode to a replacement char.
	 */
	lastLineStart: number;
}

export class OutputBuffer {
	/** Retained chunks, oldest first. Their bytes span [base, written). */
	private readonly chunks: Buffer[] = [];
	/** Absolute offset of the first retained byte; everything before it was evicted. */
	private base = 0;
	/** Bytes ever written. Monotonic, so it doubles as a version number. */
	private written = 0;

	constructor(private readonly capacity: number) {}

	/** Total bytes ever written — the end of the cursor space, and the panel's cache key. */
	get size(): number {
		return this.written;
	}

	/** Absolute offset of the oldest byte still held. */
	get oldest(): number {
		return this.base;
	}

	append(chunk: string | Buffer): void {
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf8");
		if (bytes.length === 0) return;
		this.chunks.push(bytes);
		this.written += bytes.length;
		// Drop whole chunks off the front, then slice the one that straddles the
		// boundary — a single chunk larger than the whole ring is trimmed by the
		// same loop rather than being a special case.
		let over = this.written - this.base - this.capacity;
		while (over > 0 && this.chunks.length > 0) {
			const head = this.chunks[0]!;
			if (head.length <= over) {
				this.chunks.shift();
				this.base += head.length;
				over -= head.length;
			} else {
				this.chunks[0] = head.subarray(over);
				this.base += over;
				over = 0;
			}
		}
	}

	/** The retained bytes in `[from, to)`, both absolute. */
	private slice(from: number, to: number): Buffer {
		if (to <= from) return Buffer.alloc(0);
		const parts: Buffer[] = [];
		let position = this.base;
		for (const chunk of this.chunks) {
			const end = position + chunk.length;
			if (end > from && position < to) {
				parts.push(chunk.subarray(Math.max(0, from - position), Math.min(chunk.length, to - position)));
			}
			position = end;
			if (position >= to) break;
		}
		return parts.length === 1 ? parts[0]! : Buffer.concat(parts);
	}

	/**
	 * Read from `offset` to the end, tail-biased: if more than `capBytes`
	 * accumulated since the cursor, skip ahead and read only the last `capBytes`
	 * of it. The end is what you want from a shell, and the skip is reported
	 * rather than silently paged through — a reader that lags a firehose one
	 * page at a time never catches up.
	 *
	 * Byte-range reads can split a multibyte character at either edge; the
	 * replacement character that produces is cosmetic and accepted, as in pi's
	 * own bounded tail reads.
	 */
	read(offset: number, capBytes: number): OutputRead {
		const cursor = Math.min(Math.max(offset, 0), this.written);
		// Never below the oldest surviving byte, never further back than the cap.
		let start = Math.max(cursor, this.base);
		if (this.written - start > capBytes) start = this.written - capBytes;
		if (start >= this.written) {
			return { text: "", nextOffset: this.written, skipped: start - cursor, lastLineStart: this.written };
		}
		const read = this.slice(start, this.written);
		const lastNewline = read.lastIndexOf(0x0a);
		return {
			text: read.toString("utf8"),
			nextOffset: this.written,
			skipped: start - cursor,
			lastLineStart: start + (lastNewline >= 0 ? lastNewline + 1 : 0),
		};
	}

	/**
	 * The last `maxBytes` as sanitized lines, for the panel's detail view and
	 * the exit report. When the window starts mid-stream the torn first line is
	 * dropped — unless it is the only content (one huge line), in which case it
	 * is kept with an ellipsis rather than pretending the shell was silent.
	 */
	tail(maxBytes: number): string[] {
		if (this.written === 0) return [];
		const start = Math.max(this.base, this.written - maxBytes);
		const lines = sanitizeOutput(this.slice(start, this.written).toString("utf8"));
		if (lines.at(-1) === "") lines.pop();
		if (start > 0 && lines.length > 0) {
			if (lines.length > 1) lines.shift();
			else lines[0] = `…${lines[0]}`;
		}
		return lines;
	}
}

/**
 * ANSI escape sequences (CSI, OSC, and lone two-byte forms). Shell output is
 * raw terminal traffic — colour codes, cursor movement, progress-bar erases —
 * and none of it may reach the editor slot, where pi-tui passes it through
 * verbatim and a stray cursor-move corrupts the whole frame.
 */
const ANSI_PATTERN = /[\u001B\u009B](?:\[[0-9;:<=>?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\)?|[@-Z\\-_])/g;

/**
 * Raw shell output → display lines: escapes stripped, a lone CR treated as a
 * line break (progress bars redraw with a carriage return; successive frames become
 * successive lines rather than one line of garbage), remaining control
 * characters dropped (tab survives).
 */
export function sanitizeOutput(text: string): string[] {
	return text
		.replace(ANSI_PATTERN, "")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
		.split(/\r\n|\r|\n/);
}
