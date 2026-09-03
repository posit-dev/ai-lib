/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Mappings
 *
 * The single implementation driven by the declared provider environment
 * (`PROVIDER_ENV_MAPPINGS`, re-exported here). Each declared field is an
 * `EnvironmentFieldDescriptor` carrying the wire name and its scrub policy,
 * and that one declaration drives:
 *
 * - env credential resolution (`envCredentialResolver`)
 * - host environment capture and scrub partitions (`captureProviderEnvironment`)
 * - typed SDK credential construction (`readSdkCredentialEnvironment`,
 *   consumed by ai-provider-bridge's Azure/Vertex credential constructors)
 *
 * The registry data lives in `providerEnvRegistry.ts`; external builds alias
 * that module to an empty registry, so this implementation is shared by both
 * builds. Non-secret connection config (baseUrl, endpoint, oauth, googleCloud)
 * is handled by ai-config's CONNECTION_ENV_MAPPINGS in the catalog builder.
 *
 * Moved from @assistant/node so that ai-credentials/store-backend can resolve
 * credentials without importing @assistant/*.
 */

import { PROVIDER_ENV_MAPPINGS } from "./providerEnvRegistry.js";

export { PROVIDER_ENV_MAPPINGS };

/**
 * One environment variable a provider reads, with its scrub policy.
 */
export interface EnvironmentFieldDescriptor {
	/** The environment variable name. */
	readonly name: string;
	/**
	 * true: captured AND deleted from the ambient environment by the host.
	 * false: captured only — the value stays ambient (non-secret support
	 * values such as AZURE_TENANT_ID that user code may legitimately read).
	 */
	readonly scrub: boolean;
}

/**
 * Typed view of the environment values provider SDKs read directly (Azure
 * Identity, Google ADC). Assembled by `readSdkCredentialEnvironment` from
 * the `sdkCredentialEnvironment` descriptors; the descriptor keys are typed
 * against this struct so a misspelled semantic key is a compile error.
 */
export interface SdkCredentialEnvironment {
	readonly googleApplicationCredentials?: string;
	readonly azureTenantId?: string;
	readonly azureClientId?: string;
	readonly azureClientSecret?: string;
	readonly azureClientCertificatePath?: string;
	readonly azureClientCertificatePassword?: string;
}

export interface ProviderEnvMapping {
	apiKey?: EnvironmentFieldDescriptor;
	oauthM2m?: {
		authType: EnvironmentFieldDescriptor;
		host: EnvironmentFieldDescriptor;
		clientId: EnvironmentFieldDescriptor;
		clientSecret: EnvironmentFieldDescriptor;
	};
	aws?: {
		region?: EnvironmentFieldDescriptor;
		profile?: EnvironmentFieldDescriptor;
		accessKeyId?: EnvironmentFieldDescriptor;
		secretAccessKey?: EnvironmentFieldDescriptor;
		sessionToken?: EnvironmentFieldDescriptor;
	};
	/**
	 * Environment variables the provider's SDK reads directly (bypassing the
	 * credential resolver), keyed by the semantic field of
	 * `SdkCredentialEnvironment` they populate.
	 */
	sdkCredentialEnvironment?: Partial<
		Record<keyof SdkCredentialEnvironment, EnvironmentFieldDescriptor>
	>;
}

export interface CapturedProviderEnvironment {
	/** Environment names declared by the selected providers, sorted and deduplicated. */
	readonly declaredNames: readonly string[];
	/**
	 * The subset of declared names with `scrub: true` — the names a host
	 * should delete from its ambient environment after capture. Capture-only
	 * support values are intentionally absent so they remain ambient.
	 */
	readonly scrubbedNames: readonly string[];
	/** Immutable snapshot containing only the selected providers' declared names. */
	readonly environment: Readonly<Record<string, string | undefined>>;
}

/**
 * Capture the credential environment required by a resolved provider catalog.
 *
 * Credential lookup is lazy, so a host that intends to scrub its ambient
 * environment cannot discover the required names by observing reads. This
 * helper derives them statically from the provider mapping and captures only
 * those entries before the host mutates its environment. The host remains
 * the owner of any wider scrub policy and of the deletion itself.
 */
export function captureProviderEnvironment(
	providerIds: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): CapturedProviderEnvironment {
	const descriptors = providerIds.flatMap(providerEnvironmentDescriptors);
	const declaredNames = [...new Set(descriptors.map((descriptor) => descriptor.name))].sort();
	// A name declared with conflicting scrub policies scrubs (the safer side).
	const scrubbedNameSet = new Set(
		descriptors.filter((descriptor) => descriptor.scrub).map((descriptor) => descriptor.name),
	);
	const scrubbedNames = declaredNames.filter((name) => scrubbedNameSet.has(name));
	const environment: Record<string, string | undefined> = {};
	for (const name of declaredNames) {
		environment[name] = env[name];
	}
	return {
		declaredNames: Object.freeze(declaredNames),
		scrubbedNames: Object.freeze(scrubbedNames),
		environment: Object.freeze(environment),
	};
}

function providerEnvironmentDescriptors(providerId: string): EnvironmentFieldDescriptor[] {
	const mapping = PROVIDER_ENV_MAPPINGS[providerId];
	if (!mapping) return [];
	return [
		...(mapping.apiKey ? [mapping.apiKey] : []),
		...(mapping.oauthM2m ? Object.values(mapping.oauthM2m) : []),
		...(mapping.aws ? Object.values(mapping.aws) : []),
		...(mapping.sdkCredentialEnvironment ? Object.values(mapping.sdkCredentialEnvironment) : []),
	].filter((descriptor): descriptor is EnvironmentFieldDescriptor => descriptor !== undefined);
}

/**
 * Read the SDK-consumed credential environment into a typed struct.
 *
 * Provider SDKs (Azure Identity, Google ADC) read their own well-known
 * environment variables. After a host scrubs its ambient environment, the
 * bridge must instead read those values from the captured snapshot — this
 * reader is the single place that maps wire names to semantic fields, so a
 * name appears only in the `sdkCredentialEnvironment` descriptors above.
 */
export function readSdkCredentialEnvironment(
	env: Readonly<Record<string, string | undefined>>,
): SdkCredentialEnvironment {
	const descriptors = sdkCredentialDescriptors();
	return {
		googleApplicationCredentials: readField(env, descriptors.googleApplicationCredentials),
		azureTenantId: readField(env, descriptors.azureTenantId),
		azureClientId: readField(env, descriptors.azureClientId),
		azureClientSecret: readField(env, descriptors.azureClientSecret),
		azureClientCertificatePath: readField(env, descriptors.azureClientCertificatePath),
		azureClientCertificatePassword: readField(env, descriptors.azureClientCertificatePassword),
	};
}

function readField(
	env: Readonly<Record<string, string | undefined>>,
	descriptor: EnvironmentFieldDescriptor | undefined,
): string | undefined {
	return descriptor ? env[descriptor.name] : undefined;
}

function sdkCredentialDescriptors(): Partial<
	Record<keyof SdkCredentialEnvironment, EnvironmentFieldDescriptor>
> {
	const descriptors: Partial<Record<keyof SdkCredentialEnvironment, EnvironmentFieldDescriptor>> =
		{};
	for (const mapping of Object.values(PROVIDER_ENV_MAPPINGS)) {
		Object.assign(descriptors, mapping.sdkCredentialEnvironment);
	}
	return descriptors;
}
