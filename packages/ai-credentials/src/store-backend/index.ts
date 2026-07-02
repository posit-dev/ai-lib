/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-credentials/store-backend — Concrete store-backed credential backend.
 *
 * This entrypoint owns:
 * - `StoredProviderCredentials` type + tolerant Zod schema (disk format guard)
 * - Environment variable credential resolver + provider env mappings
 *
 * It imports `ai-credentials/types` (for ProviderCredentials) and
 * `ai-credentials/store` (for SingleFileStore) but does NOT import anything
 * from `@assistant/*`. This ensures standalone consumers (Notebooks) can
 * resolve credentials without depending on the assistant monorepo.
 *
 * The store-backed backend (store → env → null resolution, persisted → runtime
 * mapping, and the option-B OAuth hooks) is `createStoreBackend`.
 */

// Store-backed credential Backend
export { createStoreBackend } from "./StoreBackend";
export type { AuthMethodDescriptor, CreateStoreBackendOptions } from "./StoreBackend";

// StoredProviderCredentials — on-disk format + Zod schema
export {
	storedProviderCredentialsSchema,
	type StoredProviderCredentials,
	type StoredProviderCredentialsKeys,
} from "./StoredProviderCredentials";

// Environment variable credential resolver
export { hasEnvCredentials, resolveCredentialsFromEnv } from "./envCredentialResolver";

// Provider env mappings
export { PROVIDER_ENV_MAPPINGS, type ProviderEnvMapping } from "./providerEnvMappings";
