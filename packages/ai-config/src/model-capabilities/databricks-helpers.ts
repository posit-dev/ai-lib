/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Routing + capability classification for Databricks serving endpoints.
 *
 * Databricks fronts many vendors behind one workspace. Besides the universal
 * OpenAI-compatible chat surface it exposes **native passthrough APIs** per
 * vendor (Anthropic Messages, OpenAI Responses, Gemini generateContent) on both
 * the classic Model Serving surface and the Unity AI Gateway surface. Native
 * routes recover what the chat surface loses (thinking controls, PDF input,
 * Claude cache breakpoints), so each endpoint is classified once — here — into
 * the protocol it will be routed over plus the capabilities that protocol
 * actually offers.
 *
 * The rules are deliberately a **positive identification**: a native protocol is
 * stamped only when the endpoint's structure, the model's identity, and (on the
 * gateway surface) the advertised `api_types` all agree. Everything else gets an
 * explicit `openai-chat` stamp — today's behavior — so a wrong or unknown
 * classification degrades to what already works, never to a broken route.
 * `undefined` is never returned as a protocol.
 *
 * Two outcomes exist because unavailability is real: on the gateway surface an
 * endpoint whose entities cannot all serve gateway chat has no route at all and
 * must not be listed, which is `{ excluded: true }`.
 *
 * This helper is pure: it reads only the endpoint structure handed to it (no
 * network, no clock). `traffic_config` is deliberately not an input — splits
 * change independently of the configuration we observe, so **every configured
 * served entity** participates and the result is entity-order invariant.
 */

import type { InferredModelCapabilities } from "../types.js";
import type { Protocol } from "../vocabulary.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";
import { getGeminiGenerateContentProfile } from "./gemini-generate-content.js";
import { getGeminiModelCapabilities } from "./gemini-helpers.js";
import { completeCapabilities, type CompleteInferredModelCapabilities } from "./infer.js";
import { getOpenAIModelCapabilities, openaiMaxInputTokens } from "./openai-helpers.js";

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/**
 * Which Databricks surface the workspace was pinned to. The surface decides
 * both the base URL family and (for the gateway) whether advertised API types
 * gate native routing.
 */
export type DatabricksSurface = "serving" | "gateway";

/** Native protocols Databricks can be routed over. */
export type DatabricksNativeProtocol =
	| "anthropic-messages"
	| "openai-responses"
	| "google-generative";

/** `served_entities[].foundation_model` as returned by the discovery APIs. */
export interface DatabricksFoundationModelInput {
	readonly name?: string;
	readonly display_name?: string;
	/** Wire APIs this model service exposes, e.g. `"anthropic/v1/messages"`. */
	readonly api_types?: readonly string[];
	readonly ai_gateway_v2_supported?: boolean;
}

/** `served_entities[].external_model` as returned by the discovery APIs. */
export interface DatabricksExternalModelInput {
	readonly name?: string;
	readonly provider?: string;
	readonly task?: string;
}

/**
 * One configured served entity. A pay-per-token foundation model carries
 * `foundation_model`; an external-model route carries `external_model`; a
 * provisioned-throughput or custom endpoint carries only `entity_name` (a Unity
 * Catalog model reference), which is never native-eligible.
 */
export interface DatabricksServedEntityInput {
	readonly entity_name?: string;
	readonly foundation_model?: DatabricksFoundationModelInput;
	readonly external_model?: DatabricksExternalModelInput;
}

export interface DatabricksModelProfileInput {
	readonly surface: DatabricksSurface;
	/** Endpoint name — the `model` value sent at chat time, and the only identity the client sees. */
	readonly endpointName: string;
	/** Endpoint-level task (`llm/v1/chat`, `llm/v1/embeddings`, …); absent on the gateway surface. */
	readonly task?: string;
	/** Every configured served entity (not just the first, and not traffic-weighted). */
	readonly servedEntities: readonly DatabricksServedEntityInput[];
}

/**
 * Classification result. `vendor` rides in the profile rather than in the
 * capability types, which deliberately omit identity metadata.
 */
export type DatabricksModelProfile =
	| { readonly excluded: true }
	| {
			readonly excluded: false;
			readonly protocol: Protocol;
			readonly vendor: string;
			readonly capabilities: CompleteInferredModelCapabilities;
	  };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Serving-endpoint task indicating an OpenAI-style chat interface. */
const CHAT_TASK = "llm/v1/chat";

/** Unity AI Gateway api_type for the unified (MLflow) chat-completions API. */
const GATEWAY_CHAT_API_TYPE = "mlflow/v1/chat/completions";

/**
 * Gateway `api_types` value that must be advertised for each native protocol.
 *
 * `anthropic/v1/messages` is confirmed from a captured gateway discovery
 * response. The other two mirror the documented gateway native request paths
 * (`/ai-gateway/openai/v1/responses`,
 * `/ai-gateway/gemini/v1beta/models/<service>:generateContent`) under the same
 * `<provider>/<version>/<operation>` shape.
 *
 * PHASE0-VERIFY: confirm the exact OpenAI and Gemini `api_types` strings against
 * a real gateway-enabled workspace. A wrong guess degrades safely — the native
 * gate never passes, so those models stay on `openai-chat`.
 */
const NATIVE_API_TYPES: Readonly<Record<DatabricksNativeProtocol, string>> = {
	"anthropic-messages": "anthropic/v1/messages",
	"openai-responses": "openai/v1/responses",
	"google-generative": "gemini/v1beta/generateContent",
};

/**
 * `external_model.provider` values that front an Anthropic-family model.
 * PHASE0-VERIFY: Databricks' provider enum also spells Bedrock
 * `amazon-bedrock`; both spellings are accepted.
 */
const ANTHROPIC_EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set([
	"anthropic",
	"bedrock",
	"amazon-bedrock",
]);

/** `external_model.provider` values that front an OpenAI-family model. */
const OPENAI_EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set(["openai", "azure", "azure-openai"]);

/** `external_model.provider` values that front a Google/Gemini-family model. */
const GOOGLE_EXTERNAL_PROVIDERS: ReadonlySet<string> = new Set([
	"google",
	"gemini",
	"google-cloud-vertex-ai",
	"google-vertex",
]);

/**
 * Image MIME types accepted through the Databricks OpenAI-compatible chat
 * surface. PDF input (which the upstream Anthropic/OpenAI tables include) is not
 * reliably supported there, so the chat fallback excludes it. Native routes use
 * their vendor table's media types unchanged.
 */
const DATABRICKS_IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Vendor label when no entity identity is recognized. */
const DEFAULT_VENDOR = "databricks";

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

/**
 * Strip Databricks-specific prefixes to get the bare upstream model identity.
 *
 * Handles pay-per-token foundation models (`databricks-claude-sonnet-4-5`) and
 * Unity Catalog system models (`system.ai.claude-sonnet-4-5`).
 */
function normalizeDatabricksModelId(modelId: string): string {
	return modelId.replace(/^system\.ai\./, "").replace(/^databricks-/, "");
}

/** Best-known identity of one served entity, falling back to the endpoint name. */
function entityIdentity(entity: DatabricksServedEntityInput, endpointName: string): string {
	return (
		entity.foundation_model?.name ??
		entity.external_model?.name ??
		entity.entity_name ??
		endpointName
	);
}

/**
 * Responses-compatible OpenAI families on Databricks. Provider type alone is not
 * sufficient — the Responses surface accepts only these families, so an
 * unrecognized OpenAI identity falls back to chat completions.
 */
function isResponsesCompatibleOpenAIId(modelId: string): boolean {
	const bare = modelId.toLowerCase();
	return /^gpt-5/.test(bare) || /^gpt-4o/.test(bare);
}

// ---------------------------------------------------------------------------
// Per-entity resolution
// ---------------------------------------------------------------------------

type Capabilities = Partial<InferredModelCapabilities>;

interface EntityResolution {
	/** Deterministic sort key, so aggregation is entity-order invariant. */
	readonly sortKey: string;
	/** Native protocol this entity qualifies for, if any. */
	readonly nativeProtocol: DatabricksNativeProtocol | undefined;
	/** Capabilities for the native route (meaningful only with `nativeProtocol`). */
	readonly nativeCapabilities: Capabilities;
	/** Capabilities for the degraded `openai-chat` route. */
	readonly chatCapabilities: Capabilities;
	/** Recognized vendor, used for the chat fallback's vendor when unanimous. */
	readonly vendor: string | undefined;
	readonly apiTypes: readonly string[];
	readonly gatewayV2Supported: boolean;
}

/** OpenAI table capabilities with the shared-context input reservation applied. */
function openAICapabilities(caps: Capabilities): Capabilities {
	return { ...caps, maxInputTokens: openaiMaxInputTokens(caps) };
}

/**
 * Today's degraded chat-surface capabilities (ported from the bridge's former
 * `model-capabilities/databricks-helpers.ts`): no thinking controls, image-only
 * media types, no PDF.
 */
function chatSurfaceCapabilities(normalizedIdentity: string): Capabilities {
	const claude = getAnthropicModelCapabilities(normalizedIdentity);
	if (claude) {
		const { thinkingEffortLevels: _dropped, ...capabilities } = claude;
		return {
			...capabilities,
			supportsImages: true,
			supportedInputMediaTypes: DATABRICKS_IMAGE_MEDIA_TYPES,
		};
	}

	const openai = getOpenAIModelCapabilities(normalizedIdentity);
	if (openai) {
		const {
			thinkingEffortLevels: _dropped,
			supportedInputMediaTypes: _droppedMediaTypes,
			...capabilities
		} = openAICapabilities(openai);
		return {
			...capabilities,
			...(capabilities.supportsImages
				? { supportedInputMediaTypes: DATABRICKS_IMAGE_MEDIA_TYPES }
				: {}),
		};
	}

	return {};
}

/** Recognized vendor for an identity, independent of routing eligibility. */
function recognizedVendor(normalizedIdentity: string): string | undefined {
	if (getAnthropicModelCapabilities(normalizedIdentity)) return "anthropic";
	if (getOpenAIModelCapabilities(normalizedIdentity)) return "openai";
	if (getGeminiModelCapabilities(normalizedIdentity)) return "google";
	return undefined;
}

/**
 * Native capabilities for a Gemini endpoint: the Gemini table's token limits and
 * media types, with the effort levels the *generateContent* variant profile
 * says are representable (the table's levels are Interactions-API levels).
 */
function geminiNativeCapabilities(
	normalizedEndpointName: string,
	thinkingEffortLevels: readonly string[],
): Capabilities {
	return {
		...getGeminiModelCapabilities(normalizedEndpointName),
		thinkingEffortLevels: [...thinkingEffortLevels],
	};
}

/**
 * Classify one served entity.
 *
 * Native eligibility needs structure *and* identity: a Claude model on a
 * provisioned-throughput or custom endpoint (no `foundation_model`, no eligible
 * `external_model`) is not native-eligible and resolves to chat, as does an
 * unrecognized OpenAI identity or a Gemini endpoint whose variant cannot be
 * reconstructed from its name.
 */
function resolveEntity(
	entity: DatabricksServedEntityInput,
	input: DatabricksModelProfileInput,
	nativeAllowed: boolean,
): EntityResolution {
	const identity = entityIdentity(entity, input.endpointName);
	const normalizedIdentity = normalizeDatabricksModelId(identity);
	const foundationModel = entity.foundation_model;
	const externalProvider = entity.external_model?.provider?.trim().toLowerCase();
	// `foundation_model` is present only for pay-per-token Foundation Model API
	// entities; provisioned-throughput entities reference a Unity Catalog model
	// through `entity_name` instead.
	const isPayPerTokenFoundation = foundationModel !== undefined;
	const isHosted = isPayPerTokenFoundation && identity.startsWith("databricks-");

	const base = {
		sortKey: `${identity} ${externalProvider ?? ""} ${(entity.foundation_model?.api_types ?? []).join(",")}`,
		chatCapabilities: chatSurfaceCapabilities(normalizedIdentity),
		vendor: recognizedVendor(normalizedIdentity),
		apiTypes: foundationModel?.api_types ?? [],
		gatewayV2Supported: foundationModel?.ai_gateway_v2_supported === true,
	} as const;

	if (!nativeAllowed) {
		return { ...base, nativeProtocol: undefined, nativeCapabilities: {} };
	}

	// --- Anthropic Messages ---
	const claudeCapabilities = getAnthropicModelCapabilities(normalizedIdentity);
	if (
		claudeCapabilities &&
		(isPayPerTokenFoundation ||
			(externalProvider !== undefined && ANTHROPIC_EXTERNAL_PROVIDERS.has(externalProvider)))
	) {
		// Native route keeps the Anthropic table verbatim: thinking effort levels
		// and PDF input both survive on `/v1/messages`.
		return {
			...base,
			nativeProtocol: "anthropic-messages",
			nativeCapabilities: claudeCapabilities,
		};
	}

	// --- OpenAI Responses ---
	const openaiCapabilities = getOpenAIModelCapabilities(normalizedIdentity);
	if (
		openaiCapabilities &&
		isResponsesCompatibleOpenAIId(normalizedIdentity) &&
		(isPayPerTokenFoundation ||
			(externalProvider !== undefined && OPENAI_EXTERNAL_PROVIDERS.has(externalProvider)))
	) {
		const capabilities = openAICapabilities(openaiCapabilities);
		// PHASE0-VERIFY: hosted pay-per-token Responses endpoints are unverified
		// for `store: false` / encrypted-reasoning round-trips, which our
		// responses mode sends whenever thinking is on. Until a real workspace
		// confirms the behavior, hosted (`databricks-*`) endpoints keep the
		// conservative treatment — no thinking controls — while external
		// endpoints, which Databricks documents as supporting the full Responses
		// parameter set, keep the table's levels.
		const { thinkingEffortLevels: _dropped, ...withoutThinking } = capabilities;
		return {
			...base,
			nativeProtocol: "openai-responses",
			nativeCapabilities: isHosted ? withoutThinking : capabilities,
		};
	}

	// --- Gemini generateContent ---
	// Gated on the ENDPOINT NAME, not the entity identity: the endpoint name is
	// the only identity the client receives at chat time, so the thinking variant
	// must be reconstructable from it or the wire mapping cannot be built.
	const normalizedEndpointName = normalizeDatabricksModelId(input.endpointName);
	const geminiProfile = getGeminiGenerateContentProfile(normalizedEndpointName);
	if (
		geminiProfile &&
		(isPayPerTokenFoundation ||
			(externalProvider !== undefined && GOOGLE_EXTERNAL_PROVIDERS.has(externalProvider)))
	) {
		return {
			...base,
			nativeProtocol: "google-generative",
			nativeCapabilities: geminiNativeCapabilities(
				normalizedEndpointName,
				geminiProfile.thinkingEffortLevels,
			),
			vendor: "google",
		};
	}

	return { ...base, nativeProtocol: undefined, nativeCapabilities: {} };
}

// ---------------------------------------------------------------------------
// Capability aggregation
// ---------------------------------------------------------------------------

/**
 * Minimum of two limits. `completeCapabilities` always fills these, but the
 * capability type keeps them optional, so an absent value is treated as
 * "no constraint from this entity".
 */
function minDefined(a: number | undefined, b: number | undefined): number | undefined {
	if (a === undefined) return b;
	if (b === undefined) return a;
	return a < b ? a : b;
}

/** Intersection of two optional sets; `undefined` means "unknown", i.e. empty. */
function intersectSets(
	reference: readonly string[] | undefined,
	other: readonly string[] | undefined,
): string[] {
	if (!reference || !other) {
		return [];
	}
	const otherSet = new Set(other);
	return reference.filter((value) => otherSet.has(value));
}

/**
 * Conservative merge across same-protocol entities: minimum numeric limits,
 * intersection of media-type and effort-level sets, boolean AND, and `family`
 * only when unanimous.
 *
 * Each entity's capabilities are completed with the shared baseline first, so an
 * unrecognized entity contributes real (conservative) values rather than gaps —
 * which is what makes intersection meaningful. Set order comes from the entity
 * with the lowest sort key, keeping the result entity-order invariant.
 */
function aggregateCapabilities(
	perEntity: readonly Capabilities[],
): CompleteInferredModelCapabilities {
	const completed = perEntity.map(completeCapabilities);
	const [first, ...rest] = completed;
	if (first === undefined) {
		return completeCapabilities({});
	}
	const merged = rest.reduce<CompleteInferredModelCapabilities>(
		(acc, next) => ({
			...acc,
			// Always filled by `completeCapabilities`, unlike the other two limits.
			maxContextLength: Math.min(acc.maxContextLength, next.maxContextLength),
			maxInputTokens: minDefined(acc.maxInputTokens, next.maxInputTokens),
			maxOutputTokens: minDefined(acc.maxOutputTokens, next.maxOutputTokens),
			supportsTools: acc.supportsTools && next.supportsTools,
			supportsImages: acc.supportsImages && next.supportsImages,
			supportsToolResultImages: acc.supportsToolResultImages && next.supportsToolResultImages,
			supportsWebSearch: acc.supportsWebSearch && next.supportsWebSearch,
			supportedInputMediaTypes: intersectSets(
				acc.supportedInputMediaTypes,
				next.supportedInputMediaTypes,
			),
			thinkingEffortLevels: intersectSets(acc.thinkingEffortLevels, next.thinkingEffortLevels),
			family: acc.family === next.family ? acc.family : undefined,
		}),
		first,
	);
	// An empty intersection is "no support", which the optional-field convention
	// spells as absent rather than as an empty array.
	const { supportedInputMediaTypes, thinkingEffortLevels, ...withoutSets } = merged;
	return {
		...withoutSets,
		...(supportedInputMediaTypes?.length ? { supportedInputMediaTypes } : {}),
		...(thinkingEffortLevels?.length ? { thinkingEffortLevels } : {}),
	};
}

/** The recognized vendor when every entity agrees, otherwise `undefined`. */
function unanimousVendor(entities: readonly EntityResolution[]): string | undefined {
	const [first, ...rest] = entities;
	if (first?.vendor === undefined) {
		return undefined;
	}
	return rest.every((entity) => entity.vendor === first.vendor) ? first.vendor : undefined;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Classify one Databricks serving endpoint into the protocol it should be routed
 * over, the vendor to report, and the capabilities that protocol offers — or
 * exclude it when the pinned surface offers it no route at all.
 */
export function inferDatabricksModelProfile(
	input: DatabricksModelProfileInput,
): DatabricksModelProfile {
	const entities = input.servedEntities;
	// A non-chat endpoint (embeddings, completions) is never native-eligible; its
	// classification only matters as a fallback stamp. External-model endpoints
	// carry the task per entity rather than at the endpoint level.
	const chatCapable =
		input.task === undefined ||
		input.task === CHAT_TASK ||
		entities.some((entity) => entity.external_model?.task === CHAT_TASK);
	const resolutions = entities
		.map((entity) => resolveEntity(entity, input, chatCapable))
		.sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

	// --- Native route: unanimous protocol across every configured entity ---
	const [firstResolution, ...restResolutions] = resolutions;
	const nativeProtocol = firstResolution?.nativeProtocol;
	const nativeUnanimous =
		nativeProtocol !== undefined &&
		restResolutions.every((entity) => entity.nativeProtocol === nativeProtocol);
	// On the gateway surface family identity is not enough: each model service
	// must advertise the wire API we intend to use.
	const nativeAdvertised =
		input.surface === "serving" ||
		resolutions.every((entity) =>
			nativeProtocol === undefined
				? false
				: entity.apiTypes.includes(NATIVE_API_TYPES[nativeProtocol]),
		);

	if (nativeUnanimous && nativeAdvertised) {
		return {
			excluded: false,
			protocol: nativeProtocol,
			vendor: unanimousVendor(resolutions) ?? DEFAULT_VENDOR,
			capabilities: aggregateCapabilities(resolutions.map((entity) => entity.nativeCapabilities)),
		};
	}

	// --- Chat fallback, where the chat route actually exists ---
	// Serving mode always offers chat completions. The gateway only does so when
	// EVERY configured entity advertises it — a mixed endpoint would otherwise be
	// stamped for a route part of its traffic cannot serve. An endpoint with no
	// configured entities advertises nothing, so it is excluded too.
	if (
		input.surface === "gateway" &&
		!(
			resolutions.length > 0 &&
			resolutions.every(
				(entity) => entity.gatewayV2Supported && entity.apiTypes.includes(GATEWAY_CHAT_API_TYPE),
			)
		)
	) {
		return { excluded: true };
	}

	return {
		excluded: false,
		protocol: "openai-chat",
		vendor: unanimousVendor(resolutions) ?? DEFAULT_VENDOR,
		capabilities: aggregateCapabilities(resolutions.map((entity) => entity.chatCapabilities)),
	};
}
