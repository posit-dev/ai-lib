/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenAI-compatible provider
 *
 * `/v1/models` is standardized only in its `{ data: [{ id }] }` skeleton, but
 * most endpoints publish capability metadata alongside it under whichever key
 * their ecosystem picked: `input` modalities (GWDG SAIA), `max_model_len`
 * (vLLM), `context_length` plus `architecture` (OpenRouter-shaped gateways),
 * `max_context_length` (LM Studio). Since this provider exists for endpoints
 * we cannot enumerate, that metadata is the only capability signal we get —
 * a hardcoded table can never cover an arbitrary deployment.
 *
 * So discovery reads the union of those keys, best-effort: every field is
 * validated independently and a missing or malformed one falls through to the
 * conservative baseline that `inferModelCapabilities` owns. A `providers.json`
 * `models.overrides` entry still wins over anything discovered here, which is
 * the escape hatch for endpoints that publish nothing (or lie).
 */

import { inferModelCapabilities, type ResolvedProviderId } from "ai-config";

import { createOpenAICompatibleFetch } from "../model-clients/openai-compat-fetch";
import { OpenAIClient } from "../model-clients/OpenAIClient";
import type { Logger, ModelInfo } from "../types";
import type { ApiKeyCredentials } from "../types";
import { createCachedModelFetcher } from "./cached-model-fetcher";
import type { ClientFactory, ProviderRegistry } from "./ProviderRegistry";

/**
 * Image types every vision-capable OpenAI-shaped endpoint accepts. Discovery
 * only ever tells us *whether* a model reads images, never which encodings, so
 * this is the claim we can safely make. Deliberately local: the same-looking
 * lists in ai-config are independent capability-table entries, and the OpenAI
 * and Bedrock ones are a different set that also includes `application/pdf`.
 */
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** A nested JSON object, or an empty one when the key is absent or not an object. */
function record(value: unknown): Record<string, unknown> {
	return isRecord(value) ? value : {};
}

/**
 * A discovery number is usable only as a positive, exactly-representable
 * integer. Endpoints have been seen reporting `0`, `-1`, and stringified
 * numbers; any of those becoming a live token limit is worse than the baseline.
 */
function positiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

/** Lowercased string members of a JSON array; any other shape yields none. */
function stringMembers(value: unknown): string[] {
	if (!Array.isArray(value)) {
		return [];
	}
	const members: string[] = [];
	for (const member of value) {
		if (typeof member === "string") {
			members.push(member.toLowerCase());
		}
	}
	return members;
}

/**
 * Input side of an OpenRouter-style modality string (`"text+image->text"`).
 *
 * Only the side before the arrow counts: `"text->image"` is an image
 * *generation* model, and treating that as vision support would offer uploads
 * to a model that cannot read them.
 */
function modalityInputs(value: unknown): string[] {
	if (typeof value !== "string") {
		return [];
	}
	const arrow = value.indexOf("->");
	const inputs = arrow === -1 ? value : value.slice(0, arrow);
	return inputs
		.toLowerCase()
		.split("+")
		.map((modality) => modality.trim());
}

/** Whether any of the recognized vision signals is present and says "image". */
function acceptsImages(entry: Record<string, unknown>): boolean {
	const architecture = record(entry.architecture);
	return (
		stringMembers(entry.input).includes("image") ||
		stringMembers(architecture.input_modalities).includes("image") ||
		modalityInputs(architecture.modality).includes("image") ||
		stringMembers(entry.capabilities).includes("vision")
	);
}

/**
 * Token limits, resolving the overlap between ecosystems explicitly rather
 * than letting spread order decide. An explicit input limit beats a
 * context-window figure, since a window can include the output budget; a
 * window stands in for the input limit only when nothing better is published
 * (the same fallback ai-config's DeepSeek path makes).
 */
function tokenLimits(entry: Record<string, unknown>): Partial<ModelInfo> {
	const explicitInput = positiveInt(entry.max_input_tokens);
	const contextWindow =
		positiveInt(entry.context_length) ??
		positiveInt(entry.max_model_len) ??
		positiveInt(entry.max_context_length) ??
		explicitInput;
	const maxInputTokens = explicitInput ?? contextWindow;
	const maxOutputTokens =
		positiveInt(entry.max_output_tokens) ??
		positiveInt(record(entry.top_provider).max_completion_tokens);

	// Conditional spreads throughout: an explicit `undefined` would overwrite
	// the baseline rather than defer to it.
	return {
		...(contextWindow !== undefined && { maxContextLength: contextWindow }),
		...(maxInputTokens !== undefined && { maxInputTokens }),
		...(maxOutputTokens !== undefined && { maxOutputTokens }),
	};
}

/**
 * Capability fields this endpoint positively claims for one model. Only
 * positive signals appear; everything else defers to the baseline, so an
 * endpoint that publishes nothing lands exactly where it does today.
 */
function capabilityHints(entry: Record<string, unknown>): Partial<ModelInfo> {
	return {
		...tokenLimits(entry),
		// `supportsToolResultImages` stays at the baseline `false` even for a
		// vision model: images in *tool results* are a stronger claim, and with
		// it false the host relocates them into a follow-up user message, which
		// works on any endpoint that reads images at all.
		...(acceptsImages(entry) && {
			supportsImages: true,
			supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
		}),
	};
}

/** Parse a `/v1/models` response, stamped with the discovering provider's id. */
function parseOpenAICompatibleModels(data: unknown, providerId: ResolvedProviderId): ModelInfo[] {
	const entries = isRecord(data) && Array.isArray(data.data) ? data.data : [];

	const models: ModelInfo[] = [];
	for (const entry of entries) {
		if (!isRecord(entry) || typeof entry.id !== "string" || entry.id === "") {
			continue;
		}
		models.push({
			id: entry.id,
			name: entry.id,
			providerId,
			// Neither field is part of the inferred capability set, and both are
			// required on ModelInfo. Node and Positron overwrite `vendor` with
			// their catalog display value downstream.
			vendor: "openai-compatible",
			...inferModelCapabilities(providerId, entry.id),
			...capabilityHints(entry),
		});
	}
	return models;
}

function createOpenAICompatibleModelFetcher(providerId: ResolvedProviderId, logger: Logger) {
	return createCachedModelFetcher<ApiKeyCredentials>({
		providerId,
		resolveUrl: (credentials) => {
			const base = (credentials.baseUrl?.trim() || "").replace(/\/+$/, "");
			return new URL("models", base + "/").toString();
		},
		hasCredentials: (credentials) => Boolean(credentials.baseUrl?.trim()),
		createHeaders: (credentials): Record<string, string> =>
			credentials.apiKey ? { Authorization: `Bearer ${credentials.apiKey}` } : {},
		parseResponse: (data) => parseOpenAICompatibleModels(data, providerId),
		fallbackModels: [],
		logger,
	});
}

const openAICompatibleClientFactory: ClientFactory = (credentials) => {
	if (credentials.type !== "apikey") {
		throw new Error(
			`openai-compatible provider requires API key credentials, got: ${credentials.type}`,
		);
	}
	// customHeaders are injected by the custom fetch wrapper; passing them
	// to OpenAIClient's SDK `headers` option as well would be redundant.
	return new OpenAIClient({
		apiKey: credentials.apiKey,
		baseUrl: credentials.baseUrl?.trim(),
		apiMode: "completions",
		customFetch: createOpenAICompatibleFetch(
			"OpenAI Compatible",
			credentials.apiKey,
			credentials.customHeaders,
		),
	});
};

/** Register the built-in `openai-compatible` provider. */
export function registerOpenAICompatibleProvider(registry: ProviderRegistry, logger: Logger): void {
	registry.registerModelFetcher(
		"openai-compatible",
		createOpenAICompatibleModelFetcher("openai-compatible", logger),
	);
	registry.registerClientFactory("openai-compatible", openAICompatibleClientFactory);
}

/**
 * Register a `providers.custom` entry with `type: "openai-compatible"`.
 *
 * Discovery is custom-id keyed so each endpoint has independent cache state
 * and its models carry the custom id. The client factory is kind-keyed so a
 * live type change resolves through the catalog's current `clientKind`
 * instead of leaving a stale factory registered under the custom id.
 */
export function registerCustomOpenAICompatibleProvider(
	registry: ProviderRegistry,
	providerId: ResolvedProviderId,
	logger: Logger,
): void {
	registry.registerModelFetcher(providerId, createOpenAICompatibleModelFetcher(providerId, logger));
	registry.registerClientFactory("openai-compatible", openAICompatibleClientFactory);
}
