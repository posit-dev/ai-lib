/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire regression for `{env:NAME}` references in custom headers: the expanded
 * value reaches the request exactly as the SDK sends it, and the raw HTTP log
 * of that request does not contain it.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintCustomProviderId } from "ai-config";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import { registerAllProviders } from "../../register-all-providers";
import type { CancellationToken, Logger } from "../../types";
import { configureRawHttpLogging, resetRawHttpLoggingForTests } from "../raw-http-logging";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

let logDir: string;

beforeEach(() => {
	logDir = mkdtempSync(join(tmpdir(), "pa-header-ref-wire-"));
	configureRawHttpLogging({ outputDir: join(logDir, "unused"), overrideDir: logDir });
});

afterEach(() => {
	resetRawHttpLoggingForTests();
	vi.unstubAllGlobals();
	rmSync(logDir, { recursive: true, force: true });
});

async function readLogs(): Promise<{ request: string; response: string }> {
	const deadline = Date.now() + 5000;
	for (;;) {
		const files = readdirSync(logDir).filter((f) => f.endsWith(".http"));
		const request = files.find((f) => f.endsWith("-request.http"));
		const response = files.find((f) => f.endsWith("-response.http"));
		if (request && response) {
			return {
				request: readFileSync(join(logDir, request), "utf8"),
				response: readFileSync(join(logDir, response), "utf8"),
			};
		}
		if (Date.now() > deadline) throw new Error(`Timed out waiting for logs: ${files.join(", ")}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

it("sends expanded header values but keeps them out of the raw HTTP log", async () => {
	const capture = createRawFetchCapture(
		async () =>
			new Response("data: [DONE]\n\n", {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"x-ratelimit-remaining-requests": "99",
				},
			}),
	);
	vi.stubGlobal("fetch", capture.mock);

	const env: Record<string, string> = {
		CLIENT_ID: "private-client",
		JWS_TOKEN: "jws-secret",
		STAINLESS_TOKEN: "stainless-secret",
	};
	const providerId = mintCustomProviderId("acme-gateway");
	const registry = new ProviderRegistry(logger);
	registerAllProviders(registry, logger, {
		positAiBaseUrl: "https://api.posit.cloud",
		userAgent: "PositAssistant/1.0",
		headerReferenceLookup: (name) => env[name],
		allowedProviders: [],
		customProviders: [{ id: providerId, clientKind: "openai-compatible" }],
	});
	const client = registry.getClientForProviderOrKind(
		providerId,
		{
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example/v1",
			customHeaders: {
				"User-Agent": "{env:CLIENT_ID}",
				"x-jws": "{env:JWS_TOKEN}",
				// Inside the logged protocol namespace, but a credential-looking name.
				"x-stainless-auth-token": "{env:STAINLESS_TOKEN}",
			},
		},
		"openai-compatible",
	);
	if (!client) throw new Error("expected a custom OpenAI-compatible client");

	const stream = await client.chat({
		model: "model-1",
		messages: [{ role: "user", content: "Hello" }],
		cancellationToken,
		protocol: "openai-chat",
	});
	for await (const _part of stream) {
		// Drain; the stub stream ends without a finish chunk.
	}

	const [input, init] = capture.single();
	const sent =
		init?.headers !== undefined
			? new Headers(init.headers)
			: input instanceof Request
				? input.headers
				: new Headers();
	const userAgent = sent.get("user-agent") ?? "";
	// The SDK appended its own tokens, so the wire value differs from the expansion.
	expect(userAgent.startsWith("private-client ")).toBe(true);
	expect(sent.get("x-jws")).toBe("jws-secret");
	expect(sent.get("x-stainless-auth-token")).toBe("stainless-secret");

	const { request, response } = await readLogs();
	expect(request).not.toContain("private-client");
	expect(request).not.toContain("jws-secret");
	expect(request).not.toContain("stainless-secret");
	expect(request).toContain("user-agent: [REDACTED]");
	expect(request).toContain("content-type: application/json");
	expect(response).toContain("x-ratelimit-remaining-requests: 99");
});
