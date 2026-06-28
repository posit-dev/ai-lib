/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// ai-provider-bridge/positron -- VS Code extensions (requires vscode)
//
// PROVIDER_MAP and MAPPED_PROVIDER_IDS are exported from the main entrypoint
// (ai-provider-bridge) since they have no vscode dependency.

// Auth adapter
export { createVscodeCredentialConfig, PositronCredentialProvider } from "./auth";
export { CONFIG_KEY_OVERRIDES } from "../credential-shaping";
export type { CredentialConfig } from "../credential-shaping";

// VS Code LM client (ModelClient implementation wrapping vscode.lm)
export { VscodeLmClient } from "./VscodeLmClient";
export type { TokenUsage, VscodeLmClientOptions } from "./VscodeLmClient";

// VS Code LM model discovery
export { isProviderId, listVscodeLmModels, toProviderId } from "./vscode-lm-models";
export type { ListVscodeLmModelsOptions } from "./vscode-lm-models";

// VS Code LM ↔ AI SDK message conversion (AI SDK → VS Code direction)
export {
	fromAiMessages2,
	hasAnthropicCacheControl,
	setAnthropicCacheControl,
} from "./message-formats";
export type { FromAiMessagesOptions } from "./message-formats";

// VS Code Language Model part helpers
export {
	cacheBreakpointPart,
	isCacheBreakpointPart,
	isLanguageModelDataPart,
	isLanguageModelTextPart,
	isLanguageModelToolCallPart,
	isLanguageModelToolResultPart,
} from "./lm-helpers";

// Binary data normalization
export { ensureUint8Array } from "./utils";
