/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub Copilot SDK Provider Registration
 *
 * Registers the `copilot` provider. Models are discovered at runtime via
 * CopilotClient.listModels() and mapped into the provider-bridge ModelInfo
 * shape, with a TTL cache so we don't re-spawn the CLI on every refresh.
 *
 * Auth: the credential's apiKey field holds the GitHub OAuth token. An empty or
 * missing apiKey causes the Copilot SDK to fall back to GitHub CLI stored auth.
 */

import { CopilotClient } from "@github/copilot-sdk";
import type { ModelInfo as CopilotModelInfo } from "@github/copilot-sdk";

import { startCopilotCliServer } from "../model-clients/copilot-cli-server";
import { CopilotSdkClient } from "../model-clients/CopilotSdkClient";
import type { ApiKeyCredentials, Logger, ModelInfo } from "../types";
import type { ProviderRegistry } from "./ProviderRegistry";

const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

function inferVendor(modelId: string): string {
	const id = modelId.toLowerCase();
	if (id.startsWith("claude-")) return "anthropic";
	if (id.startsWith("gemini-")) return "google";
	if (id.startsWith("grok-")) return "xai";
	return "openai";
}

function mapCopilotModel(model: CopilotModelInfo): ModelInfo {
	const limits = model.capabilities?.limits;
	const maxContextLength = limits?.max_context_window_tokens;
	const maxInputTokens = limits?.max_prompt_tokens ?? maxContextLength;
	const visionMediaTypes = limits?.vision?.supported_media_types;

	return {
		id: model.id,
		name: model.name,
		providerId: "copilot",
		vendor: inferVendor(model.id),
		maxInputTokens,
		supportsTools: true,
		supportsImages: model.capabilities?.supports?.vision ?? false,
		supportsToolResultImages: false,
		supportedInputMediaTypes: visionMediaTypes,
		supportsWebSearch: false,
		thinkingEffortLevels: model.supportedReasoningEfforts
			? [...model.supportedReasoningEfforts]
			: undefined,
		maxContextLength,
	};
}

export function registerCopilotProvider(registry: ProviderRegistry, logger: Logger): void {
	let cachedModels: ModelInfo[] | null = null;
	let lastFetch = 0;

	registry.registerModelFetcher("copilot", async (credentials) => {
		const now = Date.now();
		if (cachedModels && now - lastFetch < MODEL_CACHE_TTL_MS) {
			return cachedModels;
		}

		const token =
			credentials.type === "apikey" ? (credentials as ApiKeyCredentials).apiKey : undefined;

		// Spawn the CLI under real `node` and attach via cliUrl — the SDK's
		// default spawn path uses process.execPath, which is the Electron helper
		// binary in the extension host and breaks the CLI's commander parse.
		const cliServer = await startCopilotCliServer(token || undefined);
		const client = new CopilotClient({
			cliUrl: `localhost:${cliServer.port}`,
			logLevel: "warning",
		});

		try {
			await client.start();
			const sdkModels = await client.listModels();
			const models = sdkModels.filter((m) => m.policy?.state !== "disabled").map(mapCopilotModel);
			cachedModels = models;
			lastFetch = now;
			return models;
		} catch (error) {
			logger.warn(`[copilot] listModels failed: ${String(error)}`);
			return cachedModels ?? [];
		} finally {
			await client.stop().catch(() => {
				/* ignore stop errors — client may never have started */
			});
			await cliServer.dispose();
		}
	});

	// Single-slot cache. One Copilot CLI subprocess is spawned on first use and
	// shared across all Assistant conversations for the signed-in account; the
	// client routes chat() to a per-conversation SessionDriver internally.
	//
	// Token handling: the GitHub OAuth access token rotates via NodeAuthService's
	// automatic refresh. The CLI subprocess receives the token only at spawn (as
	// an env var) and manages its own refresh lifecycle thereafter — so a token
	// value change for the SAME signed-in account does NOT require rebuilding
	// the client. We only rebuild on a sign-in/sign-out transition (empty ↔
	// non-empty), which is the sole case the CLI can't absorb on its own.
	let cached: { token: string; client: CopilotSdkClient } | null = null;
	registry.registerClientFactory("copilot", (credentials) => {
		// ApiKeyCredentials.apiKey holds the GitHub OAuth token.
		// An empty string is treated as "no token" → SDK falls back to CLI auth.
		const token =
			credentials.type === "apikey" ? ((credentials as ApiKeyCredentials).apiKey ?? "") : "";

		if (!cached) {
			cached = { token, client: new CopilotSdkClient(token || undefined, logger) };
			return cached.client;
		}

		const wasAuthed = cached.token !== "";
		const isAuthed = token !== "";
		if (wasAuthed !== isAuthed) {
			const stale = cached.client;
			cached = { token, client: new CopilotSdkClient(token || undefined, logger) };
			void stale.dispose().catch(() => {
				/* best effort — stale auth anyway */
			});
			return cached.client;
		}

		// Same auth state (refreshed token, or unchanged token): reuse the client.
		cached.token = token;
		return cached.client;
	});
}
