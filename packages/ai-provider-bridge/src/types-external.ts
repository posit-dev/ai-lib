/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider-Bridge Types — External Build Variant
 *
 * Same exports as types.ts but only includes the positai provider in
 * PROVIDER_IDS. External builds redirect to this file via bundler
 * file-level aliasing so that non-positai provider metadata is excluded
 * from the output bundle entirely.
 *
 * All *types* are re-exported unchanged from the full types.ts (type-only
 * imports are erased by TypeScript). Only runtime values are narrowed.
 *
 * SYNC NOTE: The positai entry is duplicated from types.ts.
 * If you modify it here, make the same change there.
 */

// Re-export all types unchanged (type-only imports are erased)
export type {
	AiToolWithJsonSchema,
	ApiKeyCredentials,
	AwsCredentials,
	CancellationToken,
	Event,
	GoogleCloudCredentials,
	LegacyProtocol,
	LMStreamPart,
	LocalCredentials,
	Logger,
	ModelInfo,
	NotificationActionId,
	OAuthCredentials,
	PositAiAuthMetadata,
	PositAiModelFetchState,
	Protocol,
	ProviderId,
	ProviderCredentials,
	ResolvedProviderId,
} from "./types";

// Runtime re-exports
export { normalizeProtocol } from "./types";

/**
 * Provider IDs — external builds only include positai.
 */
export const PROVIDER_IDS = ["positai"] as const;

export const NOTIFICATION_ACTIONS = {
	REFRESH_MODELS: "refresh-models",
	POSIT_AI_MANAGE_ACCOUNT: "posit-ai-manage-account",
	POSIT_AI_COMPLETE_SETUP: "posit-ai-complete-setup",
} as const;
