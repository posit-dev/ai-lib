/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Capability inference and family classification for models served through a
 * Portkey gateway.
 *
 * Hosted Portkey serves an integrated Model Catalog whose routed ids carry a
 * provider-slug prefix (`@provider-slug/model`). `classifyPortkeyModel` owns
 * family recognition for those catalog entries: `canonical_slug` is the
 * trusted underlying-model id when present, falling back to the routed `id`
 * with the `@slug/` prefix stripped. The slug / catalog provider field is the
 * provider signal for the OpenAI branch (mirroring litellm-helpers' veto
 * rule) so a lookalike alias on another upstream is not classified as OpenAI.
 *
 * The classifier returns one per-entry decision object — family,
 * capabilityModelId, supported-or-excluded (with reason), protocol — and both
 * discovery filtering and protocol/capability stamping consume that single
 * object, so routing and capabilities cannot disagree.
 *
 * Provisional support policy, pending the Phase 0 hosted probe matrix:
 * only the Claude family is supported (Anthropic passthrough is verified on
 * the OSS gateway; hosted Claude routing is the lowest-risk surface). OpenAI,
 * Gemini, and other families are excluded from discovery until their
 * chat-completions / Responses-continuity probes pass.
 */

import type { InferredModelCapabilities } from "../types.js";
import type { Protocol } from "../vocabulary.js";
import { getAnthropicModelCapabilities } from "./anthropic-helpers.js";

// ---------------------------------------------------------------------------
// Catalog-slug convention
// ---------------------------------------------------------------------------

/**
 * Strip the Portkey Model Catalog provider-slug prefix from a routed model id:
 * `@provider-slug/model` → `model`. Ids without the `@slug/` shape are
 * returned unchanged.
 *
 * This is the **single owner** of the `@slug/` convention — consumed by
 * `classifyPortkeyModel` here and by the cache-keepalive classifier in
 * consumers. Never re-implement the strip locally: the two strips must agree
 * on what a slug is forever.
 */
export function stripCatalogSlug(id: string): string {
	if (!id.startsWith("@")) return id;
	const slash = id.indexOf("/");
	if (slash === -1) return id;
	return id.slice(slash + 1);
}

/** The `@slug` prefix of a catalog-routed id, without the `@`; undefined when the id is bare. */
function catalogSlug(id: string): string | undefined {
	if (!id.startsWith("@")) return undefined;
	const slash = id.indexOf("/");
	if (slash === -1) return undefined;
	return id.slice(1, slash);
}

// ---------------------------------------------------------------------------
// Family classification
// ---------------------------------------------------------------------------

/**
 * Upstream family of a Portkey catalog entry, as far as routing is concerned.
 *
 * Granular enough for per-family exclusion (a flat claude/openai/other could
 * not exclude Gemini while shipping other chat families).
 */
// TODO(phase0-gate): widen per probe matrix — the family set is fixed in
// Phase 1 from the Phase 0 outcome matrix.
export type PortkeyModelFamily = "claude" | "openai" | "gemini" | "other";

export interface PortkeyModelClassificationInput {
	/** The routed catalog id — the exact string sent as the request model. */
	id: string;
	/** The trusted underlying-model id from the catalog entry, when present. */
	canonicalSlug?: string | null;
	/** The catalog entry's provider field (upstream service), when present. */
	provider?: string | null;
}

/**
 * The per-entry classification decision. Both discovery filtering and
 * protocol/capability stamping consume this one object (single source of
 * truth).
 */
export type PortkeyModelClassification = {
	family: PortkeyModelFamily;
	/** The id to feed into capability inference (underlying model, not the routed alias). */
	capabilityModelId: string;
} & ({ supported: true; protocol: Protocol } | { supported: false; exclusionReason: string });

/** Provider signals that name an OpenAI upstream (Azure serves the same models). */
const OPENAI_PROVIDER_SIGNALS = new Set(["openai", "azure", "azure-openai"]);

/** Provider signals that name a Gemini upstream. */
const GEMINI_PROVIDER_SIGNALS = new Set(["google", "gemini", "vertex-ai", "vertex_ai"]);

/** The bare model portion after the last `/` (`anthropic/claude-x` → `claude-x`). */
function bareModelId(modelId: string): string {
	const slash = modelId.lastIndexOf("/");
	return slash === -1 ? modelId : modelId.slice(slash + 1);
}

function isClaudeId(modelId: string): boolean {
	return (
		getAnthropicModelCapabilities(modelId) !== undefined ||
		getAnthropicModelCapabilities(bareModelId(modelId)) !== undefined
	);
}

function isOpenAIId(modelId: string): boolean {
	const bare = bareModelId(modelId).toLowerCase();
	// Stable namespaces (not the finite capability table) so future version
	// bumps are recognized; the provider signal prevents lookalike ids on
	// other upstreams from being treated as OpenAI.
	return bare.startsWith("gpt-") || bare.startsWith("chatgpt-") || /^o\d(?:$|[-.])/.test(bare);
}

function isGeminiId(modelId: string): boolean {
	return bareModelId(modelId).toLowerCase().startsWith("gemini");
}

/**
 * Classify a Portkey Model Catalog entry by upstream family and decide
 * whether it is supported (with its wire protocol) or excluded (with a
 * reason).
 *
 * `canonical_slug` is the trusted underlying-model signal when the catalog
 * provides it; otherwise the routed `id` with `@slug/` stripped is the model
 * signal. The catalog `provider` field (or, failing that, the `@slug` prefix)
 * is the provider signal consulted by the non-Claude branches — a slug that
 * merely *looks* Claude-like (`@claude-prod/approved-assistant`) never makes
 * the entry Claude, because classification runs on the stripped id.
 */
export function classifyPortkeyModel(
	input: PortkeyModelClassificationInput,
): PortkeyModelClassification {
	const canonical = input.canonicalSlug?.trim();
	const capabilityModelId = canonical || stripCatalogSlug(input.id);

	if (isClaudeId(capabilityModelId)) {
		// Claude families speak the Anthropic-shaped passthrough route, where
		// explicit cache breakpoints and thinking-signature round-trips survive.
		return {
			family: "claude",
			capabilityModelId,
			supported: true,
			protocol: "anthropic-messages",
		};
	}

	const providerSignal = (input.provider?.trim() || catalogSlug(input.id))?.toLowerCase();

	// TODO(phase0-gate): widen per probe matrix. OpenAI and Gemini families are
	// classified (so per-family exclusion is expressible) but NOT supported yet:
	// their chat-completions / Responses-continuity probes against Portkey have
	// not run, so no `openai-responses` / `openai-chat` protocol is emitted.
	if (isOpenAIId(capabilityModelId)) {
		const providerIsOpenAI = !providerSignal || OPENAI_PROVIDER_SIGNALS.has(providerSignal);
		if (providerIsOpenAI) {
			return {
				family: "openai",
				capabilityModelId,
				supported: false,
				exclusionReason: "OpenAI-family routing through Portkey is pending Phase 0 probe",
			};
		}
	}
	if (
		isGeminiId(capabilityModelId) ||
		(providerSignal && GEMINI_PROVIDER_SIGNALS.has(providerSignal))
	) {
		return {
			family: "gemini",
			capabilityModelId,
			supported: false,
			exclusionReason: "Gemini-family routing through Portkey is pending Phase 0 probe",
		};
	}
	return {
		family: "other",
		capabilityModelId,
		supported: false,
		exclusionReason: "non-Claude families through Portkey are pending Phase 0 probe",
	};
}

// ---------------------------------------------------------------------------
// Capability inference
// ---------------------------------------------------------------------------

/**
 * Infer capabilities for a Portkey-served model id. Catalog-slug prefixes are
 * stripped internally, so both routed ids (`@anthropic-prod/claude-…`) and
 * underlying ids work.
 *
 * @returns Anthropic capabilities for Claude-family ids, `undefined` for
 *          everything else (callers apply conservative defaults).
 *
 * Provisional Claude-or-conservative rule (recorded pending the Phase 1
 * ID-only decision): unlike litellm's ID-only helper, recognized OpenAI ids
 * do NOT get the OpenAI capability table yet, because no OpenAI-family
 * route is supported through Portkey.
 */
// TODO(phase1): revisit against litellm's rule (recognized OpenAI ids →
// OpenAI caps with the input-token reservation) once the Phase 0 probes fix
// the supported family set.
export function getPortkeyModelCapabilities(
	modelId: string,
): Partial<InferredModelCapabilities> | undefined {
	const stripped = stripCatalogSlug(modelId);
	// TODO(phase0-gate): widen per probe matrix — add the OpenAI-caps branch
	// (getOpenAIModelCapabilities + openaiMaxInputTokens) when the OpenAI
	// family passes its probes.
	return (
		getAnthropicModelCapabilities(stripped) ?? getAnthropicModelCapabilities(bareModelId(stripped))
	);
}
