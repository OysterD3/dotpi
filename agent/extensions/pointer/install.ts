/**
 * `/pointer install` — tell every Chromium browser on this machine where the
 * host is and which extension may talk to it.
 *
 * A native messaging host is found through a per-browser, per-user manifest
 * file, and that manifest names the one extension id allowed to connect. The
 * id is derived from the public key pinned in the extension's own manifest,
 * so it is the same on every machine that loads this directory unpacked —
 * which is what lets the host manifest be written before Chrome has seen the
 * extension at all.
 *
 * The host itself is a shell wrapper with two absolute paths: the node that
 * runs pi, and host.ts. Chrome launches it with a minimal environment, so a
 * `#!/usr/bin/env node` would look for node on a PATH that does not have it —
 * and the agent directory this session uses has to travel the same way, or
 * a pi under PI_CODING_AGENT_DIR would be looked for in ~/.pi/agent.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { HOST_NAME } from "./config.ts";

/** Chrome's rule: the first 128 bits of SHA-256 over the DER public key, hex digits shifted to a–p. */
export function extensionId(keyBase64: string): string {
	const hex = createHash("sha256").update(Buffer.from(keyBase64, "base64")).digest("hex").slice(0, 32);
	return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

function browserDirs(): string[] {
	if (platform() === "darwin") {
		const base = join(homedir(), "Library", "Application Support");
		return ["Google/Chrome", "Google/Chrome Beta", "Google/Chrome Canary", "Chromium", "BraveSoftware/Brave-Browser", "Microsoft Edge", "Arc/User Data", "Vivaldi"].map(
			(dir) => join(base, dir),
		);
	}
	if (platform() === "linux") {
		const base = join(homedir(), ".config");
		return ["google-chrome", "google-chrome-beta", "chromium", "BraveSoftware/Brave-Browser", "microsoft-edge", "vivaldi"].map((dir) => join(base, dir));
	}
	throw new Error("pointer install writes Chrome's native host manifest for macOS and Linux only; Windows needs a registry key.");
}

export type Installed = { id: string; hostScript: string; manifests: string[] };

export function install(agentDir: string, opts: { node?: string; browserDirs?: string[] } = {}): Installed {
	const here = join(agentDir, "extensions", "pointer");
	const key = (JSON.parse(readFileSync(join(here, "chrome", "manifest.json"), "utf8")) as { key: string }).key;
	const id = extensionId(key);

	const hostScript = join(agentDir, "pointer", "host");
	mkdirSync(dirname(hostScript), { recursive: true });
	writeFileSync(hostScript, `#!/bin/sh\nPI_CODING_AGENT_DIR="${agentDir}" exec "${opts.node ?? process.execPath}" "${join(here, "host.ts")}"\n`);
	chmodSync(hostScript, 0o755);

	const manifest = {
		name: HOST_NAME,
		description: "pi pointer — points a pi session at elements on the page",
		path: hostScript,
		type: "stdio",
		allowed_origins: [`chrome-extension://${id}/`],
	};
	const manifests: string[] = [];
	// Only browsers that exist: a manifest in a directory Chrome would create
	// on first launch is harmless, but it would also claim an install that
	// never happened.
	for (const dir of opts.browserDirs ?? browserDirs()) {
		if (!existsSync(dir)) continue;
		const target = join(dir, "NativeMessagingHosts");
		mkdirSync(target, { recursive: true });
		const file = join(target, `${HOST_NAME}.json`);
		writeFileSync(file, `${JSON.stringify(manifest, null, "\t")}\n`);
		manifests.push(file);
	}
	return { id, hostScript, manifests };
}
