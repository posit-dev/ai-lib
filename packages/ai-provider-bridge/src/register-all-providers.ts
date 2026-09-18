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

import type { ResolvedProviderId, SupportedCustomClientKind } from "ai-config";

import {
	registerAnthropicProvider,
	registerCustomAnthropicProvider,
} from "./providers/anthropic-provider";
import {
	registerBedrockProvider,
	registerCustomBedrockProvider,
	type BedrockProviderCallbacks,
} from "./providers/bedrock-provider";
import {
	registerConnectProvider,
	type ConnectProviderCallbacks,
} from "./providers/connect-provider";
import { registerCopilotProvider } from "./providers/copilot-provider";
import { registerDatabricksProvider } from "./providers/databricks-provider";
import {
	registerCustomDeepSeekProvider,
	registerDeepSeekProvider,
} from "./providers/deepseek-provider";
import {
	registerCustomFoundryProvider,
	registerFoundryProvider,
} from "./providers/foundry-provider";
import { registerCustomGeminiProvider, registerGeminiProvider } from "./providers/gemini-provider";
import {
	registerCustomGoogleVertexProvider,
	registerGoogleVertexProvider,
	type GoogleVertexProviderCallbacks,
} from "./providers/google-vertex-provider";
import {
	registerCustomLitellmProvider,
	registerLitellmProvider,
} from "./providers/litellm-provider";
import {
	registerCustomLMStudioProvider,
	registerLMStudioProvider,
} from "./providers/lmstudio-provider";
import { registerCustomOllamaProvider, registerOllamaProvider } from "./providers/ollama-provider";
import {
	registerCustomOpenAICompatibleProvider,
	registerOpenAICompatibleProvider,
} from "./providers/openai-compatible-provider";
import { registerCustomOpenAIProvider, registerOpenAIProvider } from "./providers/openai-provider";
import {
	registerCustomOpenRouterProvider,
	registerOpenRouterProvider,
} from "./providers/openrouter-provider";
import {
	registerCustomPortkeyProvider,
	registerPortkeyProvider,
} from "./providers/portkey-provider";
import { registerPositAiProvider } from "./providers/positai-provider";
import type { ProviderRegistry } from "./providers/ProviderRegistry";
import {
	registerCustomSnowflakeProvider,
	registerSnowflakeCortexProvider,
	type SnowflakeProviderCallbacks,
} from "./providers/snowflake-cortex-provider";
import { PROVIDER_IDS, type Logger, type ProviderId } from "./types";

export interface ProviderRegistrationConfig {
	/** Posit AI Pass base URL, optionally resolved lazily when models are fetched. */
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
	/** `providers.custom` entries to register after the built-ins; independent of `allowedProviders`. */
	customProviders?: ReadonlyArray<{ readonly id: ResolvedProviderId; readonly clientKind: string }>;
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

type CustomProviderRegistrar = (
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
	config: ProviderRegistrationConfig,
) => void;

/** One registrar per supported custom kind; each reads its callbacks from the same config the built-ins use. */
const CUSTOM_PROVIDER_REGISTRARS = {
	"openai-compatible": (registry, id, logger) =>
		registerCustomOpenAICompatibleProvider(registry, id, logger),
	anthropic: (registry, id, logger) => registerCustomAnthropicProvider(registry, id, logger),
	openai: (registry, id, logger) => registerCustomOpenAIProvider(registry, id, logger),
	gemini: (registry, id, logger) => registerCustomGeminiProvider(registry, id, logger),
	aws: (registry, id, logger, config) =>
		registerCustomBedrockProvider(registry, id, logger, config.bedrockCallbacks),
	snowflake: (registry, id, logger, config) =>
		registerCustomSnowflakeProvider(registry, id, logger, config.snowflakeCallbacks),
	"google-vertex": (registry, id, logger, config) =>
		registerCustomGoogleVertexProvider(
			registry,
			id,
			logger,
			config.googleVertexCallbacks,
			config.credentialEnvironment,
		),
	ollama: (registry, id, logger) => registerCustomOllamaProvider(registry, id, logger),
	lmstudio: (registry, id, logger) => registerCustomLMStudioProvider(registry, id, logger),
	deepseek: (registry, id, logger) => registerCustomDeepSeekProvider(registry, id, logger),
	openrouter: (registry, id, logger) => registerCustomOpenRouterProvider(registry, id, logger),
	"ms-foundry": (registry, id, logger, config) =>
		registerCustomFoundryProvider(registry, id, logger, config.credentialEnvironment),
	litellm: (registry, id, logger) => registerCustomLitellmProvider(registry, id, logger),
	portkey: (registry, id, logger) => registerCustomPortkeyProvider(registry, id, logger),
} satisfies Record<SupportedCustomClientKind, CustomProviderRegistrar>;

/**
 * Register every provider with the given registry, honoring `config.allowedProviders`.
 *
 * `config.customProviders` entries register after the built-ins, are not
 * filtered by `allowedProviders`, and are looked up through
 * `ProviderRegistry.getClientForProviderOrKind` because their client
 * factories are keyed by kind.
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

	for (const { id, clientKind } of config.customProviders ?? []) {
		const registrar = (
			CUSTOM_PROVIDER_REGISTRARS as Partial<Record<string, CustomProviderRegistrar>>
		)[clientKind];
		if (!registrar) {
			throw new Error(`Unsupported custom provider kind: ${clientKind}`);
		}
		registrar(registry, id, logger, config);
		logger.debug(
			`[registerAllProviders] Registered ${clientKind} support for custom provider "${id}"`,
		);
	}
}
