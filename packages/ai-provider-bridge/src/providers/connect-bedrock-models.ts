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

/** One discovered model: the invokable inference-profile id, a display name, and the vendor. */
export interface DiscoveredBedrockModel {
	id: string;
	name: string;
	vendor: string;
}

/**
 * Vendors whose models take text output but do not answer chat requests. AWS
 * rejects a Converse call to them ("supported text or chat model"), and the
 * catalog metadata cannot tell them apart from chat models: TwelveLabs Pegasus
 * reports the same text and video inputs, streaming and inference-profile
 * fields as Amazon Nova.
 */
const NON_CHAT_VENDORS: ReadonlySet<string> = new Set(["twelvelabs"]);

/**
 * List the text models a Connect Bedrock gateway can invoke, as
 * inference-profile ids. Models served only by Bedrock Mantle (`openai.`) are
 * skipped: Runtime would map their profiles to Converse, which is a broken
 * entry. They are listed through the gateway's separate Mantle route instead
 * (see `listMantleModels`), so each appears once. Vendors in
 * {@link NON_CHAT_VENDORS} are skipped too. Returns `null` when the
 * inference-profile listing is unavailable (for example the role lacks
 * `bedrock:ListInferenceProfiles`), so the caller can report it. The
 * foundation-model listing names the text models and drops those that are
 * retired or `LEGACY`: AWS still lists their profiles, but invoking them fails.
 * If that listing itself fails, Anthropic models are kept unfiltered and named
 * by id.
 */
export async function listGatewayModels(
	client: BedrockCatalogClient,
	logger: Logger,
): Promise<DiscoveredBedrockModel[] | null> {
	const [profiles, names] = await Promise.all([
		listInferenceProfileIds(client, null, logger),
		client
			.send(new ListFoundationModelsCommand({ byOutputModality: "TEXT" }))
			.then((response) => {
				const byId = new Map<string, string>();
				for (const summary of response.modelSummaries ?? []) {
					if (summary.modelId && summary.modelLifecycle?.status !== "LEGACY") {
						byId.set(summary.modelId, summary.modelName ?? summary.modelId);
					}
				}
				return byId;
			})
			.catch((error: unknown): null => {
				logger.debug(
					`[posit-connect] Bedrock foundation-model listing failed; keeping models unfiltered: ${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			}),
	]);
	if (profiles === null) return null;
	const models: DiscoveredBedrockModel[] = [];
	for (const [modelId, profileId] of profiles) {
		if (modelId.startsWith("openai.")) continue;
		const vendor = modelId.split(".")[0] || "aws";
		if (NON_CHAT_VENDORS.has(vendor)) continue;
		if (names === null) {
			// Without the listing we cannot tell text from embedding or image models.
			if (vendor === "anthropic") models.push({ id: profileId, name: modelId, vendor });
		} else if (names.has(modelId)) {
			models.push({ id: profileId, name: names.get(modelId)!, vendor });
		}
	}
	return models.sort((a, b) => a.id.localeCompare(b.id));
}
