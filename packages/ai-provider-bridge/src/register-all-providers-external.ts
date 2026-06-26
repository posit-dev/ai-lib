/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider registration orchestrator (External Build Variant)
 *
 * Same API surface as register-all-providers.ts but only registers the Posit AI provider.
 * Consuming packages swap to this module at build time via bundler aliasing (through
 * providers-external.ts) so that non-positai provider code (and its heavy SDK dependencies)
 * is excluded from the output bundle entirely.
 *
 * SYNC NOTE: Both variants share the contract in provider-registration.ts. This file does NOT
 * import register-all-providers.ts -- that is what keeps the non-positai providers and their
 * SDKs out of the external bundle. Annotating the export with the shared `RegisterAllProviders`
 * type keeps this signature in lock-step with the internal variant.
 */

import { isProviderAllowed, type RegisterAllProviders } from "./provider-registration";
import { registerPositAiProvider } from "./providers/positai-provider";

// Re-export the shared config so the `providers-external.ts` barrel keeps resolving it from here.
export type { ProviderRegistrationConfig } from "./provider-registration";

/**
 * Register every provider with the given registry, honoring `config.allowedProviders`.
 *
 * External builds only ship the Posit AI provider; the callback fields are ignored.
 */
export const registerAllProviders: RegisterAllProviders = (registry, logger, config) => {
	if (isProviderAllowed("positai", config.allowedProviders)) {
		registerPositAiProvider(registry, config.positAiBaseUrl, config.userAgent, logger);
	}
};
