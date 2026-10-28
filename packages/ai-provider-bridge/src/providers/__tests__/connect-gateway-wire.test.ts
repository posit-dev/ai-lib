/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Runtime model listing goes through the AWS SDK's own HTTP handler, not
 * `fetch`. Every catalog client gets this stub transport, which records each
 * request after the SDK has built and signed it.
 */
const awsSdk = vi.hoisted(() => {
	interface CapturedAwsRequest {
		hostname: string;
		path: string;
		headers: Record<string, string>;
	}
	const requests: CapturedAwsRequest[] = [];
	const bare = "anthropic.claude-sonnet-4-5-20250929-v1:0";
	return {
		requests,
		requestHandler: {
			async handle(request: CapturedAwsRequest) {
				requests.push({
					hostname: request.hostname,
					path: request.path,
					headers: { ...request.headers },
				});
				const body = request.path.endsWith("/inference-profiles")
					? {
							inferenceProfileSummaries: [
								{
									status: "ACTIVE",
									inferenceProfileId: `us.${bare}`,
									models: [{ modelArn: `arn:aws:bedrock:us-west-2::foundation-model/${bare}` }],
								},
							],
						}
					: { modelSummaries: [{ modelId: bare, modelName: "Claude Sonnet 4.5" }] };
				return {
					response: {
						statusCode: 200,
						headers: { "content-type": "application/json" },
						body: new TextEncoder().encode(JSON.stringify(body)),
					},
				};
			},
		},
	};
});

vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock")>();
	class BedrockClient extends actual.BedrockClient {
		constructor(config: ConstructorParameters<typeof actual.BedrockClient>[0]) {
			super({ ...config, requestHandler: awsSdk.requestHandler });
		}
	}
	return { ...actual, BedrockClient };
});

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken, Logger } from "../../types";
import { registerConnectProvider } from "../connect-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};
const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const gatewayUrl =
	"https://connect.example.com/__gateway__/bedrock/aaaa1111-1111-1111-1111-111111111111";

function captureGatewayRequest() {
	const events = [
		{
			type: "message_start",
			message: {
				id: "msg_test",
				model: "claude-3-5-sonnet",
				role: "assistant",
				content: [],
				stop_reason: null,
				stop_sequence: null,
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{
			type: "message_delta",
			delta: { stop_reason: "end_turn", stop_sequence: null },
			usage: { output_tokens: 0 },
		},
		{ type: "message_stop" },
	];
	const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
	const capture = createRawFetchCapture(async (input) => {
		// The empty-cache aws chat re-reads the integrations endpoint for its region.
		if (String(input).endsWith("/__api__/v1/oauth/integrations")) {
			return new Response("[]", { status: 200 });
		}
		return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
	});
	vi.stubGlobal("fetch", capture.mock);
	return capture;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Connect Bedrock gateway attribution", () => {
	it("sends Workbench and configured metadata on the signed wire request", async () => {
		const capture = captureGatewayRequest();
		const registry = new ProviderRegistry(logger);
		registerConnectProvider(
			registry,
			logger,
			{
				getAwsCredentials: async () => ({
					ok: true,
					credentials: {
						type: "aws-credentials",
						region: "us-east-1",
						accessKeyId: "AKIDEXAMPLE",
						secretAccessKey: "secret",
						sessionToken: "session",
					},
				}),
			},
			{ PWB_GATEWAY_METADATA_HEADER: "workbench-session-id=s1" },
		);
		const client = registry.getClientForProvider("posit-connect", {
			type: "apikey",
			apiKey: "federated-token",
			baseUrl: "https://connect.example.com",
			customHeaders: { "Gateway-Metadata": "team=research" },
		});
		if (!client) throw new Error("Connect client was not registered");

		const stream = await client.chat({
			model:
				"posit-connect-aaaa1111-1111-1111-1111-111111111111/us.anthropic.claude-3-5-sonnet-20241022-v2:0",
			baseUrl: gatewayUrl,
			protocol: "bedrock-converse",
			messages: [{ role: "user", content: "hello" }],
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drive the Bedrock gateway request into the stubbed fetch.
		}

		// The last call is the signed gateway request, after the region re-read.
		const [url, init] = capture.call(capture.calls.length - 1);
		expect(String(url)).toContain(gatewayUrl);
		const headers = new Headers(init?.headers);
		expect(headers.get("Gateway-Metadata")).toBe("workbench-session-id=s1,team=research");
		expect(headers.get("authorization")).toContain("/us-east-1/bedrock/aws4_request");
	});
});

describe("Connect Bedrock gateway model listing", () => {
	it("lists Runtime models through the gateway route, signed for bedrock in the integration's region", async () => {
		awsSdk.requests.length = 0;
		const guid = "bbbb2222-2222-2222-2222-222222222222";
		const capture = createRawFetchCapture(async (input) => {
			const url = String(input instanceof Request ? input.url : input);
			if (url.endsWith("/__api__/v1/oauth/integrations")) {
				return new Response(
					JSON.stringify([
						{
							guid,
							template: "aws",
							name: "Bedrock Team",
							auth_type: "Viewer",
							config: { sts_region: "us-west-2" },
						},
					]),
					{ status: 200 },
				);
			}
			// The Mantle listing goes through fetch; it lists nothing here.
			return new Response(JSON.stringify({ data: [] }), { status: 200 });
		});
		vi.stubGlobal("fetch", capture.mock);
		const registry = new ProviderRegistry(logger);
		// The minted region differs on purpose: Connect verifies the integration's.
		registerConnectProvider(registry, logger, {
			getAwsCredentials: async () => ({
				ok: true,
				credentials: {
					type: "aws-credentials",
					region: "us-east-1",
					accessKeyId: "AKIDMINTED",
					secretAccessKey: "secret",
					sessionToken: "session",
				},
			}),
		});

		const models = await registry.getModelsForProvider("posit-connect", {
			type: "apikey",
			apiKey: "federated-token",
			baseUrl: "https://connect.example.com",
		});

		expect(models.map((model) => model.id)).toContain(
			`posit-connect-bedrock-team-${guid}/us.anthropic.claude-sonnet-4-5-20250929-v1:0`,
		);
		expect(awsSdk.requests.map(({ hostname, path }) => `${hostname}${path}`).sort()).toEqual([
			`connect.example.com/__gateway__/bedrock/${guid}/foundation-models`,
			`connect.example.com/__gateway__/bedrock/${guid}/inference-profiles`,
		]);
		for (const request of awsSdk.requests) {
			expect(request.headers.authorization).toContain("Credential=AKIDMINTED/");
			expect(request.headers.authorization).toContain("/us-west-2/bedrock/aws4_request");
		}
	});
});
