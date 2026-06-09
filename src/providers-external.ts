/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * External-build provider entry point.
 *
 * Exports the same API surface as `providers.ts` but only includes the
 * Posit AI provider. Consuming packages swap to this module at build time
 * via bundler aliasing so that non-positai provider code (and its heavy
 * SDK dependencies) is excluded from the output bundle entirely.
 *
 * SYNC NOTE: If you change the exports in providers.ts, update here too.
 */

import { registerPositAiProvider } from "./providers/positai-provider";

// Provider endpoint testing — included in external builds (no provider-specific deps)
export {
	testLMStudioProvider,
	testLocalProvider,
	testOllamaProvider,
	testOpenAICompatibleProvider,
} from "./providers/provider-test";

// Provider registration orchestrator
export { registerAllProviders } from "./register-all-providers-external";
export type { ProviderRegistrationConfig } from "./register-all-providers-external";

export { registerPositAiProvider };
