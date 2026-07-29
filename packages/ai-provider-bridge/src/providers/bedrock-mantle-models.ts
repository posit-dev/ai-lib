/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AwsV4Signer } from "aws4fetch";

import { createAwsCredentialProvider } from "../aws-credentials";
import type { AwsCredentials, Logger } from "../types";

interface MantleResponseModel {
	id: string;
	status?: string;
}

export interface MantleModelListing {
	id: string;
}

function parseModels(body: unknown): MantleResponseModel[] | undefined {
	if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
		return undefined;
	}

	const models: MantleResponseModel[] = [];
	for (const item of body.data) {
		if (
			typeof item !== "object" ||
			item === null ||
			!("id" in item) ||
			typeof item.id !== "string"
		) {
			return undefined;
		}
		const model: MantleResponseModel = {
			id: item.id,
			...("status" in item && typeof item.status === "string" ? { status: item.status } : {}),
		};
		// AWS can enumerate models that cannot currently be invoked (for example
		// because the account retention policy is incompatible). Older response
		// shapes omitted status, so absence remains eligible.
		if (model.status !== undefined && model.status !== "available") {
			continue;
		}
		models.push(model);
	}
	return models;
}

function isSignatureRejection(body: string): boolean {
	return /signature|credential should be scoped|security token.*(?:invalid|expired)|unrecognizedclient|invalidclienttoken|expiredtoken|authorization header/i.test(
		body,
	);
}

/**
 * List Mantle model IDs without allowing Mantle discovery to break Bedrock's
 * existing Converse catalog. The live service exposes its complete catalog at
 * `/v1/models`; inference routing is assigned later from model-family rules.
 */
export async function listMantleModels(
	credentials: AwsCredentials,
	logger: Logger,
	fetchFunction: typeof globalThis.fetch = globalThis.fetch,
): Promise<MantleModelListing[]> {
	const baseUrl = `https://bedrock-mantle.${credentials.region}.api.aws/v1`;
	const url = `${baseUrl}/models`;

	try {
		const resolved = await createAwsCredentialProvider(credentials)();
		const signer = new AwsV4Signer({
			url,
			method: "GET",
			region: credentials.region,
			service: "bedrock-mantle",
			accessKeyId: resolved.accessKeyId,
			secretAccessKey: resolved.secretAccessKey,
			sessionToken: resolved.sessionToken,
		});
		const signed = await signer.sign();
		const response = await fetchFunction(url, {
			method: "GET",
			headers: signed.headers,
		});
		const responseBody = await response.text();

		if (!response.ok) {
			if (response.status === 404) {
				logger.debug(`[Bedrock Mantle] Model listing is unavailable at ${url} (404)`);
			} else if (
				(response.status === 401 || response.status === 403) &&
				!isSignatureRejection(responseBody)
			) {
				logger.debug(
					`[Bedrock Mantle] Model listing denied; bedrock-mantle:ListModels may be missing: ${responseBody}`,
				);
			} else {
				logger.warn(`[Bedrock Mantle] Model listing failed (${response.status}): ${responseBody}`);
			}
			return [];
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(responseBody);
		} catch {
			logger.warn(`[Bedrock Mantle] Model listing returned malformed JSON: ${responseBody}`);
			return [];
		}

		const models = parseModels(parsed);
		if (!models) {
			logger.warn(`[Bedrock Mantle] Model listing returned an unexpected body: ${responseBody}`);
			return [];
		}
		return [...new Set(models.map((model) => model.id))].map((id) => ({ id }));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`[Bedrock Mantle] Model listing failed: ${message}`);
		return [];
	}
}
