/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../providers/ProviderRegistry";
import { PROVIDER_IDS } from "../types";
import type { Logger } from "../types";

// Mock every provider module so the register functions are spies and no SDK code loads.
vi.mock("../providers/positai-provider", () => ({ registerPositAiProvider: vi.fn() }));
vi.mock("../providers/anthropic-provider", () => ({ registerAnthropicProvider: vi.fn() }));
vi.mock("../providers/copilot-provider", () => ({ registerCopilotProvider: vi.fn() }));
vi.mock("../providers/openai-provider", () => ({ registerOpenAIProvider: vi.fn() }));
vi.mock("../providers/openrouter-provider", () => ({ registerOpenRouterProvider: vi.fn() }));
vi.mock("../providers/ollama-provider", () => ({ registerOllamaProvider: vi.fn() }));
vi.mock("../providers/lmstudio-provider", () => ({ registerLMStudioProvider: vi.fn() }));
vi.mock("../providers/bedrock-provider", () => ({ registerBedrockProvider: vi.fn() }));
vi.mock("../providers/gemini-provider", () => ({ registerGeminiProvider: vi.fn() }));
vi.mock("../providers/google-vertex-provider", () => ({ registerGoogleVertexProvider: vi.fn() }));
vi.mock("../providers/openai-compatible-provider", () => ({
	registerOpenAICompatibleProvider: vi.fn(),
}));
vi.mock("../providers/foundry-provider", () => ({ registerFoundryProvider: vi.fn() }));
vi.mock("../providers/snowflake-cortex-provider", () => ({
	registerSnowflakeCortexProvider: vi.fn(),
}));
vi.mock("../providers/deepseek-provider", () => ({ registerDeepSeekProvider: vi.fn() }));
vi.mock("../providers/databricks-provider", () => ({ registerDatabricksProvider: vi.fn() }));

import { registerAnthropicProvider } from "../providers/anthropic-provider";
import { registerBedrockProvider } from "../providers/bedrock-provider";
import { registerCopilotProvider } from "../providers/copilot-provider";
import { registerDatabricksProvider } from "../providers/databricks-provider";
import { registerDeepSeekProvider } from "../providers/deepseek-provider";
import { registerFoundryProvider } from "../providers/foundry-provider";
import { registerGeminiProvider } from "../providers/gemini-provider";
import { registerGoogleVertexProvider } from "../providers/google-vertex-provider";
import { registerLMStudioProvider } from "../providers/lmstudio-provider";
import { registerOllamaProvider } from "../providers/ollama-provider";
import { registerOpenAICompatibleProvider } from "../providers/openai-compatible-provider";
import { registerOpenAIProvider } from "../providers/openai-provider";
import { registerOpenRouterProvider } from "../providers/openrouter-provider";
import { registerPositAiProvider } from "../providers/positai-provider";
import { registerSnowflakeCortexProvider } from "../providers/snowflake-cortex-provider";
import { PROVIDER_REGISTRARS, registerAllProviders } from "../register-all-providers";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const BASE_URL = "https://posit.example.com/v1";
const USER_AGENT = "Test Agent/1.0";

const allRegisterFns = [
	registerPositAiProvider,
	registerAnthropicProvider,
	registerCopilotProvider,
	registerOpenAIProvider,
	registerOpenRouterProvider,
	registerOllamaProvider,
	registerLMStudioProvider,
	registerBedrockProvider,
	registerGeminiProvider,
	registerGoogleVertexProvider,
	registerOpenAICompatibleProvider,
	registerFoundryProvider,
	registerSnowflakeCortexProvider,
	registerDeepSeekProvider,
	registerDatabricksProvider,
];

describe("registerAllProviders (internal)", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
	});

	it("has a registrar for exactly the PROVIDER_IDS set", () => {
		// The orchestrator filters on these ids (isAllowed keys on them), so a wrong/duplicate/
		// missing id silently corrupts allowedProviders. Tie the labels to PROVIDER_IDS, not just
		// the count.
		const ids = PROVIDER_REGISTRARS.map(([id]) => id);
		expect(ids).toHaveLength(PROVIDER_IDS.length);
		expect(new Set(ids)).toEqual(new Set(PROVIDER_IDS));
	});

	it("registers every provider when allowedProviders is omitted", () => {
		registerAllProviders(registry, mockLogger, { positAiBaseUrl: BASE_URL, userAgent: USER_AGENT });

		// Tie the count to PROVIDER_IDS (the source of truth) so a provider added there
		// but forgotten in the orchestrator is caught.
		expect(allRegisterFns).toHaveLength(PROVIDER_IDS.length);
		for (const fn of allRegisterFns) {
			expect(fn).toHaveBeenCalledTimes(1);
		}

		// When no callbacks are configured, the bridge forwards `undefined` -- it must never
		// construct callbacks itself (see ProviderRegistrationConfig docs).
		expect(registerBedrockProvider).toHaveBeenCalledWith(registry, mockLogger, undefined);
		expect(registerGoogleVertexProvider).toHaveBeenCalledWith(registry, mockLogger, undefined);
	});

	it("registers nothing when allowedProviders is empty", () => {
		registerAllProviders(registry, mockLogger, { positAiBaseUrl: BASE_URL, allowedProviders: [] });

		for (const fn of allRegisterFns) {
			expect(fn).not.toHaveBeenCalled();
		}
	});

	it("registers only the allowed providers", () => {
		registerAllProviders(registry, mockLogger, {
			positAiBaseUrl: BASE_URL,
			allowedProviders: ["positai", "anthropic"],
		});

		expect(registerPositAiProvider).toHaveBeenCalledTimes(1);
		expect(registerAnthropicProvider).toHaveBeenCalledTimes(1);
		expect(registerOpenAIProvider).not.toHaveBeenCalled();
		expect(registerBedrockProvider).not.toHaveBeenCalled();
		expect(registerGoogleVertexProvider).not.toHaveBeenCalled();
		expect(registerDeepSeekProvider).not.toHaveBeenCalled();
	});

	it("forwards bedrock and google-vertex callbacks", () => {
		const bedrockCallbacks = { onProviderStatusChange: vi.fn().mockResolvedValue(undefined) };
		const googleVertexCallbacks = { onProviderStatusChange: vi.fn().mockResolvedValue(undefined) };

		registerAllProviders(registry, mockLogger, {
			positAiBaseUrl: BASE_URL,
			bedrockCallbacks,
			googleVertexCallbacks,
		});

		expect(registerBedrockProvider).toHaveBeenCalledWith(registry, mockLogger, bedrockCallbacks);
		expect(registerGoogleVertexProvider).toHaveBeenCalledWith(
			registry,
			mockLogger,
			googleVertexCallbacks,
		);
	});

	it("passes positai base URL, user agent, and logger in order", () => {
		registerAllProviders(registry, mockLogger, { positAiBaseUrl: BASE_URL, userAgent: USER_AGENT });

		expect(registerPositAiProvider).toHaveBeenCalledWith(
			registry,
			BASE_URL,
			USER_AGENT,
			mockLogger,
		);
	});

	it("forwards a function-form positAiBaseUrl unchanged (not snapshotted)", () => {
		// Positron passes a getter so the base URL setting is read lazily at fetch time. The
		// orchestrator must forward the function itself, not call it and snapshot the result.
		const baseUrlGetter = () => BASE_URL;

		registerAllProviders(registry, mockLogger, { positAiBaseUrl: baseUrlGetter });

		expect(registerPositAiProvider).toHaveBeenCalledWith(
			registry,
			baseUrlGetter,
			undefined,
			mockLogger,
		);
	});
});
