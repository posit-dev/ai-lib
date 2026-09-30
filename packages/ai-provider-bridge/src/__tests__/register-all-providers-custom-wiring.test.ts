/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	mintCustomProviderId,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
	type SupportedCustomClientKind,
} from "ai-config";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../providers/ProviderRegistry";
import { registerAllProviders } from "../register-all-providers";
import type { Logger } from "../types";

const mocks = vi.hoisted(() => ({
	registerCustomAnthropicProvider: vi.fn(),
	registerCustomBedrockProvider: vi.fn(),
	registerCustomDeepSeekProvider: vi.fn(),
	registerCustomFoundryProvider: vi.fn(),
	registerCustomGeminiProvider: vi.fn(),
	registerCustomGoogleVertexProvider: vi.fn(),
	registerCustomLitellmProvider: vi.fn(),
	registerCustomLMStudioProvider: vi.fn(),
	registerCustomOllamaProvider: vi.fn(),
	registerCustomOpenAICompatibleProvider: vi.fn(),
	registerCustomOpenAIProvider: vi.fn(),
	registerCustomOpenRouterProvider: vi.fn(),
	registerCustomPortkeyProvider: vi.fn(),
	registerCustomSnowflakeProvider: vi.fn(),
}));

vi.mock("../providers/anthropic-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/anthropic-provider")>()),
	registerCustomAnthropicProvider: mocks.registerCustomAnthropicProvider,
}));
vi.mock("../providers/bedrock-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/bedrock-provider")>()),
	registerCustomBedrockProvider: mocks.registerCustomBedrockProvider,
}));
vi.mock("../providers/deepseek-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/deepseek-provider")>()),
	registerCustomDeepSeekProvider: mocks.registerCustomDeepSeekProvider,
}));
vi.mock("../providers/foundry-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/foundry-provider")>()),
	registerCustomFoundryProvider: mocks.registerCustomFoundryProvider,
}));
vi.mock("../providers/gemini-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/gemini-provider")>()),
	registerCustomGeminiProvider: mocks.registerCustomGeminiProvider,
}));
vi.mock("../providers/google-vertex-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/google-vertex-provider")>()),
	registerCustomGoogleVertexProvider: mocks.registerCustomGoogleVertexProvider,
}));
vi.mock("../providers/litellm-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/litellm-provider")>()),
	registerCustomLitellmProvider: mocks.registerCustomLitellmProvider,
}));
vi.mock("../providers/lmstudio-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/lmstudio-provider")>()),
	registerCustomLMStudioProvider: mocks.registerCustomLMStudioProvider,
}));
vi.mock("../providers/ollama-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/ollama-provider")>()),
	registerCustomOllamaProvider: mocks.registerCustomOllamaProvider,
}));
vi.mock("../providers/openai-compatible-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/openai-compatible-provider")>()),
	registerCustomOpenAICompatibleProvider: mocks.registerCustomOpenAICompatibleProvider,
}));
vi.mock("../providers/openai-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/openai-provider")>()),
	registerCustomOpenAIProvider: mocks.registerCustomOpenAIProvider,
}));
vi.mock("../providers/openrouter-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/openrouter-provider")>()),
	registerCustomOpenRouterProvider: mocks.registerCustomOpenRouterProvider,
}));
vi.mock("../providers/portkey-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/portkey-provider")>()),
	registerCustomPortkeyProvider: mocks.registerCustomPortkeyProvider,
}));
vi.mock("../providers/snowflake-cortex-provider", async (importActual) => ({
	...(await importActual<typeof import("../providers/snowflake-cortex-provider")>()),
	registerCustomSnowflakeProvider: mocks.registerCustomSnowflakeProvider,
}));

type RegistrarMock = typeof mocks.registerCustomOpenAICompatibleProvider;

// Keep this table exhaustive: adding a SupportedCustomClientKind requires an
// explicit dispatch expectation here as well as in the registrar table.
const customRegistrarByKind = {
	"openai-compatible": mocks.registerCustomOpenAICompatibleProvider,
	anthropic: mocks.registerCustomAnthropicProvider,
	openai: mocks.registerCustomOpenAIProvider,
	gemini: mocks.registerCustomGeminiProvider,
	aws: mocks.registerCustomBedrockProvider,
	snowflake: mocks.registerCustomSnowflakeProvider,
	"google-vertex": mocks.registerCustomGoogleVertexProvider,
	ollama: mocks.registerCustomOllamaProvider,
	lmstudio: mocks.registerCustomLMStudioProvider,
	deepseek: mocks.registerCustomDeepSeekProvider,
	openrouter: mocks.registerCustomOpenRouterProvider,
	"ms-foundry": mocks.registerCustomFoundryProvider,
	litellm: mocks.registerCustomLitellmProvider,
	portkey: mocks.registerCustomPortkeyProvider,
} satisfies Record<SupportedCustomClientKind, RegistrarMock>;

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

describe("registerAllProviders custom-entry wiring", () => {
	let log: Logger;
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		log = logger();
		registry = new ProviderRegistry(log);
	});

	it.each(SUPPORTED_CUSTOM_CLIENT_KIND_VALUES)(
		"dispatches supported custom client kind %s to its provider-owned registrar",
		(clientKind) => {
			const id = mintCustomProviderId(`matrix-${clientKind}`);

			registerAllProviders(registry, log, {
				positAiBaseUrl: "https://posit.example.com",
				allowedProviders: [],
				customProviders: [{ id, clientKind }],
			});

			const registrar = customRegistrarByKind[clientKind];
			if (clientKind === "google-vertex") {
				// Callbacks, then the captured credential environment.
				expect(registrar).toHaveBeenCalledExactlyOnceWith(registry, id, log, undefined, undefined);
			} else if (
				clientKind === "aws" ||
				clientKind === "snowflake" ||
				clientKind === "ms-foundry"
			) {
				expect(registrar).toHaveBeenCalledExactlyOnceWith(registry, id, log, undefined);
			} else {
				expect(registrar).toHaveBeenCalledExactlyOnceWith(registry, id, log);
			}
		},
	);

	it("threads callbacks into custom AWS, Vertex, and Snowflake registrars", () => {
		const bedrockCallbacks = { onProviderStatusChange: vi.fn() };
		const googleVertexCallbacks = { onProviderStatusChange: vi.fn() };
		const snowflakeCallbacks = { reauthenticateSession: vi.fn() };
		const credentialEnvironment = { GOOGLE_CLOUD_PROJECT: "sentinel-project" };
		const awsId = mintCustomProviderId("acme-aws");
		const vertexId = mintCustomProviderId("acme-vertex");
		const snowflakeId = mintCustomProviderId("acme-snowflake");
		const foundryId = mintCustomProviderId("acme-foundry");

		registerAllProviders(registry, log, {
			positAiBaseUrl: "https://posit.example.com",
			allowedProviders: [],
			bedrockCallbacks,
			googleVertexCallbacks,
			snowflakeCallbacks,
			credentialEnvironment,
			customProviders: [
				{ id: awsId, clientKind: "aws" },
				{ id: vertexId, clientKind: "google-vertex" },
				{ id: snowflakeId, clientKind: "snowflake" },
				{ id: foundryId, clientKind: "ms-foundry" },
			],
		});

		expect(mocks.registerCustomBedrockProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			awsId,
			log,
			bedrockCallbacks,
		);
		expect(mocks.registerCustomGoogleVertexProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			vertexId,
			log,
			googleVertexCallbacks,
			credentialEnvironment,
		);
		expect(mocks.registerCustomSnowflakeProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			snowflakeId,
			log,
			snowflakeCallbacks,
		);
		// The captured environment must also reach custom Foundry registrations —
		// a dropped argument here only surfaces as lazy post-scrub auth failures.
		expect(mocks.registerCustomFoundryProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			foundryId,
			log,
			credentialEnvironment,
		);
	});
});
