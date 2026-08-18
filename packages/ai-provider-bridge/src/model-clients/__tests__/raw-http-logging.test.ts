/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
			},
		});
}

async function settle(): Promise<void> {
	// Allow background file writes to complete.
	for (let i = 0; i < 50; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
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
		await settle();

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
				"content-type": "application/json",
			},
			body: "sk-secret stays in the body verbatim",
		});
		await response.arrayBuffer();
		await settle();

		const { head } = splitMessage(readPair(workDir).request);
		expect(head).toContain("authorization: [REDACTED]");
		expect(head).toContain("x-api-key: [REDACTED]");
		expect(head).toContain("x-custom-auth-token: [REDACTED]");
		expect(head).toContain("content-type: application/json");
		expect(head).not.toContain("sk-secret");

		// Rate-limit style headers mentioning "tokens" are not credentials.
		const resHead = splitMessage(readPair(workDir).response).head;
		expect(resHead).toContain("content-type: text/event-stream");
		expect(resHead).toContain("anthropic-ratelimit-tokens-remaining: 19999");

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
		await settle();

		const files = listFiles(workDir);
		expect(files.some((f) => f.includes("my-provider") && f.includes("a-b-c"))).toBe(true);
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
		await settle();

		const files = listFiles(workDir);
		const responseFile = files.find((f) => f.endsWith("-response.http"));
		expect(responseFile).toBeDefined();
		expect(readFileSync(join(workDir, responseFile!), "utf8")).toContain(
			"[error: connection refused]",
		);
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
