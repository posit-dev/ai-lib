/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Wire tests: which Authorization scheme the InvokeModel and Converse routes
// send when AWS_BEARER_TOKEN_BEDROCK is set.

import { afterEach, describe, expect, it, vi } from "vitest";

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(async () => ({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		mantleEnabled: true,
	})),
}));

// No AWS configured endpoint, whatever the ambient environment holds.
vi.mock("../../providers/bedrock-transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../providers/bedrock-transport")>()),
	resolveBedrockTransport,
	resolveConfiguredBedrockEndpoints: async () => ({ runtime: undefined, listing: undefined }),
}));

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { BedrockClient } from "../BedrockClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const GATEWAY = "https://connect.example.com/__gateway__/bedrock/g1";

async function consumeIgnoringNetworkFailure(
	streamPromise: ReturnType<BedrockClient["chat"]>,
): Promise<void> {
	try {
		const stream = await streamPromise;
		for await (const _part of stream) {
			// Consume the minimal mocked event stream.
		}
	} catch {
		// Expected.
	}
}

async function send(client: BedrockClient, model: string, baseUrl?: string) {
	const capture = createRawFetchCapture(async () => new Response("{}", { status: 400 }));
	vi.stubGlobal("fetch", capture.mock);
	await consumeIgnoringNetworkFailure(
		client.chat({
			model,
			baseUrl,
			messages: [{ role: "user", content: "Hello" }],
			cancellationToken,
		}),
	);
	const [input, init] = capture.call(0);
	return {
		url: String(input instanceof Request ? input.url : input),
		authorization: new Headers(init?.headers).get("authorization"),
	};
}

const explicitKeys = {
	region: "us-east-1",
	accessKeyId: "AKID",
	secretAccessKey: "s",
};

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe("Bedrock InvokeModel route", () => {
	it("signs with explicit keys and ignores AWS_BEARER_TOKEN_BEDROCK", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "stale";
		const { url, authorization } = await send(
			new BedrockClient(explicitKeys),
			"us.anthropic.claude-sonnet-4-5-20250929-v1:0",
			GATEWAY,
		);

		expect(url.startsWith(GATEWAY)).toBe(true);
		expect(authorization).toContain("/us-east-1/bedrock/aws4_request");
		expect(authorization).not.toContain("Bearer");
	});
});

describe("Bedrock Converse route", () => {
	it("signs with explicit keys and ignores AWS_BEARER_TOKEN_BEDROCK", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "stale";
		const { url, authorization } = await send(
			new BedrockClient(explicitKeys),
			"amazon.nova-pro-v1:0",
			GATEWAY,
		);

		expect(url.startsWith(GATEWAY)).toBe(true);
		expect(authorization).toContain("/us-east-1/bedrock/aws4_request");
		expect(authorization).not.toContain("Bearer");
	});

	it("keeps the SDK bearer behavior without explicit keys", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
		const { authorization } = await send(
			new BedrockClient({ region: "us-east-1" }),
			"amazon.nova-pro-v1:0",
		);

		expect(authorization).toBe("Bearer tok");
	});
});
