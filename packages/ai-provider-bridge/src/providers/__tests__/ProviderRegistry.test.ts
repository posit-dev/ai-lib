/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger, ModelClient, ModelInfo, ProviderCredentials } from "../../types";
import { registerAnthropicProvider } from "../anthropic-provider";
import { registerGeminiProvider } from "../gemini-provider";
import { registerOpenAICompatibleProvider } from "../openai-compatible-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const client: ModelClient = { chat: vi.fn() };

describe("ProviderRegistry default User-Agent", () => {
	it("injects the default on model, direct-client, and kind-client paths", async () => {
		const registry = new ProviderRegistry(logger);
		const fetcher = vi.fn(async (_credentials: ProviderCredentials) => []);
		const directFactory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		const kindFactory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerModelFetcher("models", fetcher);
		registry.registerClientFactory("direct", directFactory);
		registry.registerClientFactory("openai", kindFactory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");

		await registry.getModelsForProvider("models", {
			type: "apikey",
			apiKey: "key",
			customHeaders: { "x-tenant": "acme" },
		});
		registry.getClientForProvider("direct", {
			type: "azure-entra",
			baseUrl: "https://foundry.example.com",
			scope: "scope",
		});
		registry.getClientForProviderOrKind("custom", { type: "apikey", apiKey: "key" }, "openai");

		expect(fetcher).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: {
					"User-Agent": "PositAssistant/1.0 posit_test",
					"x-tenant": "acme",
				},
			}),
			undefined,
		);
		expect(directFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
			}),
		);
		expect(kindFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
			}),
		);
	});

	it("preserves a non-empty explicit User-Agent case-insensitively", () => {
		const registry = new ProviderRegistry(logger);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerClientFactory("direct", factory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");

		registry.getClientForProvider("direct", {
			type: "apikey",
			apiKey: "key",
			customHeaders: { "uSeR-aGeNt": "AcmeGateway/2.0" },
		});

		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "uSeR-aGeNt": "AcmeGateway/2.0" },
			}),
		);
	});

	it("injects the default into AWS, Google Cloud, and local credentials", async () => {
		const registry = new ProviderRegistry(logger);
		const fetcher = vi.fn(async (_credentials: ProviderCredentials) => []);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerModelFetcher("models", fetcher);
		registry.registerClientFactory("direct", factory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");
		const variants: ProviderCredentials[] = [
			{ type: "aws-credentials", region: "us-east-1", profile: "prod" },
			{ type: "google-cloud", project: "project", location: "us-central1" },
			{ type: "local", endpoint: "http://localhost:11434" },
		];

		for (const credentials of variants) {
			const snapshot = structuredClone(credentials);
			await registry.getModelsForProvider("models", credentials);
			registry.getClientForProvider("direct", credentials);

			const expected = {
				...snapshot,
				customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
			};
			expect(fetcher).toHaveBeenLastCalledWith(expected, undefined);
			expect(factory).toHaveBeenLastCalledWith(expected);
			// The caller's credentials are never mutated.
			expect(credentials).toEqual(snapshot);
		}
	});

	it("injects the default on the custom-kind handoff for AWS credentials", () => {
		const registry = new ProviderRegistry(logger);
		const bedrockFactory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerClientFactory("bedrock", bedrockFactory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");

		registry.getClientForProviderOrKind(
			"my-bedrock",
			{ type: "aws-credentials", region: "us-east-1" },
			"aws",
		);

		expect(bedrockFactory).toHaveBeenCalledWith({
			type: "aws-credentials",
			region: "us-east-1",
			customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
		});
	});

	it("uses the latest default and leaves OAuth credentials untouched", () => {
		const registry = new ProviderRegistry(logger);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerClientFactory("direct", factory);
		registry.setDefaultUserAgent("PositAssistant/first");
		registry.setDefaultUserAgent("PositAssistant/second");

		registry.getClientForProvider("direct", { type: "apikey", apiKey: "key" });
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/second" },
			}),
		);

		factory.mockClear();
		const oauth: ProviderCredentials = { type: "oauth", accessToken: "token" };
		registry.getClientForProvider("direct", oauth);
		expect(factory).toHaveBeenCalledWith(oauth);
	});
});

describe("ProviderRegistry header references", () => {
	const env: Record<string, string> = { JWS_TOKEN: "jws-secret", CLIENT_ID: "private-client" };
	const lookup = (name: string) => env[name];

	it("expands references for fetchers and clients; templated User-Agent beats the default", async () => {
		const registry = new ProviderRegistry(logger);
		const fetcher = vi.fn(async (_credentials: ProviderCredentials) => []);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerModelFetcher("portkey", fetcher);
		registry.registerClientFactory("openai", factory);
		registry.setDefaultUserAgent("PositAssistant/1.0");
		registry.setHeaderReferenceLookup(lookup);

		await registry.getModelsForProvider("portkey", {
			type: "apikey",
			apiKey: "key",
			customHeaders: { "x-jws-token": "Bearer {env:JWS_TOKEN}", "x-tenant": "acme" },
		});
		registry.getClientForProviderOrKind(
			"custom",
			{ type: "apikey", apiKey: "key", customHeaders: { "User-Agent": "{env:CLIENT_ID}" } },
			"openai",
		);

		expect(fetcher).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: {
					"x-jws-token": "Bearer jws-secret",
					"x-tenant": "acme",
					"User-Agent": "PositAssistant/1.0",
				},
			}),
			undefined,
		);
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({ customHeaders: { "User-Agent": "private-client" } }),
		);
	});

	it("treats every reference as unavailable until a lookup is set", () => {
		const registry = new ProviderRegistry(logger);
		registry.registerClientFactory("portkey", () => client);
		vi.stubEnv("JWS_TOKEN", "ambient");
		try {
			expect(() =>
				registry.getClientForProvider("portkey", {
					type: "apikey",
					apiKey: "key",
					customHeaders: { "x-jws-token": "{env:JWS_TOKEN}" },
				}),
			).toThrow(/references JWS_TOKEN, which is not set/);
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("lists no models for a provider with an unavailable reference, leaving others intact", async () => {
		const warn = vi.fn();
		const registry = new ProviderRegistry({ ...logger, warn });
		const model = { id: "m" } as ModelInfo;
		const fetcher = vi.fn(async (_credentials: ProviderCredentials) => [model]);
		registry.registerModelFetcher("broken", fetcher);
		registry.registerModelFetcher("healthy", fetcher);
		registry.setHeaderReferenceLookup(lookup);

		const [broken, healthy] = await Promise.all([
			registry.discoverModels("broken", {
				type: "apikey",
				apiKey: "key",
				customHeaders: { "x-jws-token": "{env:MISSING}" },
			}),
			registry.discoverModels("healthy", { type: "apikey", apiKey: "key" }),
		]);

		expect(broken).toEqual({ models: [], credentialCheck: "unknown" });
		expect(healthy.models).toEqual([model]);
		expect(fetcher).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledExactlyOnceWith(
			'Not listing models for broken: Provider "broken": header "x-jws-token" references MISSING, which is not set.',
		);
	});
});

describe("ProviderRegistry.discoverModels credential check", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function stubFetch(status: number, body: unknown): void {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(JSON.stringify(body), { status })),
		);
	}

	it("reports unknown for a fetcher without discover", async () => {
		const registry = new ProviderRegistry(logger);
		const models: ModelInfo[] = [
			{
				id: "m",
				name: "m",
				providerId: "openai-compatible",
				vendor: "test",
				supportsTools: true,
				supportsImages: false,
				supportsToolResultImages: false,
				supportsWebSearch: false,
				maxContextLength: 1,
			},
		];
		registry.registerModelFetcher("plain", async () => models);

		expect(await registry.discoverModels("plain", { type: "apikey", apiKey: "key" })).toEqual({
			models,
			credentialCheck: "unknown",
		});
	});

	it("reports unknown for a keyless Anthropic 401, but rejected with a key", async () => {
		stubFetch(401, { error: { type: "authentication_error" } });
		const registry = new ProviderRegistry(logger);
		registerAnthropicProvider(registry, logger);

		const keyless = await registry.discoverModels("anthropic", { type: "apikey", apiKey: "" });
		expect(keyless).toEqual({ models: [], credentialCheck: "unknown" });
		const keyed = await registry.discoverModels("anthropic", { type: "apikey", apiKey: "bad" });
		expect(keyed.credentialCheck).toBe("rejected");
	});

	it("reports unknown for a gateway request from an untyped caller that omits apiKey", async () => {
		stubFetch(401, { error: { message: "missing key" } });
		const registry = new ProviderRegistry(logger);
		registerOpenAICompatibleProvider(registry, logger);
		// JSON.parse stands in for a loosely typed runtime caller.
		const untyped: ProviderCredentials = JSON.parse(
			'{ "type": "apikey", "baseUrl": "https://gateway.example/v1" }',
		);

		const result = await registry.discoverModels("openai-compatible", untyped);
		expect(result.credentialCheck).toBe("unknown");
	});

	it("classifies Gemini's 400 API_KEY_INVALID as rejected", async () => {
		stubFetch(400, {
			error: { code: 400, status: "INVALID_ARGUMENT", details: [{ reason: "API_KEY_INVALID" }] },
		});
		const registry = new ProviderRegistry(logger);
		registerGeminiProvider(registry, logger);

		const result = await registry.discoverModels("gemini", { type: "apikey", apiKey: "bad" });
		expect(result.credentialCheck).toBe("rejected");
		expect(result.models.length).toBeGreaterThan(0); // static fallback
	});

	it("does not treat Gemini's other 400s as a rejection", async () => {
		stubFetch(400, { error: { code: 400, status: "FAILED_PRECONDITION" } });
		const registry = new ProviderRegistry(logger);
		registerGeminiProvider(registry, logger);

		const result = await registry.discoverModels("gemini", { type: "apikey", apiKey: "key" });
		expect(result.credentialCheck).toBe("unknown");
	});
});
