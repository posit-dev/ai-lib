/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Mappings — External Build Variant
 *
 * Same exports as providerEnvMappings.ts but only includes providers
 * available in external builds. External builds use Posit AI only,
 * which has no secret env vars (OAuth tokens come from the auth flow).
 *
 * External builds redirect to this file via bundler file-level aliasing.
 */

// Re-export types from the full registry (type-only imports are erased by TypeScript)
export type { ProviderEnvMapping } from "./providerEnvMappings.js";
import type { ProviderEnvMapping } from "./providerEnvMappings.js";

export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {};
