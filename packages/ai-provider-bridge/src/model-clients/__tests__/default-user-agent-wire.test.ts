/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Wire regressions for the registry-level direct-provider User-Agent.
 *
 * Every assertion reads the request exactly as it reached `fetch`: SDKs may
 * rewrite headers after we hand them over, so what we passed in proves
 * nothing. Each route also asserts the URL and auth scheme it hit, so an
 * ambient environment that silently re-routes a request fails loudly instead
 * of passing against the wrong path.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ModelMessage } from "ai";
import { mintCustomProviderId, OPENCODE_GO_BASE_URL } from "ai-config";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bedrock model listing goes through the AWS SDK, not `fetch`. Every list
 * client the provider builds gets this stub transport, which records the
 * request after the SDK's middleware (user-agent included) has run.
 */
const awsSdk = vi.hoisted(() => {
	interface CapturedAwsRequest {
		hostname: string;
		path: string;
		headers: Record<string, string>;
	}
	const requests: CapturedAwsRequest[] = [];
	return {
		requests,
		requestHandler: {
			async handle(request: CapturedAwsRequest) {
				requests.push({
					hostname: request.hostname,
					path: request.path,
					headers: { ...request.headers },
				});
				const body = request.path.startsWith("/inference-profiles")
					? { inferenceProfileSummaries: [] }
					: { modelSummaries: [] };
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

import {
	createRawFetchCapture,
	type RawFetchCall,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
import { registerCustomOpenAICompatibleProvider } from "../../providers/openai-compatible-provider";
import { ProviderRegistry } from "../../providers/ProviderRegistry";
import { registerAllProviders } from "../../register-all-providers";
import type {
	CancellationToken,
	Logger,
	ModelClient,
	ProviderCredentials,
	Protocol,
} from "../../types";

const PRODUCT_USER_AGENT = "PositAssistant-Standalone/1.0 (darwin)";

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

const messages: ModelMessage[] = [{ role: "user", content: "Hello" }];

// ---------------------------------------------------------------------------
// Environment isolation
// ---------------------------------------------------------------------------

/**
 * Ambient variables that re-route a request: `GOOGLE_VERTEX_API_KEY` bypasses
 * the supplied Google auth, `AWS_BEARER_TOKEN_BEDROCK` swaps SigV4 for Bearer,
 * FIPS config disables Mantle and changes hosts, endpoint-URL and dualstack
 * settings change the AWS SDK listing host, and an AWS profile could supply
 * any of them. Raw HTTP logging would interpose its own fetch.
 */
const ISOLATED_ENV_KEYS = [
	"GOOGLE_VERTEX_API_KEY",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_USE_FIPS_ENDPOINT",
	"AWS_USE_DUALSTACK_ENDPOINT",
	"AWS_ENDPOINT_URL",
	"AWS_ENDPOINT_URL_BEDROCK",
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_SDK_UA_APP_ID",
	"PA_RAW_HTTP_LOG_DIR",
] as const;

let fixtureDir: string;
let savedEnv: Record<string, string | undefined>;

beforeAll(() => {
	fixtureDir = mkdtempSync(join(tmpdir(), "pa-ua-wire-"));
	writeFileSync(join(fixtureDir, "aws-config"), "");
	writeFileSync(join(fixtureDir, "aws-credentials"), "");
});

afterAll(() => {
	rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
	savedEnv = Object.fromEntries(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));
	for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
	process.env.AWS_USE_FIPS_ENDPOINT = "false";
	process.env.AWS_USE_DUALSTACK_ENDPOINT = "false";
	process.env.AWS_CONFIG_FILE = join(fixtureDir, "aws-config");
	process.env.AWS_SHARED_CREDENTIALS_FILE = join(fixtureDir, "aws-credentials");
	awsSdk.requests.length = 0;
});

afterEach(() => {
	for (const key of ISOLATED_ENV_KEYS) {
		const value = savedEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AWS_CREDENTIALS: ProviderCredentials = {
	type: "aws-credentials",
	region: "us-east-1",
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "fake-secret",
};

const VERTEX_CREDENTIALS: ProviderCredentials = {
	type: "google-cloud",
	project: "test-project",
	location: "us-central1",
	accessToken: "static-vertex-token",
};

const OLLAMA_CREDENTIALS: ProviderCredentials = {
	type: "local",
	endpoint: "http://localhost:11434",
};

const LMSTUDIO_CREDENTIALS: ProviderCredentials = {
	type: "local",
	endpoint: "http://localhost:1234/v1",
};

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function sseResponse(): Response {
	return new Response("data: [DONE]\n\n", {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Answer discovery endpoints with minimal valid bodies; everything else gets an empty stream. */
async function respond(...[input]: RawFetchCall): Promise<Response> {
	const url = requestUrl(input);
	if (url.endsWith("/api/tags")) {
		return jsonResponse({ models: [{ name: "llama3.1:8b", size: 1 }] });
	}
	if (url.endsWith("/api/show")) {
		return jsonResponse({ capabilities: ["completion", "tools"] });
	}
	if (url.endsWith("/api/chat")) {
		// ollama-js parses NDJSON and logs anything else to stderr.
		const done = { model: "llama3.1:8b", message: { role: "assistant", content: "" }, done: true };
		return new Response(`${JSON.stringify(done)}\n`, {
			status: 200,
			headers: { "content-type": "application/x-ndjson" },
		});
	}
	if (url.startsWith("http://localhost:1234/v1/models")) {
		return jsonResponse({ data: [{ id: "qwen2.5-7b" }] });
	}
	if (url.startsWith("https://bedrock-mantle.") && url.endsWith("/v1/models")) {
		return jsonResponse({ data: [{ id: "openai.gpt-oss-120b" }] });
	}
	if (url.endsWith("/api/v2/statements")) {
		return jsonResponse({
			resultSetMetaData: {
				rowType: [{ name: "name" }, { name: "lifecycle_status" }],
			},
			data: [["CLAUDE-OPUS-5", "GA"]],
		});
	}
	if (url.includes("/v1beta1/publishers/")) {
		return jsonResponse({ publisherModels: [{ name: "publishers/google/models/gemini-2.5-pro" }] });
	}
	return sseResponse();
}

function createRegistry(): ProviderRegistry {
	const registry = new ProviderRegistry(logger);
	registerAllProviders(registry, logger, {
		positAiBaseUrl: "https://api.posit.cloud",
		userAgent: PRODUCT_USER_AGENT,
		allowedProviders: [
			"bedrock",
			"google-vertex",
			"ollama",
			"lmstudio",
			"opencode",
			"snowflake-cortex",
		],
	});
	return registry;
}

function stubFetch(): RawFetchCapture {
	const capture = createRawFetchCapture(respond);
	vi.stubGlobal("fetch", capture.mock);
	return capture;
}

// ---------------------------------------------------------------------------
// Driver and assertions
// ---------------------------------------------------------------------------

interface ChatRoute {
	model: string;
	protocol?: Protocol;
	baseUrl?: string;
}

/**
 * Drive one chat turn to the wire. Failures after a request is captured are
 * expected (the mocked stream is intentionally incomplete); a failure before
 * any request is captured is rethrown so a broken route cannot masquerade as
 * a missing header.
 */
async function driveChat(
	client: ModelClient,
	capture: RawFetchCapture,
	route: ChatRoute,
): Promise<void> {
	const before = capture.calls.length;
	let failure: unknown;
	try {
		const stream = await client.chat({
			model: route.model,
			messages,
			cancellationToken,
			protocol: route.protocol,
			baseUrl: route.baseUrl,
			metadata: { rootConversationId: "root-1" },
		});
		for await (const part of stream) {
			if (part.type === "error" && failure === undefined) failure = part.error;
		}
	} catch (error) {
		failure ??= error;
	}
	if (capture.calls.length === before && failure !== undefined) {
		throw failure instanceof Error ? failure : new Error(String(failure));
	}
}

/**
 * Anthropic-wire routes treat the stub `[DONE]` body as a stream with no
 * finish chunk, and BedrockClient/GoogleVertexClient leave the AI SDK's
 * default `onError` (which writes to console.error) in place. Capture that one
 * expected log and assert exactly what it was.
 */
async function expectingNoOutputLog(run: () => Promise<void>): Promise<void> {
	const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
	try {
		await run();
		expect(consoleError).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalledWith(
			expect.objectContaining({ name: "AI_NoOutputGeneratedError" }),
		);
	} finally {
		consoleError.mockRestore();
	}
}

function requestUrl(input: RawFetchCall[0]): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

function requestHeaders(call: RawFetchCall): Headers {
	const [input, init] = call;
	if (init?.headers !== undefined) return new Headers(init.headers);
	return input instanceof Request ? input.headers : new Headers();
}

/** Every captured request whose URL starts with `urlPrefix`; at least one must exist. */
function requestsTo(capture: RawFetchCapture, urlPrefix: string): RawFetchCall[] {
	const matching = capture.calls.filter(([input]) => requestUrl(input).startsWith(urlPrefix));
	expect(
		matching.length,
		`expected a request to ${urlPrefix}; captured: ${capture.calls.map(([input]) => requestUrl(input)).join(", ") || "none"}`,
	).toBeGreaterThan(0);
	return matching;
}

interface IdentityExpectation {
	/** Library token the transport itself appends, when it supplies one. */
	libraryToken?: string;
	/** Expected `Authorization` scheme, proving the intended auth route. */
	authScheme?: "AWS4-HMAC-SHA256" | "Bearer";
}

function expectProductIdentity(call: RawFetchCall, expectation: IdentityExpectation = {}): void {
	const headers = requestHeaders(call);
	if (expectation.authScheme) {
		expect(headers.get("authorization")?.split(" ")[0]).toBe(expectation.authScheme);
	}
	const userAgent = headers.get("user-agent");
	if (expectation.libraryToken) {
		expect(userAgent?.startsWith(`${PRODUCT_USER_AGENT} `), `user-agent: ${userAgent}`).toBe(true);
		expect(userAgent).toContain(expectation.libraryToken);
	} else {
		expect(userAgent?.startsWith(PRODUCT_USER_AGENT), `user-agent: ${userAgent}`).toBe(true);
	}
}

function clientFor(
	registry: ProviderRegistry,
	providerId: string,
	credentials: ProviderCredentials,
) {
	const client = registry.getClientForProvider(providerId, credentials);
	if (!client) throw new Error(`expected a ${providerId} client`);
	return client;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const MANTLE_HOST = "https://bedrock-mantle.us-east-1.api.aws";
const BEDROCK_RUNTIME_MODEL = "https://bedrock-runtime.us-east-1.amazonaws.com/model/";
const SIGV4 = { authScheme: "AWS4-HMAC-SHA256" } as const;
const VERTEX_BEARER = { authScheme: "Bearer" } as const;

describe("default direct-provider User-Agent (wire)", () => {
	it("reaches a direct-SDK OpenCode request", async () => {
		const capture = stubFetch();
		const client = clientFor(createRegistry(), "opencode", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: OPENCODE_GO_BASE_URL,
		});

		await driveChat(client, capture, { model: "model-1", protocol: "openai-chat" });

		expectProductIdentity(capture.single(), { libraryToken: "ai-sdk-provider-utils/" });
	});

	it("reaches a custom OpenAI-compatible request through fetch middleware", async () => {
		const capture = stubFetch();
		const registry = new ProviderRegistry(logger);
		registerAllProviders(registry, logger, {
			positAiBaseUrl: "https://api.posit.cloud",
			userAgent: PRODUCT_USER_AGENT,
			allowedProviders: [],
		});
		const providerId = mintCustomProviderId("acme-openai");
		registerCustomOpenAICompatibleProvider(registry, providerId, logger);
		const client = registry.getClientForProviderOrKind(
			providerId,
			{ type: "apikey", apiKey: "sk-test", baseUrl: "https://gateway.example/v1" },
			"openai-compatible",
		);
		if (!client) throw new Error("expected custom OpenAI-compatible client");

		await driveChat(client, capture, { model: "model-1", protocol: "openai-chat" });

		expectProductIdentity(capture.single(), { libraryToken: "ai-sdk-provider-utils/" });
	});

	describe("Bedrock", () => {
		it("reaches Converse chat", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "bedrock", AWS_CREDENTIALS);

			await driveChat(client, capture, {
				model: "amazon.nova-pro-v1:0",
				protocol: "bedrock-converse",
			});

			for (const call of requestsTo(capture, `${BEDROCK_RUNTIME_MODEL}amazon.nova-pro-v1`)) {
				expect(requestUrl(call[0])).toContain("/converse-stream");
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...SIGV4 });
			}
		});

		it("reaches Bedrock Anthropic chat", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "bedrock", AWS_CREDENTIALS);

			await expectingNoOutputLog(() =>
				driveChat(client, capture, {
					model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
					protocol: "anthropic-messages",
				}),
			);

			for (const call of requestsTo(
				capture,
				`${BEDROCK_RUNTIME_MODEL}us.anthropic.claude-sonnet-4-5`,
			)) {
				expect(requestUrl(call[0])).toContain("/invoke-with-response-stream");
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...SIGV4 });
			}
		});

		it("reaches Mantle Chat Completions", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "bedrock", AWS_CREDENTIALS);

			await driveChat(client, capture, {
				model: "openai.gpt-oss-120b",
				protocol: "openai-chat",
				baseUrl: `${MANTLE_HOST}/v1`,
			});

			for (const call of requestsTo(capture, `${MANTLE_HOST}/v1/chat/completions`)) {
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...SIGV4 });
			}
		});

		it("reaches Mantle Responses", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "bedrock", AWS_CREDENTIALS);

			await driveChat(client, capture, {
				model: "openai.gpt-5.5",
				protocol: "openai-responses",
				baseUrl: `${MANTLE_HOST}/openai/v1`,
			});

			for (const call of requestsTo(capture, `${MANTLE_HOST}/openai/v1/responses`)) {
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...SIGV4 });
			}
		});

		it("reaches AWS SDK model listing and Mantle model listing", async () => {
			const capture = stubFetch();

			await createRegistry().getModelsForProvider("bedrock", AWS_CREDENTIALS);

			// AWS SDK listing: the SDK escapes spaces and parentheses in
			// `customUserAgent` and places it after its own tokens.
			const awsPaths = awsSdk.requests.map((request) => request.path);
			expect(awsPaths.some((path) => path.startsWith("/foundation-models"))).toBe(true);
			expect(awsPaths.some((path) => path.startsWith("/inference-profiles"))).toBe(true);
			for (const request of awsSdk.requests) {
				expect(request.hostname).toBe("bedrock.us-east-1.amazonaws.com");
				expect(request.headers.authorization?.split(" ")[0]).toBe("AWS4-HMAC-SHA256");
				const userAgent = request.headers["user-agent"];
				expect(userAgent).toContain("aws-sdk-js");
				expect(userAgent).toContain("PositAssistant-Standalone/1.0");
			}

			// Mantle listing is a raw signed fetch: product token only.
			for (const call of requestsTo(capture, `${MANTLE_HOST}/v1/models`)) {
				expectProductIdentity(call, SIGV4);
			}
		});
	});

	describe("Vertex", () => {
		it("reaches Gemini publisher chat", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "google-vertex", VERTEX_CREDENTIALS);

			await driveChat(client, capture, {
				model: "gemini-2.5-pro",
				protocol: "google-generative",
			});

			for (const call of requestsTo(
				capture,
				"https://us-central1-aiplatform.googleapis.com/v1beta1/projects/test-project/locations/us-central1/publishers/google/models/gemini-2.5-pro:streamGenerateContent",
			)) {
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...VERTEX_BEARER });
			}
		});

		it("reaches Anthropic publisher chat", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "google-vertex", VERTEX_CREDENTIALS);

			await expectingNoOutputLog(() =>
				driveChat(client, capture, {
					model: "claude-sonnet-4-5",
					protocol: "anthropic-messages",
				}),
			);

			const calls = requestsTo(capture, "https://aiplatform.googleapis.com/");
			for (const call of calls) {
				expect(requestUrl(call[0])).toContain(
					"/projects/test-project/locations/global/publishers/anthropic/models/claude-sonnet-4-5:streamRawPredict",
				);
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/", ...VERTEX_BEARER });
			}
		});

		it("reaches publisher-model listing for both publishers", async () => {
			const capture = stubFetch();

			await createRegistry().getModelsForProvider("google-vertex", VERTEX_CREDENTIALS);

			for (const prefix of [
				"https://us-central1-aiplatform.googleapis.com/v1beta1/publishers/google/models",
				"https://aiplatform.googleapis.com/v1beta1/publishers/anthropic/models",
			]) {
				for (const call of requestsTo(capture, prefix)) {
					expectProductIdentity(call, VERTEX_BEARER);
				}
			}
		});
	});

	describe("Ollama", () => {
		it("reaches chat with the ollama-js token after the product token", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "ollama", OLLAMA_CREDENTIALS);

			await driveChat(client, capture, { model: "llama3.1:8b" });

			for (const call of requestsTo(capture, "http://localhost:11434/api/chat")) {
				expectProductIdentity(call, { libraryToken: "ollama-js/" });
			}
		});

		it("reaches /api/tags and /api/show discovery", async () => {
			const capture = stubFetch();

			await createRegistry().getModelsForProvider("ollama", OLLAMA_CREDENTIALS);

			for (const call of [
				...requestsTo(capture, "http://localhost:11434/api/tags"),
				...requestsTo(capture, "http://localhost:11434/api/show"),
			]) {
				expectProductIdentity(call);
			}
		});
	});

	describe("LM Studio", () => {
		it("reaches chat through the registry factory", async () => {
			const capture = stubFetch();
			const client = clientFor(createRegistry(), "lmstudio", LMSTUDIO_CREDENTIALS);

			await driveChat(client, capture, { model: "qwen2.5-7b" });

			for (const call of requestsTo(capture, "http://localhost:1234/v1/chat/completions")) {
				expectProductIdentity(call, { libraryToken: "ai-sdk-provider-utils/" });
			}
		});

		it("reaches model discovery", async () => {
			const capture = stubFetch();

			await createRegistry().getModelsForProvider("lmstudio", LMSTUDIO_CREDENTIALS);

			for (const call of requestsTo(capture, "http://localhost:1234/v1/models")) {
				expectProductIdentity(call);
			}
		});
	});

	describe("Snowflake", () => {
		it("reaches SQL API model discovery with the token-type header kept", async () => {
			const capture = stubFetch();

			const models = await createRegistry().getModelsForProvider("snowflake-cortex", {
				type: "apikey",
				apiKey: "pat-token",
				baseUrl: "https://acct.snowflakecomputing.com",
				customHeaders: { "X-Snowflake-Authorization-Token-Type": "PROGRAMMATIC_ACCESS_TOKEN" },
			});

			expect(models.map((model) => model.id)).toEqual(["claude-opus-5"]);
			const [call] = requestsTo(capture, "https://acct.snowflakecomputing.com/api/v2/statements");
			expectProductIdentity(call, { authScheme: "Bearer" });
			expect(requestHeaders(call).get("x-snowflake-authorization-token-type")).toBe(
				"PROGRAMMATIC_ACCESS_TOKEN",
			);
		});
	});
});
