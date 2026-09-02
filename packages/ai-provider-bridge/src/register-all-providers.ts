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

import { registerAnthropicProvider } from "./providers/anthropic-provider";
import {
	registerBedrockProvider,
	type BedrockProviderCallbacks,
} from "./providers/bedrock-provider";
import {
	registerConnectProvider,
	type ConnectProviderCallbacks,
} from "./providers/connect-provider";
import { registerCopilotProvider } from "./providers/copilot-provider";
import { registerDatabricksProvider } from "./providers/databricks-provider";
import { registerDeepSeekProvider } from "./providers/deepseek-provider";
import { registerFoundryProvider } from "./providers/foundry-provider";
import { registerGeminiProvider } from "./providers/gemini-provider";
import {
	registerGoogleVertexProvider,
	type GoogleVertexProviderCallbacks,
} from "./providers/google-vertex-provider";
import { registerLitellmProvider } from "./providers/litellm-provider";
import { registerLMStudioProvider } from "./providers/lmstudio-provider";
import { registerOllamaProvider } from "./providers/ollama-provider";
import { registerOpenAICompatibleProvider } from "./providers/openai-compatible-provider";
import { registerOpenAIProvider } from "./providers/openai-provider";
import { registerOpenRouterProvider } from "./providers/openrouter-provider";
import { registerPortkeyProvider } from "./providers/portkey-provider";
import { registerPositAiProvider } from "./providers/positai-provider";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import {
	registerSnowflakeCortexProvider,
	type SnowflakeProviderCallbacks,
} from "./providers/snowflake-cortex-provider";
import { PROVIDER_IDS, type Logger, type ProviderId } from "./types";

export interface ProviderRegistrationConfig {
	/** Posit AI base URL, optionally resolved lazily when models are fetched. */
	positAiBaseUrl: string | (() => string);
	userAgent?: string;
	/** If set, only these providers register; an empty list registers none. */
	allowedProviders?: ProviderId[];
	/** Pre-built by the caller; the bridge never constructs host callbacks. */
	bedrockCallbacks?: BedrockProviderCallbacks;
	googleVertexCallbacks?: GoogleVertexProviderCallbacks;
	snowflakeCallbacks?: SnowflakeProviderCallbacks;
	connectCallbacks?: ConnectProviderCallbacks;
	/** Host-captured environment for SDK credential constructors after ambient scrubbing. */
	credentialEnvironment?: Readonly<Record<string, string | undefined>>;
}

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
 * Every provider's registration, keyed by the canonical ProviderId tuple. The `satisfies` check
 * makes missing or extra registrations a compile error, so this implementation detail does not
 * need to be exposed for a runtime shape test.
 */
const PROVIDER_REGISTRARS = {
	positai: (registry, logger, config) =>
		registerPositAiProvider(registry, config.positAiBaseUrl, config.userAgent, logger),
	bedrock: (registry, logger, config) =>
		registerBedrockProvider(registry, logger, config.bedrockCallbacks),
	"google-vertex": (registry, logger, config) =>
		registerGoogleVertexProvider(
			registry,
			logger,
			config.googleVertexCallbacks,
			config.credentialEnvironment,
		),
	anthropic: registerAnthropicProvider,
	copilot: registerCopilotProvider,
	openai: registerOpenAIProvider,
	openrouter: registerOpenRouterProvider,
	ollama: registerOllamaProvider,
	lmstudio: registerLMStudioProvider,
	gemini: registerGeminiProvider,
	"openai-compatible": registerOpenAICompatibleProvider,
	"ms-foundry": (registry, logger, config) =>
		registerFoundryProvider(registry, logger, config.credentialEnvironment),
	"snowflake-cortex": (registry, logger, config) =>
		registerSnowflakeCortexProvider(registry, logger, config.snowflakeCallbacks),
	deepseek: registerDeepSeekProvider,
	databricks: registerDatabricksProvider,
	litellm: registerLitellmProvider,
	portkey: registerPortkeyProvider,
	"posit-connect": (registry, logger, config) =>
		registerConnectProvider(registry, logger, config.connectCallbacks),
} satisfies Record<ProviderId, ProviderRegistrar>;

/**
 * Register every provider with the given registry, honoring `config.allowedProviders`.
 */
export function registerAllProviders(
	registry: ProviderRegistry,
	logger: Logger,
	config: ProviderRegistrationConfig,
): void {
	for (const id of PROVIDER_IDS) {
		if (!config.allowedProviders || config.allowedProviders.includes(id)) {
			PROVIDER_REGISTRARS[id](registry, logger, config);
		}
	}
}
