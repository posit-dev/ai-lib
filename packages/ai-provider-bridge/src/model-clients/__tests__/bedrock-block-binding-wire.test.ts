/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bedrock InvokeModel wire for thinking block binding. `@ai-sdk/amazon-bedrock`
 * renames the field to the deprecated `mismatch_behavior`, which some regions
 * ignore, so the client must send `prefix_mismatch_behavior` and a SigV4
 * signature that covers the body actually sent.
 */

import { AwsV4Signer } from "aws4fetch";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createRawFetchCapture,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { THINKING_BINDING_BETA } from "../../utils";
import { BedrockClient } from "../BedrockClient";

vi.mock("../../providers/bedrock-transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../providers/bedrock-transport")>()),
	resolveBedrockTransport: async () => ({
		useFipsEndpoint: false,
		mantleEnabled: true,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
	}),
	resolveConfiguredBedrockEndpoints: async () => ({ runtime: undefined, listing: undefined }),
}));

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const keys = {
	accessKeyId: "AKIDTEST",
	secretAccessKey: "secret-test",
	sessionToken: "token-test",
};

let fetchCapture: RawFetchCapture;

beforeEach(() => {
	fetchCapture = createRawFetchCapture(
		async () =>
			new Response("", {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	);
	vi.stubGlobal("fetch", fetchCapture.mock);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/**
 * Send one request through the stubbed fetch. The mocked stream is empty, and
 * BedrockClient leaves AI SDK's default error logging on, so expect its one
 * NoOutputGeneratedError log.
 */
async function sendRequest(): Promise<void> {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		try {
			const stream = await new BedrockClient({ region: "us-east-1", ...keys }).chat({
				model: "us.anthropic.claude-opus-5-5",
				messages: [{ role: "user", content: "hello" }],
				maxOutputTokens: 1024,
				thinkingEffort: "high",
				thinkingBlockBinding: "drop_block",
				cancellationToken,
			});
			for await (const _part of stream) {
				// Drain the (empty) mocked event stream.
			}
		} catch {
			// Only the request matters.
		}
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			expect.objectContaining({ name: "AI_NoOutputGeneratedError" }),
		);
	} finally {
		consoleError.mockRestore();
	}
}

describe("Bedrock thinking block binding wire", () => {
	it("sends prefix_mismatch_behavior with the beta", async () => {
		await sendRequest();
		const [, init] = fetchCapture.single();
		const body = JSON.parse(String(init?.body));
		expect(body.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
		expect(body.anthropic_beta).toContain(THINKING_BINDING_BETA);
	});

	it("signs the body it sends", async () => {
		await sendRequest();
		const [input, init] = fetchCapture.single();
		const sent = new Headers(init?.headers);
		const unsigned = new Headers(sent);
		unsigned.delete("authorization");
		const expected = await new AwsV4Signer({
			url: String(input),
			method: "POST",
			headers: unsigned,
			body: String(init?.body),
			region: "us-east-1",
			service: "bedrock",
			datetime: sent.get("x-amz-date") ?? undefined,
			...keys,
		}).sign();
		expect(sent.get("authorization")).toBe(expected.headers.get("authorization"));
	});
});
