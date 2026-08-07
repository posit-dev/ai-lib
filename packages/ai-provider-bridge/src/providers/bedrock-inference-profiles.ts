/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import {
	ListInferenceProfilesCommand,
	type ListInferenceProfilesResponse,
} from "@aws-sdk/client-bedrock";

import type { Logger } from "../types";

/**
 * Narrow structural sender for the one command this module consumes. The real
 * `BedrockClient` satisfies it; tests use strictly typed fakes instead of
 * mocking the whole SDK.
 */
export interface InferenceProfileLister {
	send(command: ListInferenceProfilesCommand): Promise<ListInferenceProfilesResponse>;
}

/**
 * Extract the bare foundation-model ID from a model ARN
 * (`…:foundation-model/anthropic.claude-…` → `anthropic.claude-…`).
 */
function bareModelId(modelArn: string): string | null {
	const segment = modelArn.split("/").pop();
	return segment ? segment : null;
}

function isAccessDenied(error: unknown): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	if (error.name === "AccessDeniedException" || error.name === "UnauthorizedOperation") {
		return true;
	}
	if (!("$metadata" in error)) {
		return false;
	}
	const metadata = error.$metadata;
	if (typeof metadata !== "object" || metadata === null || !("httpStatusCode" in metadata)) {
		return false;
	}
	return metadata.httpStatusCode === 403;
}

/**
 * Discover which cross-region inference profile IDs are invokable in the
 * calling region, keyed by bare foundation-model ID.
 *
 * A successful `ListInferenceProfiles` listing is authoritative for the
 * region (that is the API's contract), so the returned map is the whole
 * truth: callers must not guess IDs for models absent from it. `null` is the
 * only failure signal and means "discovery unavailable" — the caller falls
 * back to prefix construction.
 *
 * Selection is a documented total order, independent of response order (the
 * API defines pagination but no result ordering, and a model can have
 * several geo candidates in one region, e.g. `jp.` alongside `apac.`):
 *
 * 1. the profile whose prefix matches `preferredProfilePrefix` (the region's
 *    legacy family prefix, computed by the caller), preserving today's IDs;
 * 2. otherwise other non-`global.` profiles, alphabetically by profile ID;
 * 3. `global.` only when nothing else maps.
 *
 * A denied listing (missing `bedrock:ListInferenceProfiles`) is an expected
 * policy gap and logs at debug; every other failure (throttling, service
 * errors, malformed responses, network) logs at warn with the actual error.
 * This function never touches provider status — a discovery 403 is a
 * degradation, not an auth failure.
 */
export async function listInferenceProfileIds(
	listClient: InferenceProfileLister,
	preferredProfilePrefix: string | null,
	logger: Logger,
): Promise<Map<string, string> | null> {
	try {
		// bare modelId → candidate profile IDs
		const candidates = new Map<string, string[]>();
		let nextToken: string | undefined;
		do {
			const command = new ListInferenceProfilesCommand({
				typeEquals: "SYSTEM_DEFINED",
				...(nextToken ? { nextToken } : {}),
			});
			const response: ListInferenceProfilesResponse = await listClient.send(command);
			for (const profile of response.inferenceProfileSummaries ?? []) {
				if (profile.status !== "ACTIVE" || !profile.inferenceProfileId) {
					continue;
				}
				const profileId = profile.inferenceProfileId;
				for (const model of profile.models ?? []) {
					if (!model.modelArn) {
						continue;
					}
					const modelId = bareModelId(model.modelArn);
					// Mantle owns openai.* models; never map them to Converse profiles.
					if (!modelId || modelId.startsWith("openai.")) {
						continue;
					}
					const list = candidates.get(modelId);
					if (list) {
						list.push(profileId);
					} else {
						candidates.set(modelId, [profileId]);
					}
				}
			}
			nextToken = response.nextToken;
		} while (nextToken);

		const result = new Map<string, string>();
		for (const [modelId, profileIds] of candidates) {
			result.set(modelId, chooseProfileId(profileIds, preferredProfilePrefix));
		}
		return result;
	} catch (error) {
		if (isAccessDenied(error)) {
			logger.debug(
				"[Bedrock] Inference profile discovery denied; bedrock:ListInferenceProfiles may be missing from the IAM policy.",
			);
		} else {
			const message = error instanceof Error ? error.message : String(error);
			logger.warn(`[Bedrock] Inference profile discovery failed: ${message}`);
		}
		return null;
	}
}

/**
 * Pick one profile ID per the module's documented total order. Sorting makes
 * the choice independent of API response order, so a cache refresh can never
 * flip a model's ID.
 */
function chooseProfileId(profileIds: string[], preferredProfilePrefix: string | null): string {
	const sorted = [...profileIds].sort();
	if (preferredProfilePrefix !== null) {
		const preferred = sorted.find((id) => id.startsWith(`${preferredProfilePrefix}.`));
		if (preferred) {
			return preferred;
		}
	}
	const geo = sorted.find((id) => !id.startsWith("global."));
	return geo ?? sorted[0];
}
