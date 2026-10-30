/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Wire tests: Bedrock Mantle chats through a Posit Connect gateway, driven
// through the real Connect provider and the real BedrockClient. Only fetch,
// the transport resolver and the control-plane SDK client are faked.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { resolveBedrockTransport } = vi.hoisted(() => ({
	resolveBedrockTransport: vi.fn(),
}));

vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));

// The Runtime listing goes through the AWS SDK's own HTTP handler, not fetch;
// deny it so no request leaves the process.
vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => ({
	...(await importOriginal<typeof import("@aws-sdk/client-bedrock")>()),
	BedrockClient: vi.fn(function () {
		return {
			send: vi.fn(async () => {
				throw Object.assign(new Error("denied"), { name: "AccessDeniedException" });
			}),
			destroy: vi.fn(),
		};
	}),
}));

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { registerConnectProvider } from "../../providers/connect-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type { CancellationToken, Logger, Protocol } from "../../types";

const CONNECT_URL = "https://connect.example.com";
const AWS_GUID = "bbbb2222-2222-2222-2222-222222222222";
const AWS_PREFIX = `posit-connect-bedrock-team-${AWS_GUID}`;
const MANTLE_ROUTE = `${CONNECT_URL}/__gateway__/bedrock-mantle/${AWS_GUID}`;
const INTEGRATIONS_URL = `${CONNECT_URL}/__api__/v1/oauth/integrations`;
const INTEGRATIONS = [
	{
		guid: AWS_GUID,
		template: "aws",
		name: "Bedrock Team",
		auth_type: "Viewer",
		config: { sts_region: "us-west-2" },
	},
];

const credentials = { type: "apikey", apiKey: "tok", baseUrl: CONNECT_URL } as const;

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

function registry(): ProviderRegistry {
	const result = new ProviderRegistry(logger);
	registerConnectProvider(result, logger, {
		// The minted region differs on purpose: Connect verifies the integration's.
		getAwsCredentials: vi.fn(async () => ({
			ok: true as const,
			credentials: {
				type: "aws-credentials" as const,
				region: "us-east-1",
				accessKeyId: "AKIDMINTED",
				secretAccessKey: "secret",
				sessionToken: "session",
			},
		})),
	});
	return result;
}

function urlOf(input: RequestInfo | URL): string {
	return String(input instanceof Request ? input.url : input);
}

/** Answer discovery, then fail every inference request after capturing it. */
function stubGatewayFetch() {
	const capture = createRawFetchCapture(async (input) => {
		const url = urlOf(input);
		if (url === INTEGRATIONS_URL) {
			return new Response(JSON.stringify(INTEGRATIONS), { status: 200 });
		}
		if (url === `${MANTLE_ROUTE}/v1/models`) {
			return new Response(
				JSON.stringify({ data: [{ id: "openai.gpt-oss-120b-1:0" }, { id: "openai.gpt-5.6-sol" }] }),
				{ status: 200 },
			);
		}
		return new Response("{}", { status: 400 });
	});
	vi.stubGlobal("fetch", capture.mock);
	return capture;
}

async function consumeIgnoringNetworkFailure(
	streamPromise: Promise<AsyncIterable<unknown>>,
): Promise<void> {
	try {
		for await (const _part of await streamPromise) {
			// Consume until the faked failure ends the stream.
		}
	} catch {
		// Expected.
	}
}

async function chatWithDiscoveredModel(modelId: string, protocolOverride?: Protocol) {
	const capture = stubGatewayFetch();
	const providers = registry();
	const models = await providers.getModelsForProvider("posit-connect", credentials);
	const model = models.find((candidate) => candidate.id === `${AWS_PREFIX}/${modelId}`);
	expect(model).toBeDefined();
	const client = providers.getClientForProvider("posit-connect", credentials)!;
	const before = capture.calls.length;
	await consumeIgnoringNetworkFailure(
		client.chat({
			model: model!.id,
			protocol: protocolOverride ?? model!.protocol,
			baseUrl: model!.baseUrl,
			messages: [{ role: "user", content: "Hello" }],
			cancellationToken,
		}),
	);
	const inference = capture.calls.slice(before);
	expect(inference.length).toBeGreaterThan(0);
	const [input, init] = inference[0];
	return {
		url: urlOf(input),
		authorization: new Headers(
			input instanceof Request ? input.headers : (init?.headers as HeadersInit),
		).get("authorization"),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveBedrockTransport.mockResolvedValue({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
		mantleEnabled: true,
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
});

describe("Connect Bedrock Mantle wire requests", () => {
	it("sends Responses to the gateway's /openai/v1 route, signed for bedrock-mantle", async () => {
		process.env.AWS_BEARER_TOKEN_BEDROCK = "stale";
		const { url, authorization } = await chatWithDiscoveredModel("openai.gpt-5.6-sol");

		expect(url).toBe(`${MANTLE_ROUTE}/openai/v1/responses`);
		expect(authorization).toContain("Credential=AKIDMINTED/");
		expect(authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		expect(authorization).not.toContain("Bearer");
	});

	it("sends Chat Completions to the gateway's /v1 route, signed for bedrock-mantle", async () => {
		const { url, authorization } = await chatWithDiscoveredModel("openai.gpt-oss-120b-1:0");

		expect(url).toBe(`${MANTLE_ROUTE}/v1/chat/completions`);
		expect(authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
	});

	it("routes a protocol override to its own route, not the discovered stamp's", async () => {
		// The override keeps the discovered /v1 stamp; the request must still
		// reach the Responses route.
		const responses = await chatWithDiscoveredModel("openai.gpt-oss-120b-1:0", "openai-responses");
		expect(responses.url).toBe(`${MANTLE_ROUTE}/openai/v1/responses`);

		const chat = await chatWithDiscoveredModel("openai.gpt-5.6-sol", "openai-chat");
		expect(chat.url).toBe(`${MANTLE_ROUTE}/v1/chat/completions`);
	});

	it("lists no Mantle models when FIPS would refuse their chats", async () => {
		resolveBedrockTransport.mockResolvedValue({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
			mantleEnabled: false,
		});
		const capture = stubGatewayFetch();

		const models = await registry().getModelsForProvider("posit-connect", credentials);

		expect(models.filter((model) => model.id.startsWith(`${AWS_PREFIX}/`))).toEqual([]);
		expect(capture.calls.map(([input]) => urlOf(input))).not.toContain(`${MANTLE_ROUTE}/v1/models`);
	});

	it("refuses a Mantle chat with the existing FIPS message", async () => {
		resolveBedrockTransport.mockResolvedValue({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-west-2.amazonaws.com",
			mantleEnabled: false,
		});
		const capture = stubGatewayFetch();
		const client = registry().getClientForProvider("posit-connect", credentials)!;

		await expect(
			client.chat({
				model: `${AWS_PREFIX}/openai.gpt-5.6-sol`,
				protocol: "openai-responses",
				baseUrl: `${MANTLE_ROUTE}/openai/v1`,
				messages: [{ role: "user", content: "Hello" }],
				cancellationToken,
			}),
		).rejects.toThrow(
			"Bedrock protocol openai-responses is unavailable when AWS FIPS endpoints are enabled",
		);
		expect(capture.calls.map(([input]) => urlOf(input))).not.toContain(
			`${MANTLE_ROUTE}/openai/v1/responses`,
		);
	});
});
