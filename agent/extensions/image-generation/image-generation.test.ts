import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import imageGeneration from "./index.ts";

// Run: node --experimental-strip-types --test agent/extensions/image-generation/image-generation.test.ts
// These cases drive the registered tool. Only the external Codex service and pi host are substituted.
const dir = await mkdtemp(join(tmpdir(), "pi-image-generation-"));
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
after(() => rm(dir, { recursive: true, force: true }));
let tool!: ToolDefinition;
imageGeneration({ registerTool: (definition: ToolDefinition) => { tool = definition; } } as ExtensionAPI);
const flare = "gpt-image-2.5-flare";
const sunburst = "gpt-image-2.5-sunburst";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=";
const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.signature`;
const driver = { provider: "openai-codex", id: "gpt-6-astra" };
const ctx = {
	cwd: dir,
	model: driver,
	modelRegistry: {
		isUsingOAuth: () => true,
		find: (_provider: string, id: string) => ({ ...driver, id }),
		getProviderAuth: async () => ({ auth: { apiKey: token } }),
	},
} as unknown as ExtensionContext;

const item = (extra: Record<string, unknown> = {}) => ({ type: "image_generation_call", status: "completed", result: png, ...extra });
const completed = (model?: string, extra: Record<string, unknown> = {}) => ({
	type: "response.completed",
	response: { status: "completed", tools: [{ type: "image_generation", ...(model ? { model } : {}) }], ...extra },
});
function sse(events: unknown[], fragmented = false) {
	const text = events.map((event) => `event: ignored\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n";
	const bytes = new TextEncoder().encode(text);
	let offset = 0;
	return new Response(new ReadableStream({
		pull(controller) {
			if (offset >= bytes.length) { controller.close(); return; }
			const end = Math.min(bytes.length, offset + (fragmented ? 7 : bytes.length));
			controller.enqueue(bytes.slice(offset, end));
			offset = end;
		},
	}), { headers: { "Content-Type": "text/event-stream" } });
}
async function execute(path: string, extra: Record<string, unknown> = {}, context = ctx, signal?: AbortSignal) {
	const result = await tool.execute("test", { prompt: "A blue circle", path, ...extra }, signal, undefined, context);
	return { ...result, details: result.details as { path: string; requestedModel: string; reportedModel: string | null; modelConfirmed: boolean } };
}
function stubFetch(response: () => Response) {
	globalThis.fetch = (async () => response()) as typeof fetch;
}
async function absent(name: string) {
	await assert.rejects(readFile(join(dir, name)), { code: "ENOENT" });
}

test("registers the image tool and its model warning guidance", () => {
	assert.equal(tool.name, "generate_image");
	assert.match(tool.promptGuidelines!.join(" "), /tell the user/);
});

for (const [label, reported, requested, confirmed] of [
	["exact model", flare, flare, true],
	["Codex replacement", "gpt-image-2-codex", flare, false],
	["unreported model", undefined, flare, false],
	["explicit Sunburst", sunburst, sunburst, true],
] as const) {
	test(`saves PNG and reports ${label}`, async () => {
		stubFetch(() => sse([
			{ type: "response.output_item.done", item: item() },
			completed(reported),
		], true));
		const result = await execute(`${label}.png`, requested === flare ? {} : { model: requested });
		assert.deepEqual(await readFile(join(dir, `${label}.png`)), Buffer.from(png, "base64"));
		assert.equal(result.details.requestedModel, requested);
		assert.equal(result.details.reportedModel, reported ?? null);
		assert.equal(result.details.modelConfirmed, confirmed);
		const text = result.content.find((part) => part.type === "text")!;
		assert.match(text.text, /Requested model:/);
		assert.match(text.text, /Codex reported model:/);
		assert.equal(text.text.includes("Warning:"), !confirmed);
		assert.deepEqual(result.content[1], { type: "image", data: png, mimeType: "image/png" });
	});
}

test("sends only the supplied prompt to the official endpoint with Codex OAuth", async () => {
	globalThis.fetch = (async (url, options) => {
		assert.equal(url, "https://chatgpt.com/backend-api/codex/responses");
		assert.equal(options?.redirect, "error");
		const headers = new Headers(options?.headers);
		assert.equal(headers.get("Authorization"), `Bearer ${token}`);
		assert.equal(headers.get("chatgpt-account-id"), "test-account");
		const body = JSON.parse(options?.body as string);
		assert.equal(body.model, driver.id);
		assert.equal(body.tools[0].model, flare);
		assert.equal(body.tool_choice, "required");
		assert.equal(body.store, false);
		assert.equal(body.stream, true);
		assert.deepEqual(body.input, [{ role: "user", content: [{ type: "input_text", text: "A blue circle" }] }]);
		return sse([completed(flare, { output: [item()] })]);
	}) as typeof fetch;
	const result = await execute("@nested/request.png");
	assert.equal(result.details.path, join(dir, "nested/request.png"));
});

test("uses the image item's model before tool metadata", async () => {
	stubFetch(() => sse([completed(flare, { output: [item({ model: "gpt-image-2-codex" })] })]));
	const result = await execute("item-model.png");
	assert.equal(result.details.reportedModel, "gpt-image-2-codex");
	assert.equal(result.details.modelConfirmed, false);
});

test("uses the Codex driver without switching a non-Codex session", async () => {
	stubFetch(() => sse([completed(flare, { output: [item()] })]));
	const context = { ...ctx, model: { ...driver, provider: "anthropic" } } as ExtensionContext;
	const result = await execute("other-provider.png", {}, context);
	assert.equal(result.details.requestedModel, flare);
	assert.equal(context.model!.provider, "anthropic");
});

for (const [name, events, message] of [
	["missing-image", [completed(flare)], /without an image/],
	["truncated", [{ type: "response.output_item.done", item: item() }], /before completion/],
	["failed", [{ type: "response.failed" }], /generation failed/],
	["incomplete", [{ type: "response.incomplete" }], /generation failed/],
	["invalid-image", [completed(flare, { output: [item({ result: "not an image" })] })], /valid PNG/],
] as const) {
	test(`does not save ${name} output`, async () => {
		stubFetch(() => sse([...events]));
		await assert.rejects(execute(`${name}.png`), message);
		await absent(`${name}.png`);
	});
}

for (const status of [401, 403, 429, 500]) {
	test(`HTTP ${status} is an error without exposing its body`, async () => {
		stubFetch(() => new Response(`secret: ${token}`, { status }));
		await assert.rejects(execute(`http-${status}.png`), (error: Error) => {
			assert.match(error.message, new RegExp(`HTTP ${status}`));
			assert.ok(!error.message.includes(token));
			return true;
		});
		await absent(`http-${status}.png`);
	});
}

test("rejects missing login, cancellation, and invalid inputs before a request", async () => {
	globalThis.fetch = (async () => { throw new Error("Unexpected request"); }) as typeof fetch;
	const loggedOut = { ...ctx, modelRegistry: { ...ctx.modelRegistry, isUsingOAuth: () => false } } as unknown as ExtensionContext;
	await assert.rejects(execute("login.png", {}, loggedOut), /\/login openai-codex/);
	await assert.rejects(execute("empty.png", { prompt: " " }), /prompt is required/);
	await assert.rejects(execute("wrong.jpg"), /must end in .png/);
	await assert.rejects(execute("unknown.png", { model: "unknown" }), /Choose gpt-image/);
	await assert.rejects(execute("aborted.png", {}, ctx, AbortSignal.abort()), { name: "AbortError" });
	await absent("aborted.png");
});

test("never overwrites existing files or follows output symlinks", async () => {
	globalThis.fetch = (async () => { throw new Error("Unexpected request"); }) as typeof fetch;
	await writeFile(join(dir, "existing.png"), "keep me");
	await symlink(join(dir, "existing.png"), join(dir, "link.png"));
	await symlink(join(dir, "missing.png"), join(dir, "dangling.png"));
	for (const path of ["existing.png", "link.png", "dangling.png"]) {
		await assert.rejects(execute(path), /File already exists/);
	}
	assert.equal(await readFile(join(dir, "existing.png"), "utf8"), "keep me");
});
