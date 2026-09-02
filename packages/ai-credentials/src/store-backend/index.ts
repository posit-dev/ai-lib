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
 * It imports `ai-credentials/types` (for ProviderCredentials) but does NOT
 * import `ai-credentials/store` or anything from `@assistant/*` — storage is
 * injected as `StoreBackendStorage`, so the backend is agnostic to the
 * backing medium (file store, SecretStorage, …). This ensures standalone
 * consumers (Notebooks) can resolve credentials without depending on the
 * assistant monorepo.
 *
 * The store-backed backend (store → env → null resolution, persisted → runtime
 * mapping, and the option-B OAuth hooks) is `createStoreBackend`.
 */

// Store-backed credential Backend
export { createStoreBackend } from "./StoreBackend.js";
export type {
	AuthMethodDescriptor,
	CreateStoreBackendOptions,
	StoreBackendStorage,
} from "./StoreBackend.js";

// StoredProviderCredentials — on-disk format + Zod schema
export {
	storedProviderCredentialsSchema,
	type StoredProviderCredentials,
	type StoredProviderCredentialsKeys,
} from "./StoredProviderCredentials.js";

// Environment variable credential resolver
export { hasEnvCredentials, resolveCredentialsFromEnv } from "./envCredentialResolver.js";

// Provider env mappings
export {
	captureProviderEnvironment,
	PROVIDER_ENV_MAPPINGS,
	type CapturedProviderEnvironment,
	type ProviderEnvMapping,
} from "./providerEnvMappings.js";
