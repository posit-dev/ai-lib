/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Mappings — External Build Variant
 *
 * Same exports as providerEnvMappings.ts but only includes providers
 * available in external builds. External builds use Posit AI Pass only,
 * which has no secret env vars (OAuth tokens come from the auth flow), so
 * the registry is empty and capture/reader calls return empty results.
 *
 * External builds redirect to this file via bundler file-level aliasing.
 */

// Re-export types from the full registry (type-only imports are erased by TypeScript)
export type {
	CapturedProviderEnvironment,
	EnvironmentFieldDescriptor,
	ProviderEnvMapping,
	SdkCredentialEnvironment,
} from "./providerEnvMappings.js";
import type {
	CapturedProviderEnvironment,
	ProviderEnvMapping,
	SdkCredentialEnvironment,
} from "./providerEnvMappings.js";

export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {};

const EMPTY_NAMES: readonly string[] = Object.freeze([]);
const EMPTY_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({});

export function captureProviderEnvironment(
	_providerIds: readonly string[],
	_env: Readonly<Record<string, string | undefined>>,
): CapturedProviderEnvironment {
	return {
		declaredNames: EMPTY_NAMES,
		scrubbedNames: EMPTY_NAMES,
		environment: EMPTY_ENVIRONMENT,
	};
}

export function readSdkCredentialEnvironment(
	_env: Readonly<Record<string, string | undefined>>,
): SdkCredentialEnvironment {
	return {};
}
