/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Registry — External Build Variant
 *
 * Empty registry for external builds, which use Posit AI Pass only and have
 * no secret env vars (OAuth tokens come from the auth flow). External builds
 * redirect `providerEnvRegistry.ts` to this file via bundler file-level
 * aliasing; the capture/reader/resolver implementation in
 * `providerEnvMappings.ts` is shared by both builds, so an empty registry
 * simply yields empty captures and no env-resolved credentials.
 */

import type { ProviderEnvMapping } from "./providerEnvMappings.js";

export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {};
