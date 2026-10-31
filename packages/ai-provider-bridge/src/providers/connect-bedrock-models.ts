/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	BedrockClient,
	ListFoundationModelsCommand,
	type ListFoundationModelsResponse,
	type ListInferenceProfilesCommand,
	type ListInferenceProfilesResponse,
} from "@aws-sdk/client-bedrock";

import { safeSdkCustomHeaders, userAgentHeaderValue } from "../custom-headers";
import type { Logger } from "../types";
import { listInferenceProfileIds } from "./bedrock-inference-profiles";

type SendOptions = { abortSignal?: AbortSignal };

/**
 * Narrow structural sender for the two control-plane commands discovery
 * issues. The real `BedrockClient` satisfies it; tests use typed fakes.
 */
export interface BedrockCatalogClient {
	send(
		command: ListInferenceProfilesCommand,
		options?: SendOptions,
	): Promise<ListInferenceProfilesResponse>;
	send(
		command: ListFoundationModelsCommand,
		options?: SendOptions,
	): Promise<ListFoundationModelsResponse>;
}

/**
 * The control-plane client for one gateway listing, carrying the Connect
 * credential's custom headers like the signed inference requests do. The
 * AWS SDK takes no arbitrary headers: User-Agent goes through
 * `customUserAgent`, and a build-step middleware adds the rest before signing.
 * The caller destroys the client when the listing ends.
 */
export function createGatewayCatalogClient(options: {
	region: string;
	endpoint: string;
	credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
	customHeaders: Record<string, string> | undefined;
}): BedrockClient {
	const { customHeaders, ...config } = options;
	const customUserAgent = userAgentHeaderValue(customHeaders);
	const client = new BedrockClient({
		...config,
		...(customUserAgent !== undefined ? { customUserAgent } : {}),
	});
	const extraHeaders = Object.entries(safeSdkCustomHeaders(customHeaders) ?? {}).filter(
		([name]) => name.toLowerCase() !== "user-agent",
	);
	if (extraHeaders.length > 0) {
		client.middlewareStack.add(
			(next) => async (args) => {
				const { request } = args;
				if (
					typeof request === "object" &&
					request !== null &&
					"headers" in request &&
					typeof request.headers === "object" &&
					request.headers !== null
				) {
					Object.assign(request.headers, Object.fromEntries(extraHeaders));
				}
				return next(args);
			},
			{ step: "build", name: "connectGatewayCustomHeaders" },
		);
	}
	return client;
}

/**
 * One discovered model: the invokable inference-profile id, a display name,
 * the vendor, and whether the model streams responses.
 */
export interface DiscoveredBedrockModel {
	id: string;
	name: string;
	vendor: string;
	responseStreamingSupported: boolean;
}

/**
 * List the text models a Connect Bedrock gateway can invoke, as
 * inference-profile ids. Models served only by Bedrock Mantle (`openai.`) are
 * skipped: Runtime would map their profiles to Converse, which is a broken
 * entry. They are listed through the gateway's separate Mantle route instead
 * (see `listMantleModels`), so each appears once. Returns `null` when the
 * inference-profile listing is unavailable (for example the role lacks
 * `bedrock:ListInferenceProfiles`), so the caller can report it. The
 * foundation-model listing names the text models and drops the rest; if it
 * fails, the error propagates. No further curation: admins restrict models
 * through their own controls. `signal` cancels every request, including
 * pagination; an abort rejects.
 */
export async function listGatewayModels(
	client: BedrockCatalogClient,
	logger: Logger,
	signal: AbortSignal,
): Promise<DiscoveredBedrockModel[] | null> {
	// Settled, not Promise.all: an unavailable profile listing reports first,
	// even when the foundation-model listing was denied too.
	const [profilesResult, foundationModelsResult] = await Promise.allSettled([
		listInferenceProfileIds(client, null, logger, signal),
		client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }), {
			abortSignal: signal,
		}),
	]);
	if (profilesResult.status === "rejected") throw profilesResult.reason;
	const profiles = profilesResult.value;
	if (profiles === null) return null;
	if (foundationModelsResult.status === "rejected") throw foundationModelsResult.reason;
	const foundationModels = foundationModelsResult.value;
	const names = new Map<string, { name: string; responseStreamingSupported: boolean }>();
	for (const summary of foundationModels.modelSummaries ?? []) {
		if (summary.modelId) {
			names.set(summary.modelId, {
				name: summary.modelName ?? summary.modelId,
				responseStreamingSupported: summary.responseStreamingSupported === true,
			});
		}
	}
	const models: DiscoveredBedrockModel[] = [];
	for (const [modelId, profileId] of profiles) {
		const summary = names.get(modelId);
		if (summary) {
			models.push({ id: profileId, vendor: modelId.split(".")[0] || "aws", ...summary });
		}
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}
