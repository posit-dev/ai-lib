/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Model selection pipeline.
 *
 * The ONE public resolver that stays in the API — it genuinely needs
 * runtime-discovered models the catalog cannot hold.
 *
 * Pipeline:
 * 1. If `discovery === "off"`, discovered = [].
 * 2. Candidates = discovered + custom models.
 * 3. Apply overrides to matching candidates by id.
 * 4. If `allow` is non-empty, filter to only allowed ids (exclusive allowlist).
 * 5. Subtract `deny` (deny always wins).
 * 6. Resolve protocol + endpoint for each surviving model.
 *
 * Protocol/endpoint resolution precedence (per the spec):
 *   user-configured routing (from overrides/custom)
 *     → provider config (protocol, endpoints, baseUrl)
 *     → discovered model protocol (built-in inference fallback)
 *
 * A discovered model's `protocol` field is built-in inference (e.g. Bedrock
 * setting `"anthropic"` on Claude models). An override's or custom model's
 * `protocol` is a user-configured value. These have different precedence
 * relative to provider config, so the pipeline tracks them separately.
 */

import { resolveEndpoint } from "./resolve-connection";
import type {
	CustomModel,
	ModelInfoLike,
	ModelOverride,
	ModelsBlock,
	ResolvedConnection,
	ResolvedModelInfo,
} from "./types";
import type { Protocol } from "./vocabulary";

/**
 * Map from legacy bridge protocol values to the widened Protocol enum.
 * The bridge currently uses `"anthropic" | "openai"` on ModelInfo.protocol;
 * ai-config uses the richer enum. This map normalizes the legacy values so
 * endpoint lookup works with either form.
 */
const LEGACY_PROTOCOL_MAP: Readonly<Record<string, Protocol>> = {
	anthropic: "anthropic-messages",
	openai: "openai-chat",
};

/** Normalize a protocol value, mapping legacy bridge values to the widened enum. */
function normalizeProtocol(protocol: string | undefined): Protocol | undefined {
	if (protocol === undefined) {
		return undefined;
	}
	return (LEGACY_PROTOCOL_MAP[protocol] ?? protocol) as Protocol;
}

/**
 * Routing fields explicitly set by user config (overrides or custom model
 * definitions). Tracked separately from discovered model metadata so the
 * precedence ladder can distinguish "user said this" from "bridge inferred
 * this."
 */
interface UserRouting {
	readonly protocol: Protocol | string | undefined;
	readonly baseUrl: string | undefined;
}

/** No user-configured routing — discovered models start with this. */
const NO_USER_ROUTING: UserRouting = { protocol: undefined, baseUrl: undefined };

/** A model paired with its user-configured routing (pipeline-internal). */
interface PipelineEntry {
	model: ModelInfoLike;
	userRouting: UserRouting;
}

/**
 * Apply the model-selection pipeline to a set of discovered models,
 * producing the final resolved model list with routing information.
 *
 * @param modelsBlock - The `models` config block for this provider (may be undefined).
 * @param discovered - Models returned by provider discovery (empty if discovery is off).
 * @param providerConnection - The provider's resolved connection config (protocol,
 *   endpoints, baseUrl). Used to resolve per-model routing. May be undefined if
 *   no provider config exists.
 * @returns The resolved list of models with `resolvedProtocol` and `resolvedBaseUrl`.
 */
export function resolveModels(
	modelsBlock: ModelsBlock | undefined,
	discovered: readonly ModelInfoLike[],
	providerConnection?: ResolvedConnection,
): ResolvedModelInfo[] {
	if (!modelsBlock) {
		// No models block — pass through discovered models with routing resolved.
		// Discovered protocol is built-in inference only (lowest precedence).
		return discovered.map((m) => attachRouting(m, NO_USER_ROUTING, providerConnection));
	}

	// 1. Discovery gate
	const base: PipelineEntry[] =
		modelsBlock.discovery === "off"
			? []
			: discovered.map((m) => ({ model: m, userRouting: NO_USER_ROUTING }));

	// 2. Add custom models (protocol/baseUrl are user-configured)
	const customs = modelsBlock.custom;
	if (customs) {
		for (const custom of customs) {
			base.push({
				model: customModelToModelInfo(custom),
				userRouting: { protocol: custom.protocol, baseUrl: custom.baseUrl },
			});
		}
	}

	// 3. Apply overrides (protocol/baseUrl from overrides are user-configured)
	const overrides = modelsBlock.overrides;
	if (overrides) {
		for (let i = 0; i < base.length; i++) {
			const entry = base[i];
			const override = overrides[entry.model.id];
			if (override) {
				base[i] = applyOverrideEntry(entry, override);
			}
		}
	}

	// 4. Allow filter (exclusive when non-empty)
	let result: PipelineEntry[];
	const allow = modelsBlock.allow;
	if (allow && allow.length > 0) {
		const allowSet = new Set(allow);
		result = base.filter((e) => allowSet.has(e.model.id));
	} else {
		result = base;
	}

	// 5. Deny filter (always wins)
	const deny = modelsBlock.deny;
	if (deny && deny.length > 0) {
		const denySet = new Set(deny);
		result = result.filter((e) => !denySet.has(e.model.id));
	}

	// 6. Resolve routing for each surviving model
	return result.map((e) => attachRouting(e.model, e.userRouting, providerConnection));
}

/**
 * Resolve protocol and endpoint for a model, applying the correct precedence:
 *
 * Protocol:
 *   1. User-configured (from override or custom model) — highest
 *   2. Provider config protocol — middle
 *   3. Discovered model protocol (built-in inference) — lowest
 *
 * Endpoint/baseUrl:
 *   1. User-configured baseUrl (from override or custom model) — highest
 *   2. Provider endpoints[resolvedProtocol] — middle
 *   3. Provider baseUrl — lower
 *   4. undefined (caller falls back to built-in defaults) — lowest
 */
function attachRouting(
	model: ModelInfoLike,
	userRouting: UserRouting,
	providerConnection: ResolvedConnection | undefined,
): ResolvedModelInfo {
	// Protocol: user routing → provider config → discovered model (inference).
	// Normalize legacy bridge values ("anthropic" → "anthropic-messages", etc.)
	// so endpoint lookup matches the widened Protocol enum.
	const rawProtocol = userRouting.protocol ?? providerConnection?.protocol ?? model.protocol;
	const resolvedProtocol = normalizeProtocol(rawProtocol);

	// BaseUrl: user routing → provider endpoints[protocol] → provider baseUrl
	const resolvedBaseUrl = resolveEndpoint(
		userRouting.baseUrl,
		providerConnection,
		resolvedProtocol,
	);

	return {
		...model,
		resolvedProtocol,
		resolvedBaseUrl,
	};
}

/** Convert a custom model definition to a ModelInfoLike. */
function customModelToModelInfo(custom: CustomModel): ModelInfoLike {
	return {
		id: custom.id,
		name: custom.name,
		maxContextLength: custom.maxContextLength,
		supportsTools: custom.supportsTools,
		supportsImages: custom.supportsImages,
		supportsToolResultImages: custom.supportsToolResultImages,
		supportsWebSearch: custom.supportsWebSearch,
		family: custom.family,
		maxInputTokens: custom.maxInputTokens,
		maxOutputTokens: custom.maxOutputTokens,
		protocol: custom.protocol,
		baseUrl: custom.baseUrl,
		supportedInputMediaTypes: custom.supportedInputMediaTypes,
		thinkingEffortLevels: custom.thinkingEffortLevels,
	};
}

/**
 * Apply an override to a pipeline entry. Merges metadata onto the model and
 * promotes any routing fields (protocol, baseUrl) from the override into the
 * user-routing bag.
 */
function applyOverrideEntry(entry: PipelineEntry, override: ModelOverride): PipelineEntry {
	const model = { ...entry.model };
	for (const [key, value] of Object.entries(override)) {
		if (value !== undefined) {
			(model as Record<string, unknown>)[key] = value;
		}
	}

	return {
		model,
		userRouting: {
			// Override routing takes precedence over any prior user routing
			// (e.g. a custom model that also gets overridden).
			protocol: override.protocol ?? entry.userRouting.protocol,
			baseUrl: override.baseUrl ?? entry.userRouting.baseUrl,
		},
	};
}
