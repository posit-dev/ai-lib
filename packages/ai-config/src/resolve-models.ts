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
 */

import type { CustomModel, ModelInfoLike, ModelsBlock } from "./types";

/**
 * Apply the model-selection pipeline to a set of discovered models,
 * producing the final resolved model list.
 *
 * @param modelsBlock - The `models` config block for this provider (may be undefined).
 * @param discovered - Models returned by provider discovery (empty if discovery is off).
 * @returns The resolved list of models after overrides, allow/deny filtering.
 */
export function resolveModels(
	modelsBlock: ModelsBlock | undefined,
	discovered: readonly ModelInfoLike[],
): ModelInfoLike[] {
	if (!modelsBlock) {
		// No models block — pass through discovered models unchanged.
		return [...discovered];
	}

	// 1. Discovery gate
	const base: ModelInfoLike[] = modelsBlock.discovery === "off" ? [] : [...discovered];

	// 2. Add custom models
	const customs = modelsBlock.custom;
	if (customs) {
		for (const custom of customs) {
			base.push(customModelToModelInfo(custom));
		}
	}

	// 3. Apply overrides
	const overrides = modelsBlock.overrides;
	if (overrides) {
		for (let i = 0; i < base.length; i++) {
			const model = base[i];
			const override = overrides[model.id];
			if (override) {
				base[i] = applyOverride(model, override);
			}
		}
	}

	// 4. Allow filter (exclusive when non-empty)
	let result: ModelInfoLike[];
	const allow = modelsBlock.allow;
	if (allow && allow.length > 0) {
		const allowSet = new Set(allow);
		result = base.filter((m) => allowSet.has(m.id));
	} else {
		result = base;
	}

	// 5. Deny filter (always wins)
	const deny = modelsBlock.deny;
	if (deny && deny.length > 0) {
		const denySet = new Set(deny);
		result = result.filter((m) => !denySet.has(m.id));
	}

	return result;
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
		supportedInputMediaTypes: custom.supportedInputMediaTypes,
		thinkingEffortLevels: custom.thinkingEffortLevels,
	};
}

/** Merge an override onto a model, returning a new object. */
function applyOverride(model: ModelInfoLike, override: Record<string, unknown>): ModelInfoLike {
	const result = { ...model };
	for (const [key, value] of Object.entries(override)) {
		if (value !== undefined) {
			(result as Record<string, unknown>)[key] = value;
		}
	}
	return result;
}
