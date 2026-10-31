/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Context window assumed for a Bedrock model whose id the capability tables do
 * not recognize. Shared by the direct Bedrock provider and the Posit Connect
 * Bedrock gateway so both report the same value.
 */
export const BEDROCK_FALLBACK_CONTEXT_LENGTH = 200_000;

/** Input media types Anthropic and Amazon models accept on the Converse API. */
const BEDROCK_CONVERSE_MEDIA_TYPES = [
	"image/png",
	"image/jpeg",
	"image/gif",
	"image/webp",
	"application/pdf",
];

/**
 * Image and document input a Bedrock model accepts on the Converse API, by
 * vendor. Only Anthropic and Amazon models are assumed to accept it. Shared by
 * the direct Bedrock provider and the Posit Connect Bedrock gateway.
 */
export function getBedrockConverseMediaSupport(vendor: string): {
	supportsImages: boolean;
	supportsToolResultImages: boolean;
	supportedInputMediaTypes: string[] | undefined;
} {
	const supportsImages = vendor === "anthropic" || vendor === "amazon";
	return {
		supportsImages,
		supportsToolResultImages: supportsImages,
		supportedInputMediaTypes: supportsImages ? [...BEDROCK_CONVERSE_MEDIA_TYPES] : undefined,
	};
}

/**
 * Whether to offer tool use for a Bedrock model on the Converse API. Tool use
 * is reliable only for Anthropic and Amazon models, and only when the model
 * streams responses. Shared by the direct Bedrock provider and the Posit
 * Connect Bedrock gateway.
 */
export function supportsBedrockConverseTools(
	vendor: string,
	responseStreamingSupported: boolean | undefined,
): boolean {
	return Boolean(responseStreamingSupported && (vendor === "anthropic" || vendor === "amazon"));
}
