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
