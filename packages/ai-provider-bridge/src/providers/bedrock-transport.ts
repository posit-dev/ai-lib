/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	booleanSelector,
	CONFIG_PREFIX_SEPARATOR,
	loadConfig,
	NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS,
	SelectorType,
	type LoadedConfigSelectors,
} from "@smithy/core/config";

import type { Logger } from "../types";

export interface BedrockTransport {
	useFipsEndpoint: boolean;
	runtimeBaseUrl: string;
	mantleEnabled: boolean;
}

export interface ResolveBedrockTransportOptions {
	region: string;
	profile?: string;
	logger?: Logger;
}

/**
 * Resolve the AWS-standard endpoint policy for one Bedrock operation.
 *
 * This intentionally does not memoize: AWS SDK configuration is file-backed,
 * and a long-running host must observe edits to the selected profile. The
 * returned policy is shared by every route participating in that operation so
 * control-plane discovery, runtime inference, and Mantle cannot disagree.
 */
export async function resolveBedrockTransport({
	region,
	profile,
	logger,
}: ResolveBedrockTransportOptions): Promise<BedrockTransport> {
	const useFipsEndpoint = await loadConfig(NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, {
		ignoreCache: true,
		profile,
	})();
	const runtimeHost = `bedrock-runtime${useFipsEndpoint ? "-fips" : ""}.${region}.amazonaws.com`;
	const listingHost = `bedrock${useFipsEndpoint ? "-fips" : ""}.${region}.amazonaws.com`;
	const mantleEnabled = !useFipsEndpoint;
	const mantleHost = mantleEnabled ? `bedrock-mantle.${region}.api.aws` : "disabled";

	logger?.debug(
		`[Bedrock] Resolved transport: runtimeHost=${runtimeHost}, listingHost=${listingHost}, useFipsEndpoint=${useFipsEndpoint}, mantleEnabled=${mantleEnabled}, mantleHost=${mantleHost}`,
	);

	return {
		useFipsEndpoint,
		runtimeBaseUrl: `https://${runtimeHost}`,
		mantleEnabled,
	};
}

/** AWS configured endpoints for the two direct-Bedrock services; `undefined` means Amazon's host. */
export interface ConfiguredBedrockEndpoints {
	/** Bedrock Runtime (chats on the Anthropic and Converse routes). */
	runtime: string | undefined;
	/** Bedrock control plane (model listing). */
	listing: string | undefined;
}

/**
 * Selectors for one service's configured endpoint, mirroring Smithy's
 * `getEndpointUrlConfig` (not publicly exported): `AWS_ENDPOINT_URL_<SERVICE>`,
 * then `AWS_ENDPOINT_URL`, then the profile's `[services <name>]` section, then
 * the profile's `endpoint_url`. A profile naming a missing services section
 * has no endpoint.
 */
function endpointUrlSelectors(serviceId: string): LoadedConfigSelectors<string | undefined> {
	const words = serviceId.split(" ");
	return {
		environmentVariableSelector: (env) =>
			env[["AWS_ENDPOINT_URL", ...words.map((word) => word.toUpperCase())].join("_")] ||
			env.AWS_ENDPOINT_URL ||
			undefined,
		configFileSelector: (profile, config) => {
			if (profile.services) {
				const section = config?.[["services", profile.services].join(CONFIG_PREFIX_SEPARATOR)];
				// Smithy throws here; `loadConfig` reads either as "no endpoint".
				if (!section) return undefined;
				const key = [words.map((word) => word.toLowerCase()).join("_"), "endpoint_url"].join(
					CONFIG_PREFIX_SEPARATOR,
				);
				if (section[key]) {
					return section[key];
				}
			}
			return profile.endpoint_url || undefined;
		},
		default: undefined,
	};
}

/** Mirrors Smithy's `ignoreConfiguredEndpointUrlsConfigSelectors`. */
const IGNORE_CONFIGURED_ENDPOINT_URLS_SELECTORS: LoadedConfigSelectors<boolean> = {
	environmentVariableSelector: (env) =>
		booleanSelector(env, "AWS_IGNORE_CONFIGURED_ENDPOINT_URLS", SelectorType.ENV),
	configFileSelector: (profile) =>
		booleanSelector(profile, "ignore_configured_endpoint_urls", SelectorType.CONFIG),
	default: false,
};

/**
 * Resolve the AWS configured endpoints for direct Bedrock, as the AWS SDK
 * would, but for PA's selected profile and without caching, so edits to the
 * shared config files are seen on the next operation. The off switch
 * (`AWS_IGNORE_CONFIGURED_ENDPOINT_URLS` or the profile's
 * `ignore_configured_endpoint_urls`) disables every source.
 *
 * Kept out of {@link resolveBedrockTransport}: Connect and other routes with
 * their own base URL never read endpoint configuration.
 */
export async function resolveConfiguredBedrockEndpoints({
	profile,
}: {
	profile: string | undefined;
}): Promise<ConfiguredBedrockEndpoints> {
	const init = { profile, ignoreCache: true };
	if (await loadConfig(IGNORE_CONFIGURED_ENDPOINT_URLS_SELECTORS, init)()) {
		return { runtime: undefined, listing: undefined };
	}
	const [runtime, listing] = await Promise.all([
		loadConfig(endpointUrlSelectors("Bedrock Runtime"), init)(),
		loadConfig(endpointUrlSelectors("Bedrock"), init)(),
	]);
	return { runtime, listing };
}

/**
 * Refuse a configured endpoint while FIPS endpoints are enabled, as the AWS SDK
 * does ("FIPS and custom endpoint are not supported"): the configured host has
 * no FIPS guarantee.
 */
export function refuseConfiguredEndpointUnderFips(
	transport: BedrockTransport,
	endpoint: string | undefined,
): void {
	if (transport.useFipsEndpoint && endpoint !== undefined) {
		throw new Error(
			`Amazon Bedrock: FIPS and a configured endpoint are not supported together. The AWS ` +
				`configured endpoint ${endpoint} (AWS_ENDPOINT_URL* or endpoint_url in the AWS config) ` +
				`is set while FIPS endpoints are enabled (AWS_USE_FIPS_ENDPOINT or use_fips_endpoint). ` +
				`Remove one, or set AWS_IGNORE_CONFIGURED_ENDPOINT_URLS=true.`,
		);
	}
}
