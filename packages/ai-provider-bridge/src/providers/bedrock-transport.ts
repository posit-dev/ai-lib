/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { loadConfig, NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS } from "@smithy/core/config";

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
	/** Environment to read the AWS endpoint overrides from; defaults to process.env. */
	env?: Readonly<Record<string, string | undefined>>;
}

/** AWS-standard endpoint overrides for Bedrock Runtime, most specific first. */
export const BEDROCK_RUNTIME_ENDPOINT_ENVS = [
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_ENDPOINT_URL",
] as const;

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
	env = process.env,
}: ResolveBedrockTransportOptions): Promise<BedrockTransport> {
	const useFipsEndpoint = await loadConfig(NODE_USE_FIPS_ENDPOINT_CONFIG_OPTIONS, {
		ignoreCache: true,
		profile,
	})();
	const runtimeHost = `bedrock-runtime${useFipsEndpoint ? "-fips" : ""}.${region}.amazonaws.com`;
	let runtimeOverride: string | undefined;
	for (const name of BEDROCK_RUNTIME_ENDPOINT_ENVS) {
		const value = env[name]?.trim();
		if (value) {
			runtimeOverride = value.replace(/\/+$/, "");
			break;
		}
	}
	if (runtimeOverride && useFipsEndpoint) {
		logger?.warn(
			`[Bedrock] Endpoint override ${runtimeOverride} replaces the FIPS runtime endpoint https://${runtimeHost}`,
		);
	}
	const listingHost = `bedrock${useFipsEndpoint ? "-fips" : ""}.${region}.amazonaws.com`;
	const mantleEnabled = !useFipsEndpoint;
	const mantleHost = mantleEnabled ? `bedrock-mantle.${region}.api.aws` : "disabled";

	logger?.debug(
		`[Bedrock] Resolved transport: runtimeHost=${runtimeHost}, listingHost=${listingHost}, useFipsEndpoint=${useFipsEndpoint}, mantleEnabled=${mantleEnabled}, mantleHost=${mantleHost}, runtimeOverride=${runtimeOverride ?? "none"}`,
	);

	return {
		useFipsEndpoint,
		runtimeBaseUrl: runtimeOverride ?? `https://${runtimeHost}`,
		mantleEnabled,
	};
}
