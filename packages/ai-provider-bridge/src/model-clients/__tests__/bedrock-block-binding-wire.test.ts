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
import { BedrockClient, type BedrockClientConfig } from "../BedrockClient";

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

const GATEWAY = "https://connect.example.com/__gateway__/bedrock/g1";

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
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

/**
 * Send one request through the stubbed fetch. The mocked stream is empty, and
 * BedrockClient leaves AI SDK's default error logging on, so expect its one
 * NoOutputGeneratedError log.
 */
async function sendRequest(
	config: BedrockClientConfig = { region: "us-east-1", ...keys },
	baseUrl?: string,
): Promise<void> {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		try {
			const stream = await new BedrockClient(config).chat({
				model: "us.anthropic.claude-opus-5-5",
				baseUrl,
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

	it("signs the body it sends with the SDK's scope", async () => {
		await sendRequest({ region: "eu-west-1", ...keys }, GATEWAY);
		const [input, init] = fetchCapture.single();
		expect(String(input).startsWith(GATEWAY)).toBe(true);
		const sent = new Headers(init?.headers);
		expect(sent.get("authorization")).toContain("/eu-west-1/bedrock/aws4_request");
		expect(sent.get("authorization")).toBe(
			await expectedAuthorization(String(input), init, "eu-west-1"),
		);
	});

	it("leaves a non-ASCII custom header unsigned but sends it", async () => {
		await sendRequest({
			region: "us-east-1",
			...keys,
			customHeaders: { "x-title": "Example · App" },
		});
		const [input, init] = fetchCapture.single();
		const sent = new Headers(init?.headers);
		expect(sent.get("x-title")).toBe("Example · App");
		expect(sent.get("authorization")).not.toContain("x-title");
		expect(sent.get("authorization")).toBe(
			await expectedAuthorization(String(input), init, "us-east-1", ["x-title"]),
		);
	});

	it("sends prefix_mismatch_behavior with bearer auth", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "tok";
		await sendRequest({ region: "us-east-1" });
		const [, init] = fetchCapture.single();
		expect(new Headers(init?.headers).get("authorization")).toBe("Bearer tok");
		const body = JSON.parse(String(init?.body));
		expect(body.thinking.block_binding).toEqual({ prefix_mismatch_behavior: "drop_block" });
	});
});

/** The Authorization a correct SigV4 signature of the sent request would carry. */
async function expectedAuthorization(
	url: string,
	init: RequestInit | undefined,
	region: string,
	unsignedHeaders: string[] = [],
): Promise<string | null> {
	const sent = new Headers(init?.headers);
	const signedInput = new Headers(sent);
	for (const name of ["authorization", ...unsignedHeaders]) {
		signedInput.delete(name);
	}
	const expected = await new AwsV4Signer({
		url,
		method: "POST",
		headers: signedInput,
		body: String(init?.body),
		region,
		service: "bedrock",
		datetime: sent.get("x-amz-date") ?? undefined,
		...keys,
	}).sign();
	return expected.headers.get("authorization");
}
