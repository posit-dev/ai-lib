/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Provider Environment Variable Mappings (Internal Build Variant)
 *
 * The single declaration of every environment variable a provider's
 * credential layer or SDK reads. Each field is an
 * `EnvironmentFieldDescriptor` carrying the wire name and its scrub policy,
 * and that one declaration drives:
 *
 * - env credential resolution (`envCredentialResolver`)
 * - host environment capture and scrub partitions (`captureProviderEnvironment`)
 * - typed SDK credential construction (`readSdkCredentialEnvironment`,
 *   consumed by ai-provider-bridge's Azure/Vertex credential constructors)
 *
 * Non-secret connection config (baseUrl, endpoint, oauth, googleCloud) is
 * handled by ai-config's CONNECTION_ENV_MAPPINGS in the catalog builder.
 *
 * Moved from @assistant/node so that ai-credentials/store-backend can resolve
 * credentials without importing @assistant/*.
 *
 * SYNC NOTE: The ProviderEnvMapping interface is imported by
 * providerEnvMappings-external.ts. If you modify the interface here,
 * the external variant picks it up automatically.
 */

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

/** Shorthand for a captured-and-scrubbed field (the common case). */
function scrubbed(name: string): EnvironmentFieldDescriptor {
	return { name, scrub: true };
}

/** Shorthand for a capture-only field; the value remains ambient. */
function ambient(name: string): EnvironmentFieldDescriptor {
	return { name, scrub: false };
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

/**
 * Registry of environment variable names for each provider.
 *
 * Only credential fields go here. Non-secret connection config (baseUrl,
 * endpoint, oauth settings, googleCloud settings) is handled by ai-config's
 * env overlay in the catalog builder.
 *
 * AWS region/profile appear here so the env credential resolver can
 * construct valid aws-credentials objects when env secrets are present.
 * They also appear in ai-config's CONNECTION_ENV_MAPPINGS for catalog
 * connection resolution — this is intentional, not a duplication error.
 *
 * All fields are `scrub: true` today, preserving the historical behavior of
 * deleting every declared name from the ambient environment — including
 * non-secret support values (AWS_REGION, DATABRICKS_HOST, …). The only
 * capture-only fields are the Azure tenant/client IDs, which are non-secret
 * inputs to SDK credential construction that user code may also read.
 */
export const PROVIDER_ENV_MAPPINGS: Record<string, ProviderEnvMapping> = {
	anthropic: {
		apiKey: scrubbed("ANTHROPIC_API_KEY"),
	},
	openai: {
		apiKey: scrubbed("OPENAI_API_KEY"),
	},
	gemini: {
		apiKey: scrubbed("GEMINI_API_KEY"),
	},
	openrouter: {
		apiKey: scrubbed("OPENROUTER_API_KEY"),
	},
	bedrock: {
		aws: {
			region: scrubbed("AWS_REGION"),
			profile: scrubbed("AWS_PROFILE"),
			accessKeyId: scrubbed("AWS_ACCESS_KEY_ID"),
			secretAccessKey: scrubbed("AWS_SECRET_ACCESS_KEY"),
			sessionToken: scrubbed("AWS_SESSION_TOKEN"),
		},
	},
	"openai-compatible": {
		apiKey: scrubbed("OPENAI_COMPATIBLE_API_KEY"),
	},
	"ms-foundry": {
		apiKey: scrubbed("MS_FOUNDRY_API_KEY"),
		sdkCredentialEnvironment: {
			azureClientSecret: scrubbed("AZURE_CLIENT_SECRET"),
			azureClientCertificatePath: scrubbed("AZURE_CLIENT_CERTIFICATE_PATH"),
			azureClientCertificatePassword: scrubbed("AZURE_CLIENT_CERTIFICATE_PASSWORD"),
			azureTenantId: ambient("AZURE_TENANT_ID"),
			azureClientId: ambient("AZURE_CLIENT_ID"),
		},
	},
	"snowflake-cortex": {
		apiKey: scrubbed("SNOWFLAKE_TOKEN"),
	},
	deepseek: {
		apiKey: scrubbed("DEEPSEEK_API_KEY"),
	},
	databricks: {
		apiKey: scrubbed("DATABRICKS_TOKEN"),
		oauthM2m: {
			authType: scrubbed("DATABRICKS_AUTH_TYPE"),
			host: scrubbed("DATABRICKS_HOST"),
			clientId: scrubbed("DATABRICKS_CLIENT_ID"),
			clientSecret: scrubbed("DATABRICKS_CLIENT_SECRET"),
		},
	},
	litellm: {
		apiKey: scrubbed("LITELLM_API_KEY"),
	},
	portkey: {
		apiKey: scrubbed("PORTKEY_API_KEY"),
	},
	// The standard Posit Connect API-key variable (rsconnect/connectapi
	// convention); pairs with ai-config's POSIT_CONNECT_URL connection var.
	"posit-connect": {
		apiKey: scrubbed("CONNECT_API_KEY"),
	},
	// Google Application Default Credentials file, read directly by the
	// google-auth-library SDK on the lazy Vertex credential path.
	"google-vertex": {
		sdkCredentialEnvironment: {
			googleApplicationCredentials: scrubbed("GOOGLE_APPLICATION_CREDENTIALS"),
		},
	},
};

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
