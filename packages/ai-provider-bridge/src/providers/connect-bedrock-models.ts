/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	ListFoundationModelsCommand,
	type ListFoundationModelsResponse,
	type ListInferenceProfilesCommand,
	type ListInferenceProfilesResponse,
} from "@aws-sdk/client-bedrock";

import type { Logger } from "../types";
import { listInferenceProfileIds } from "./bedrock-inference-profiles";

/**
 * Narrow structural sender for the two control-plane commands discovery
 * issues. The real `BedrockClient` satisfies it; tests use typed fakes.
 */
export interface BedrockCatalogClient {
	send(command: ListInferenceProfilesCommand): Promise<ListInferenceProfilesResponse>;
	send(command: ListFoundationModelsCommand): Promise<ListFoundationModelsResponse>;
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
 * through their own controls.
 */
export async function listGatewayModels(
	client: BedrockCatalogClient,
	logger: Logger,
): Promise<DiscoveredBedrockModel[] | null> {
	// Settled, not Promise.all: an unavailable profile listing reports first,
	// even when the foundation-model listing was denied too.
	const [profilesResult, foundationModelsResult] = await Promise.allSettled([
		listInferenceProfileIds(client, null, logger),
		client.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" })),
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
