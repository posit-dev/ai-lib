/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AwsV4Signer } from "aws4fetch";

import { createAwsCredentialProvider } from "../aws-credentials";
import { safeSdkCustomHeaders } from "../custom-headers";
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

function isAccessDenied(body: string): boolean {
	return /accessdenied|access denied|not authorized/i.test(body);
}

export interface ListMantleModelsOptions {
	/**
	 * Versioned Mantle base that `/models` is appended to, for example a
	 * Connect gateway's `<connect>/__gateway__/bedrock-mantle/<guid>/v1`. The
	 * default is the direct host, `https://bedrock-mantle.<region>.api.aws/v1`.
	 * Setting it marks the listing as a gateway listing, which reports a denied
	 * listing as a warning that names the missing action.
	 */
	baseUrl?: string;
	/**
	 * SigV4 signing region. Defaults to the credentials' region. A Connect
	 * gateway verifies the signature against its integration's region.
	 */
	region?: string;
	/** Aborts the listing; an aborted listing rejects instead of returning `[]`. */
	signal?: AbortSignal;
}

/**
 * List Mantle model IDs without allowing Mantle discovery to break Bedrock's
 * existing Converse catalog. The live service exposes its complete catalog at
 * `/v1/models`; inference routing is assigned later from model-family rules.
 * Every failure yields `[]` except an abort through `options.signal`, which
 * rejects so a cancelled discovery is not held behind a hung listing.
 */
export async function listMantleModels(
	credentials: AwsCredentials,
	logger: Logger,
	options: ListMantleModelsOptions = {},
	fetchFunction: typeof globalThis.fetch = globalThis.fetch,
): Promise<MantleModelListing[]> {
	const region = options.region ?? credentials.region;
	const isGateway = options.baseUrl !== undefined;
	const baseUrl = (
		options.baseUrl ?? `https://bedrock-mantle.${credentials.region}.api.aws/v1`
	).replace(/\/+$/, "");
	const url = `${baseUrl}/models`;
	const { signal } = options;

	try {
		signal?.throwIfAborted();
		const resolved = await createAwsCredentialProvider(credentials)();
		// Custom headers (the product User-Agent) go through the signer so the
		// request is sent with exactly the signer's header set. aws4fetch leaves
		// User-Agent out of the signature, so it cannot invalidate it.
		const signer = new AwsV4Signer({
			url,
			method: "GET",
			headers: safeSdkCustomHeaders(credentials.customHeaders),
			region,
			service: "bedrock-mantle",
			accessKeyId: resolved.accessKeyId,
			secretAccessKey: resolved.secretAccessKey,
			sessionToken: resolved.sessionToken,
		});
		const signed = await signer.sign();
		signal?.throwIfAborted();
		const response = await fetchFunction(url, {
			method: "GET",
			headers: signed.headers,
			...(signal ? { signal } : {}),
		});
		const responseBody = await response.text();

		if (!response.ok) {
			if (response.status === 404) {
				logger.debug(`[Bedrock Mantle] Model listing is unavailable at ${url} (404)`);
			} else if (
				isGateway &&
				response.status === 403 &&
				!isSignatureRejection(responseBody) &&
				isAccessDenied(responseBody)
			) {
				// Through a gateway the role is admin-configured, and Mantle models
				// are optional: name the action so the admin can add it.
				logger.warn(
					`[Bedrock Mantle] Model listing at ${url} was denied; the role needs ` +
						`bedrock-mantle:ListModels to list OpenAI models: ${responseBody}`,
				);
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
		if (signal?.aborted) throw error;
		const message = error instanceof Error ? error.message : String(error);
		logger.warn(`[Bedrock Mantle] Model listing failed: ${message}`);
		return [];
	}
}
