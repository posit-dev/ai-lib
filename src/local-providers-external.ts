/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * External Build Stub: local-providers
 *
 * External builds (Posit AI only) exclude Ollama and LM Studio.
 * This stub exports empty constants and a no-op LocalProviderManager so that
 * imports of local-providers still resolve at runtime without including any
 * local-provider functionality.
 *
 * SYNC NOTE: The public API surface must remain identical to local-providers.ts.
 * If you add methods to LocalProviderManager, add no-op versions here too.
 */

// Re-export types from the full registry (type-only imports are erased by TypeScript)
// These imports/exports from local-providers.ts are necessary to maintain the
// same public API shape between the full and external registry variants, but
// they MUST only contain types so that they don't bring in local provider
// code into the external bundles.
export type { Disposable, LocalProviderManagerOptions } from "./local-providers";
import type { Disposable, LocalProviderManagerOptions } from "./local-providers";

export const LOCAL_PROVIDER_IDS: readonly never[] = [] as const;

export type LocalProviderId = never;

export function isLocalProviderId(_providerId: string): _providerId is LocalProviderId {
	return false;
}

export class LocalProviderManager {
	constructor(_options: LocalProviderManagerOptions) {}
	async initialize(): Promise<void> {}
	getEndpoint(_providerId: LocalProviderId): string | undefined {
		return undefined;
	}
	async setEndpoint(_providerId: LocalProviderId, _endpoint: string): Promise<void> {}
	async clearEndpoint(_providerId: LocalProviderId): Promise<void> {}
	isEnabled(): boolean {
		return false;
	}
	onDidChange(_callback: (providerIds: LocalProviderId[]) => void): Disposable {
		return { dispose: () => {} };
	}
	dispose(): void {}
}
