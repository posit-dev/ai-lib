/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider registration orchestrator
 *
 * Centralizes the "register every provider into a ProviderRegistry" loop that
 * downstream consumers would otherwise hand-roll. The caller owns the registry's
 * lifecycle and passes it in.
 */

import {
	isProviderAllowed,
	type ProviderRegistrationConfig,
	type RegisterAllProviders,
} from "./provider-registration";
import { registerAnthropicProvider } from "./providers/anthropic-provider";
import { registerBedrockProvider } from "./providers/bedrock-provider";
import { registerCopilotProvider } from "./providers/copilot-provider";
import { registerDeepSeekProvider } from "./providers/deepseek-provider";
import { registerFoundryProvider } from "./providers/foundry-provider";
import { registerGeminiProvider } from "./providers/gemini-provider";
import { registerGoogleVertexProvider } from "./providers/google-vertex-provider";
import { registerLMStudioProvider } from "./providers/lmstudio-provider";
import { registerOllamaProvider } from "./providers/ollama-provider";
import { registerOpenAICompatibleProvider } from "./providers/openai-compatible-provider";
import { registerOpenAIProvider } from "./providers/openai-provider";
import { registerOpenRouterProvider } from "./providers/openrouter-provider";
import { registerPositAiProvider } from "./providers/positai-provider";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import { registerSnowflakeCortexProvider } from "./providers/snowflake-cortex-provider";
import type { Logger, ProviderId } from "./types";

// Re-export the shared config so the `providers.ts` barrel keeps resolving it from here.
export type { ProviderRegistrationConfig } from "./provider-registration";

/**
 * One provider's registration. Receives the caller's registry/logger plus the full config so
 * each entry pulls whatever it needs (base URL, callbacks) without the orchestrator
 * special-casing it. Providers that ignore the config satisfy this with their plain
 * `(registry, logger)` signature (the trailing `config` arg is simply unused).
 */
type ProviderRegistrar = (
	registry: ProviderRegistry,
	logger: Logger,
	config: ProviderRegistrationConfig,
) => void;

/**
 * Every provider's registration, paired with its ProviderId. Exported so a test can assert the
 * id set equals PROVIDER_IDS (the single source of truth): a mislabeled, duplicated, or missing
 * id here would silently corrupt `allowedProviders` filtering, which keys on these labels.
 *
 * Only positai/bedrock/google-vertex need a wrapper to thread config into a non-uniform
 * signature; the rest reference their `(registry, logger)` register fn directly.
 */
export const PROVIDER_REGISTRARS: readonly [ProviderId, ProviderRegistrar][] = [
	[
		"positai",
		(registry, logger, config) =>
			registerPositAiProvider(registry, config.positAiBaseUrl, config.userAgent, logger),
	],
	[
		"bedrock",
		(registry, logger, config) =>
			registerBedrockProvider(registry, logger, config.bedrockCallbacks),
	],
	[
		"google-vertex",
		(registry, logger, config) =>
			registerGoogleVertexProvider(registry, logger, config.googleVertexCallbacks),
	],
	["anthropic", registerAnthropicProvider],
	["copilot", registerCopilotProvider],
	["openai", registerOpenAIProvider],
	["openrouter", registerOpenRouterProvider],
	["ollama", registerOllamaProvider],
	["lmstudio", registerLMStudioProvider],
	["gemini", registerGeminiProvider],
	["openai-compatible", registerOpenAICompatibleProvider],
	["ms-foundry", registerFoundryProvider],
	["snowflake-cortex", registerSnowflakeCortexProvider],
	["deepseek", registerDeepSeekProvider],
];

/**
 * Register every provider with the given registry, honoring `config.allowedProviders`.
 */
export const registerAllProviders: RegisterAllProviders = (registry, logger, config) => {
	for (const [id, register] of PROVIDER_REGISTRARS) {
		if (isProviderAllowed(id, config.allowedProviders)) {
			register(registry, logger, config);
		}
	}
};
