/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { AwsV4Signer } from "aws4fetch";

import type { ResolvedAwsCredentials } from "../aws-credentials";

/** Region and service from a SigV4 `Authorization` header's credential scope. */
const SIGV4_SCOPE = /^AWS4-HMAC-SHA256 Credential=[^/]+\/\d{8}\/([^/]+)\/([^/]+)\/aws4_request/;

/** Headers the SDK's signature added; dropped so the new signature replaces them. */
const SIGNATURE_HEADERS = [
	"authorization",
	"x-amz-date",
	"x-amz-security-token",
	"x-amz-content-sha256",
];

/**
 * Fetch for Bedrock's Anthropic (InvokeModel) route that sends
 * `thinking.block_binding.prefix_mismatch_behavior`.
 *
 * `@ai-sdk/amazon-bedrock` renames the field to `mismatch_behavior`
 * (vercel/ai#20728). AWS documents that name as a deprecated alias and some
 * regions ignore it, so a prefix change fails with the 400 the binding exists
 * to prevent. The SDK renames before it signs, so this renames the field back
 * and re-signs with the scope the SDK chose. Bodies without the field pass
 * through untouched, so this becomes a no-op once the SDK stops renaming
 * (vercel/ai#24919) and can then be removed.
 */
export function withPrefixMismatchBehavior(
	credentialProvider: () => Promise<ResolvedAwsCredentials>,
	fetchFunction: typeof globalThis.fetch | undefined,
): typeof globalThis.fetch {
	return async (input, init) => {
		const send = fetchFunction ?? globalThis.fetch;
		const body = typeof init?.body === "string" ? renameMismatchBehavior(init.body) : undefined;
		if (init === undefined || body === undefined) {
			return send(input, init);
		}
		const headers = new Headers(init.headers);
		const scope = SIGV4_SCOPE.exec(headers.get("authorization") ?? "");
		if (!scope) {
			// Bearer-token auth doesn't sign the body.
			return send(input, { ...init, body });
		}
		for (const name of SIGNATURE_HEADERS) {
			headers.delete(name);
		}
		const credentials = await credentialProvider();
		const signed = await new AwsV4Signer({
			url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			method: "POST",
			headers,
			body,
			region: scope[1],
			service: scope[2],
			accessKeyId: credentials.accessKeyId,
			secretAccessKey: credentials.secretAccessKey,
			sessionToken: credentials.sessionToken,
		}).sign();
		return send(input, { ...init, body, headers: signed.headers });
	};
}

/** The body with `mismatch_behavior` renamed, or `undefined` when there is nothing to rename. */
function renameMismatchBehavior(body: string): string | undefined {
	if (!body.includes('"mismatch_behavior"')) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(body);
	if (!isRecord(parsed) || !isRecord(parsed.thinking) || !isRecord(parsed.thinking.block_binding)) {
		return undefined;
	}
	const { mismatch_behavior: behavior, ...rest } = parsed.thinking.block_binding;
	if (behavior === undefined || "prefix_mismatch_behavior" in rest) {
		return undefined;
	}
	return JSON.stringify({
		...parsed,
		thinking: {
			...parsed.thinking,
			block_binding: { ...rest, prefix_mismatch_behavior: behavior },
		},
	});
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
