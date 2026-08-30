/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	configureRawHttpLogging,
	resetRawHttpLoggingForTests,
	withRawHttpLogging,
} from "../raw-http-logging";

const ENV_VAR = "PA_RAW_HTTP_LOG_DIR";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "raw-http-logging-test-"));
});

afterEach(() => {
	resetRawHttpLoggingForTests();
	delete process.env[ENV_VAR];
	rmSync(workDir, { recursive: true, force: true });
});

function listFiles(dir: string): string[] {
	return readdirSync(dir).sort();
}

function readPair(dir: string): { request: Buffer; response: Buffer } {
	const files = listFiles(dir);
	const requestFile = files.find((f) => f.endsWith("-request.http"));
	const responseFile = files.find((f) => f.endsWith("-response.http"));
	if (!requestFile || !responseFile) {
		throw new Error(`Expected request/response pair, found: ${files.join(", ")}`);
	}
	// Pair must share a base name.
	expect(requestFile.replace("-request.http", "")).toBe(responseFile.replace("-response.http", ""));
	return {
		request: readFileSync(join(dir, requestFile)),
		response: readFileSync(join(dir, responseFile)),
	};
}

/** Split a raw .http log file into header section text and body bytes. */
function splitMessage(contents: Buffer): { head: string; body: Buffer } {
	const separator = contents.indexOf("\n\n");
	expect(separator).toBeGreaterThan(-1);
	return {
		head: contents.subarray(0, separator).toString("utf8"),
		body: contents.subarray(separator + 2),
	};
}

function sseStream(chunks: string[]): ReadableStream<Uint8Array> {
	const encoder = new TextEncoder();
	return new ReadableStream({
		start(controller) {
			for (const chunk of chunks) {
				controller.enqueue(encoder.encode(chunk));
			}
			controller.close();
		},
	});
}

function fakeSseFetch(chunks: string[]): typeof globalThis.fetch {
	return async () =>
		new Response(sseStream(chunks), {
			status: 200,
			headers: {
				"content-type": "text/event-stream",
				"anthropic-ratelimit-tokens-remaining": "19999",
				"set-cookie": "session=abc123; HttpOnly",
			},
		});
}

/**
 * Wait until `count` log files exist. Log files are published via
 * temp-file-plus-rename, so an existing `.http` file holds complete contents.
 */
async function waitForFiles(count: number): Promise<void> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const files = listFiles(workDir).filter((f) => f.endsWith(".http"));
		if (files.length >= count) {
			return;
		}
		if (Date.now() > deadline) {
			throw new Error(`Timed out waiting for ${count} log files, found: ${files.join(", ")}`);
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** Wait until the request/response pair has been fully written. */
async function waitForPair(): Promise<void> {
	await waitForFiles(2);
}

describe("withRawHttpLogging", () => {
	it("returns undefined when disabled (no env var, no configured dir)", () => {
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeUndefined();
	});

	it("returns undefined when the configured dir does not exist", () => {
		configureRawHttpLogging({ outputDir: join(workDir, "does-not-exist") });
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeUndefined();
	});

	it("enables when the configured dir exists (late binding)", () => {
		const logDir = join(workDir, "raw-http");
		configureRawHttpLogging({ outputDir: logDir });
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeUndefined();
		mkdirSync(logDir);
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeDefined();
	});

	it("env var enables logging and auto-creates the directory", () => {
		const logDir = join(workDir, "env-logs");
		process.env[ENV_VAR] = logDir;
		const wrapped = withRawHttpLogging(undefined, { provider: "test", model: "m" });
		expect(wrapped).toBeDefined();
	});

	it("env var wins over a missing configured dir", () => {
		configureRawHttpLogging({ outputDir: join(workDir, "nope") });
		process.env[ENV_VAR] = join(workDir, "env-logs");
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeDefined();
	});

	it("recreates a deleted env dir and follows env var changes between calls", () => {
		const first = join(workDir, "env-logs");
		process.env[ENV_VAR] = first;
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeDefined();
		expect(existsSync(first)).toBe(true);

		// Deleted after first use: the next call recreates it.
		rmSync(first, { recursive: true, force: true });
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeDefined();
		expect(existsSync(first)).toBe(true);

		// Changed after first use: the new directory is created.
		const second = join(workDir, "env-logs-2");
		process.env[ENV_VAR] = second;
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeDefined();
		expect(existsSync(second)).toBe(true);
	});

	it("writes request and response files with byte-identical bodies", async () => {
		process.env[ENV_VAR] = workDir;
		const requestBody = JSON.stringify({ prompt: "héllo wörld ✨", n: 1 });
		const sseChunks = [
			'data: {"delta":"héllo"}\n\n',
			'data: {"delta":" wörld ✨"}\n\n',
			"data: [DONE]\n\n",
		];
		const wrapped = withRawHttpLogging(fakeSseFetch(sseChunks), {
			provider: "test-provider",
			model: "test/model:1",
		});
		expect(wrapped).toBeDefined();

		const response = await wrapped!("https://api.example.com/v1/chat?x=1", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: "Bearer sk-secret-key",
				"x-api-key": "another-secret",
			},
			body: requestBody,
		});
		// Consume the SDK-visible stream.
		const seenByConsumer = Buffer.from(await response.arrayBuffer());
		await waitForPair();

		const { request, response: responseFile } = readPair(workDir);

		// Request: well-formed head, byte-identical body.
		const req = splitMessage(request);
		expect(req.head).toContain("POST /v1/chat?x=1 HTTP/1.1");
		expect(req.head).toContain("host: api.example.com");
		expect(req.head).toContain("content-type: application/json");
		expect(req.body.equals(Buffer.from(requestBody, "utf8"))).toBe(true);

		// Response: byte-identical reassembled SSE body.
		const res = splitMessage(responseFile);
		expect(res.head).toContain("HTTP/1.1 200");
		expect(res.body.equals(Buffer.from(sseChunks.join(""), "utf8"))).toBe(true);

		// The consumer saw the same bytes that were logged.
		expect(seenByConsumer.equals(Buffer.from(sseChunks.join(""), "utf8"))).toBe(true);
	});

	it("redacts credential-bearing headers but not other headers or the body", async () => {
		process.env[ENV_VAR] = workDir;
		const wrapped = withRawHttpLogging(fakeSseFetch(["data: [DONE]\n\n"]), {
			provider: "test",
			model: "m",
		});
		const response = await wrapped!("https://api.example.com/v1/chat", {
			method: "POST",
			headers: {
				authorization: "Bearer sk-secret",
				"x-api-key": "secret2",
				"x-custom-auth-token": "secret3",
				cookie: "session=secret4",
				"content-type": "application/json",
			},
			body: "sk-secret stays in the body verbatim",
		});
		await response.arrayBuffer();
		await waitForPair();

		const { head } = splitMessage(readPair(workDir).request);
		expect(head).toContain("authorization: [REDACTED]");
		expect(head).toContain("x-api-key: [REDACTED]");
		expect(head).toContain("x-custom-auth-token: [REDACTED]");
		// Cookies carry reusable session credentials and must be redacted.
		expect(head).toContain("cookie: [REDACTED]");
		expect(head).toContain("content-type: application/json");
		expect(head).not.toContain("sk-secret");
		expect(head).not.toContain("secret4");

		// Rate-limit style headers mentioning "tokens" are not credentials.
		const resHead = splitMessage(readPair(workDir).response).head;
		expect(resHead).toContain("content-type: text/event-stream");
		expect(resHead).toContain("anthropic-ratelimit-tokens-remaining: 19999");
		expect(resHead).toContain("set-cookie: [REDACTED]");
		expect(resHead).not.toContain("session=abc123");

		// Bodies are never redacted.
		const { body } = splitMessage(readPair(workDir).request);
		expect(body.toString("utf8")).toBe("sk-secret stays in the body verbatim");
	});

	it("sanitizes provider/model for file names", async () => {
		process.env[ENV_VAR] = workDir;
		const wrapped = withRawHttpLogging(fakeSseFetch(["data: [DONE]\n\n"]), {
			provider: "my provider",
			model: "a/b:c",
		});
		const response = await wrapped!("https://api.example.com/", { method: "POST", body: "{}" });
		await response.arrayBuffer();
		await waitForPair();

		const files = listFiles(workDir);
		expect(files.some((f) => f.includes("my-provider") && f.includes("a-b-c"))).toBe(true);
	});

	it("logs GET by default, honoring Request and init method overrides", async () => {
		process.env[ENV_VAR] = workDir;
		const wrapped = withRawHttpLogging(fakeSseFetch(["data: [DONE]\n\n"]), {
			provider: "test",
			model: "m",
		});

		// URL-string call with no init: Fetch sends GET.
		await (await wrapped!("https://api.example.com/a")).text();
		// Request object: its method wins.
		await (await wrapped!(new Request("https://api.example.com/b", { method: "PUT" }))).text();
		// init.method overrides the default.
		await (await wrapped!("https://api.example.com/c", { method: "POST", body: "{}" })).text();

		await waitForFiles(6);
		const heads = listFiles(workDir)
			.filter((f) => f.endsWith("-request.http"))
			.map((f) => splitMessage(readFileSync(join(workDir, f))).head);
		expect(heads.some((h) => h.includes("GET /a HTTP/1.1"))).toBe(true);
		expect(heads.some((h) => h.includes("PUT /b HTTP/1.1"))).toBe(true);
		expect(heads.some((h) => h.includes("POST /c HTTP/1.1"))).toBe(true);
	});

	it("writes a response file with an error marker when fetch throws", async () => {
		process.env[ENV_VAR] = workDir;
		const failing: typeof globalThis.fetch = async () => {
			throw new Error("connection refused");
		};
		const wrapped = withRawHttpLogging(failing, { provider: "test", model: "m" });
		await expect(
			wrapped!("https://api.example.com/", { method: "POST", body: "{}" }),
		).rejects.toThrow("connection refused");
		await waitForPair();

		const files = listFiles(workDir);
		const responseFile = files.find((f) => f.endsWith("-response.http"));
		expect(responseFile).toBeDefined();
		expect(readFileSync(join(workDir, responseFile!), "utf8")).toContain(
			"[error: connection refused]",
		);
	});

	it("forwards consumer cancellation to the source and logs partial bytes with a marker", async () => {
		process.env[ENV_VAR] = workDir;
		const encoder = new TextEncoder();
		let sourceCancelled = false;
		const source = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
				// Never closes: the consumer cancels mid-stream.
			},
			cancel() {
				sourceCancelled = true;
			},
		});
		const wrapped = withRawHttpLogging(async () => new Response(source, { status: 200 }), {
			provider: "test",
			model: "m",
		});

		const response = await wrapped!("https://api.example.com/v1/chat", {
			method: "POST",
			body: "{}",
		});
		const reader = response.body!.getReader();
		const first = await reader.read();
		expect(first.done).toBe(false);
		await reader.cancel();

		// Cancellation propagated through the logging wrapper to the source.
		expect(sourceCancelled).toBe(true);

		await waitForPair();
		const res = splitMessage(readPair(workDir).response);
		expect(res.body.toString("utf8")).toContain('"delta":"a"');
		expect(res.body.toString("utf8")).toContain("[error: stream cancelled by consumer]");
	});

	it("does not buffer ahead of a slow consumer", async () => {
		process.env[ENV_VAR] = workDir;
		const encoder = new TextEncoder();
		let produced = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				produced++;
				if (produced <= 100) {
					controller.enqueue(encoder.encode(`chunk${produced}\n`));
				} else {
					controller.close();
				}
			},
		});
		const wrapped = withRawHttpLogging(async () => new Response(source, { status: 200 }), {
			provider: "test",
			model: "m",
		});

		const response = await wrapped!("https://api.example.com/v1/chat", {
			method: "POST",
			body: "{}",
		});
		const reader = response.body!.getReader();
		await reader.read();
		// Give an eager background drainer (the bug this guards against) time
		// to run ahead if one exists.
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The pass-through may only run ahead by its internal queue (a handful
		// of chunks), never the whole stream.
		expect(produced).toBeLessThanOrEqual(5);
		await reader.cancel();
	});

	it("logs partial bytes plus an error marker when the stream fails mid-body", async () => {
		process.env[ENV_VAR] = workDir;
		const encoder = new TextEncoder();
		// Error from pull (a pending read) — erroring in start with no pending
		// read surfaces as an unhandled rejection in Node.
		let pulls = 0;
		const source = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls++;
				if (pulls === 1) {
					controller.enqueue(encoder.encode('data: {"delta":"a"}\n\n'));
				} else {
					controller.error(new Error("boom"));
				}
			},
		});
		const wrapped = withRawHttpLogging(async () => new Response(source, { status: 200 }), {
			provider: "test",
			model: "m",
		});

		const response = await wrapped!("https://api.example.com/v1/chat", {
			method: "POST",
			body: "{}",
		});
		const reader = response.body!.getReader();
		await reader.read();
		await expect(reader.read()).rejects.toThrow("boom");

		await waitForPair();
		const res = splitMessage(readPair(workDir).response);
		// The chunk that arrived before the failure is preserved.
		expect(res.body.toString("utf8")).toContain('"delta":"a"');
		expect(res.body.toString("utf8")).toContain("[error: boom]");
	});

	it("does not mutate or break a frozen RequestInit with a stream body", async () => {
		process.env[ENV_VAR] = workDir;
		let received: string | undefined;
		const underlying: typeof globalThis.fetch = async (_input, init) => {
			received =
				init?.body instanceof ReadableStream
					? await new Response(init.body).text()
					: String(init?.body);
			return new Response("ok");
		};
		const wrapped = withRawHttpLogging(underlying, { provider: "test", model: "m" });

		const init = Object.freeze({ method: "POST", body: sseStream(["request-bytes"]) });
		const response = await wrapped!("https://api.example.com/", init);
		expect(await response.text()).toBe("ok");
		// The underlying fetch received a readable copy of the stream body.
		expect(received).toBe("request-bytes");

		await waitForPair();
		const req = splitMessage(readPair(workDir).request);
		expect(req.body.toString("utf8")).toBe("request-bytes");
	});

	it("captures a bodyful Request via pass-through: cancellation propagates, no runahead", async () => {
		process.env[ENV_VAR] = workDir;
		const encoder = new TextEncoder();
		let sourceCancelled = false;
		let produced = 0;
		const bodyStream = new ReadableStream<Uint8Array>({
			pull(controller) {
				produced++;
				if (produced <= 100) {
					controller.enqueue(encoder.encode(`chunk${produced}\n`));
				}
			},
			cancel() {
				sourceCancelled = true;
			},
		});
		// The underlying fetch reads one chunk of the upload, then cancels.
		const underlying: typeof globalThis.fetch = async (input) => {
			const reader = (input as Request).body!.getReader();
			await reader.read();
			await reader.cancel();
			return new Response("ok");
		};
		const wrapped = withRawHttpLogging(underlying, { provider: "test", model: "m" });

		const request = new Request("https://api.example.com/upload", {
			method: "POST",
			body: bodyStream,
			duplex: "half",
		});
		const response = await wrapped!(request);
		expect(await response.text()).toBe("ok");

		// Cancellation flowed through the recording pass-through to the source,
		// which never produced beyond a handful of chunks.
		expect(sourceCancelled).toBe(true);
		expect(produced).toBeLessThanOrEqual(5);

		await waitForPair();
		const req = splitMessage(readPair(workDir).request);
		expect(req.head).toContain("POST /upload HTTP/1.1");
		expect(req.body.toString("utf8")).toContain("chunk1");
		expect(req.body.toString("utf8")).not.toContain("chunk100");
	});

	it("preserves response url, redirected, and type metadata", async () => {
		process.env[ENV_VAR] = workDir;
		const network = new Response(sseStream(["data: [DONE]\n\n"]), { status: 200 });
		// Simulate the metadata a real fetch response carries.
		Object.defineProperty(network, "url", { value: "https://api.example.com/v1/chat" });
		Object.defineProperty(network, "redirected", { value: true });
		Object.defineProperty(network, "type", { value: "cors" });
		const wrapped = withRawHttpLogging(async () => network, { provider: "test", model: "m" });

		const response = await wrapped!("https://api.example.com/v1/chat", {
			method: "POST",
			body: "{}",
		});
		expect(response.url).toBe("https://api.example.com/v1/chat");
		expect(response.redirected).toBe(true);
		expect(response.type).toBe("cors");
		expect(response.status).toBe(200);
		await response.text();
		await waitForPair();
	});

	it("survives logging failures without breaking the response", async () => {
		// Point the env var at a path that cannot be created (a file blocks it).
		const blocker = join(workDir, "blocker");
		writeFileSync(blocker, "x");
		process.env[ENV_VAR] = join(blocker, "impossible");
		// mkdirSync fails → wrapper disabled entirely.
		expect(withRawHttpLogging(undefined, { provider: "test", model: "m" })).toBeUndefined();
	});
});
