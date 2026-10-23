/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Variant and version of a bare Gemini id: `gemini-3.8-flash`,
 * `gemini-3.1-pro-preview`, `gemini-2.5-flash-preview-09-2025`. Suffixes after
 * the variant are ignored. `flash-lite` precedes `flash` so Flash-Lite ids
 * aren't read as Flash. Gemma, `-latest` aliases, and dash-joined versions
 * (`gemini-2-5-pro`) don't match.
 */
const GEMINI_VARIANT_ID = /^gemini-(\d+)(?:\.(\d+))?-(flash-lite|flash|pro)(?=$|-)/;

interface ParsedGeminiId {
	variant: string;
	version: readonly [major: number, minor: number];
}

function parseGeminiVariantId(modelId: string): ParsedGeminiId | undefined {
	const m = GEMINI_VARIANT_ID.exec(modelId);
	if (!m) {
		return undefined;
	}
	return { variant: m[3], version: [Number(m[1]), Number(m[2] ?? 0)] };
}

function compareVersions(a: readonly [number, number], b: readonly [number, number]): number {
	return a[0] - b[0] || a[1] - b[1];
}

/** The known id a Gemini id inherits from. */
export interface GeminiVariantDonor {
	/** The donor's id, as given in `knownIds`. */
	id: string;
	/** Whether no known id of the variant has a greater version. */
	newest: boolean;
}

/**
 * Find the known id of the same variant (`pro`, `flash`, `flash-lite`) with
 * the greatest version at or below `modelId`'s own, so later versions
 * inherit from the newest known model (`gemini-3.9-flash` → 3.8 Flash).
 * `newest` lets a caller restrict inheritance to versions at or above the
 * variant's newest known id.
 *
 * @returns `undefined` when `modelId` has no recognized variant or no known
 *          id of its variant is at or below its version.
 */
export function findGeminiVariantDonor(
	modelId: string,
	knownIds: Iterable<string>,
): GeminiVariantDonor | undefined {
	const target = parseGeminiVariantId(modelId);
	if (!target) {
		return undefined;
	}
	let best: (ParsedGeminiId & { id: string }) | undefined;
	let newestVersion: readonly [number, number] | undefined;
	for (const id of knownIds) {
		const known = parseGeminiVariantId(id);
		if (known?.variant !== target.variant) {
			continue;
		}
		if (!newestVersion || compareVersions(known.version, newestVersion) > 0) {
			newestVersion = known.version;
		}
		if (
			compareVersions(known.version, target.version) <= 0 &&
			(!best || compareVersions(known.version, best.version) > 0)
		) {
			best = { ...known, id };
		}
	}
	if (!best || !newestVersion) {
		return undefined;
	}
	return { id: best.id, newest: compareVersions(best.version, newestVersion) === 0 };
}
