/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The deep config-resolver seam.
 *
 * `resolveProviderCatalog({ sources })` owns the **entire precedence stack**.
 * Hosts only *contribute sources*; the precedence knowledge (rank per source
 * kind, the sealed-enforced invariant, deep-merge and array-replace rules)
 * lives here in one place.
 *
 * This is a **pure** function — no filesystem, no `process`, no `vscode`. The
 * node entry (`ai-config/node`) reads the file + env into sources and calls
 * this; a Positron host builds an `authentication.*` source (Phase 6); a
 * standalone consumer (Notebooks) assembles its own sources. All of them get
 * identical precedence semantics for free.
 */

import { buildCatalog } from "./build-catalog";
import { mergeConfigFragments } from "./enforce";
import type { EnablementLayer } from "./resolve-enabled";
import { providersConfigSchema } from "./schema";
import type {
	EnforcedProvidersConfig,
	LoggerLike,
	PlatformBaseline,
	ProvidersConfig,
	ResolvedProvider,
} from "./types";

// ---------------------------------------------------------------------------
// Source model
// ---------------------------------------------------------------------------

/**
 * The precedence role of a config source. The resolver maps each kind to a
 * fixed rank (see `KIND_RANK`), so a host declares *what it is* rather than
 * *where it sits* — precedence knowledge stays inside ai-config.
 *
 * Ordering, highest precedence → lowest:
 * - `enforced` — sealed admin overlay (`POSIT_AI_PROVIDERS_ENFORCED`); always wins.
 * - `user` — the user's `providers.json`.
 * - `host` — transitional host settings (Positron `authentication.*`).
 * - `default` — Workbench admin defaults (`POSIT_AI_PROVIDERS_DEFAULT`).
 *
 * Below all sources sits the `PlatformBaseline` (passed separately).
 */
export type ProviderConfigSourceKind = "enforced" | "user" | "host" | "default";

/** Fixed precedence rank per source kind — lower number = higher precedence. */
const KIND_RANK: Readonly<Record<ProviderConfigSourceKind, number>> = {
	enforced: 0,
	user: 1,
	host: 2,
	default: 3,
};

/**
 * A single config layer contributed by a file, env var, or host.
 *
 * Every source carries a fragment in the relaxed `EnforcedProvidersConfig`
 * shape (custom entry `type` optional) so any layer may contribute partial
 * provider blocks; the merged result is validated with the full schema.
 */
export interface ProviderConfigSource {
	/** Precedence role — determines where this source sits in the stack. */
	readonly kind: ProviderConfigSourceKind;
	/** Diagnostic label (e.g. "providers.json", "POSIT_AI_PROVIDERS_ENFORCED"). */
	readonly label?: string;
	/** The config fragment this source contributes. */
	readonly config: EnforcedProvidersConfig;
}

// ---------------------------------------------------------------------------
// Resolver options
// ---------------------------------------------------------------------------

/** Options for {@link resolveProviderCatalog}. */
export interface ResolveProviderCatalogOptions {
	/**
	 * The config sources to fold, in any order. The resolver sorts them by
	 * `kind` rank, so precedence between *different* kinds is independent of
	 * array position. Among sources of the **same** kind, the sort is stable —
	 * the earlier array entry takes precedence.
	 */
	readonly sources: readonly ProviderConfigSource[];

	/** Platform baseline (e.g. standalone: all enabled, RStudio: positai only). */
	readonly baseline: PlatformBaseline;

	/** If true, reject `providers.custom` entries (external builds). */
	readonly external?: boolean;

	/**
	 * Environment variables for the non-secret connection overlay.
	 * Env vars have highest precedence: env > file > defaults.
	 *
	 * This is a **pure** function: when omitted it defaults to `{}` (no env
	 * overlay), never `process.env`. Node callers that want the process
	 * environment inject it explicitly (the `ai-config/node` seams do).
	 */
	readonly envVars?: Record<string, string | undefined>;

	/** Optional logger for diagnostics and validation warnings. */
	readonly logger?: LoggerLike;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve an ordered stack of config sources + platform baseline into the
 * full resolved provider catalog.
 *
 * Precedence is applied in one place:
 * - **Connection / model policy:** sources are deep-merged from lowest →
 *   highest precedence, so higher sources win per key. The sealed `enforced`
 *   source is merged **last**, so its keys can never be overridden.
 *   `customHeaders` merge per leaf-key; `allow`/`deny` arrays replace wholesale.
 * - **Enablement:** resolved from the kept per-source `providers` maps ordered
 *   highest → lowest, preserving "id beats default" within each layer (see
 *   {@link resolveEnabled}). The enforced layer is on top.
 *
 * **Invalid-source tolerance.** Structural validity is a property of the whole
 * source *set*, not the merge order — a relaxed fragment may legitimately omit
 * a custom entry's `type` when **any** other source (higher or lower) supplies
 * it. So the full stack is validated first; a lower `default`/`host` partial
 * completed by a higher `user` source (and vice versa) stays valid. Only when
 * the full merge is genuinely invalid (a custom entry no source completes) are
 * offending **relaxed** overlays dropped one at a time — never the authoritative
 * `user` source — preferring a single removal that restores validity so an
 * unrelated valid overlay (e.g. a `host` source below a bad `enforced` overlay,
 * or a good `enforced` above a bad `default`) is preserved. Connection and
 * enablement use the identical kept-source order, so a dropped source never
 * contributes to either.
 */
export function resolveProviderCatalog(
	opts: ResolveProviderCatalogOptions,
): readonly ResolvedProvider[] {
	const { sources, baseline, external, envVars, logger } = opts;

	// Order sources by precedence rank (highest precedence first). Array.sort
	// is stable, so same-kind sources keep their array order (earlier wins).
	const highestFirst = [...sources].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

	// Validate the full stack first. If it's invalid, drop offending relaxed
	// overlays until it validates (see doc comment).
	let kept = highestFirst;
	let resolved = mergeAndValidate(kept);

	while (!resolved.success) {
		// The `user` source is validated at read time, so it is always valid on
		// its own and is never dropped; only relaxed overlays are candidates.
		const relaxedLowestFirst = kept.filter((s) => s.kind !== "user").reverse();
		if (relaxedLowestFirst.length === 0) {
			break; // Defensive: user alone always validates.
		}

		// Prefer a single removal that restores validity (keeps unrelated valid
		// overlays); otherwise drop the lowest-precedence relaxed overlay and
		// re-check.
		const victim =
			relaxedLowestFirst.find((s) => mergeAndValidate(without(kept, s)).success) ??
			relaxedLowestFirst[0];

		logger?.warn(
			`[ai-config] Config source ${describeSource(victim)} produces an invalid merged result: ${formatZodErrors(resolved.error)}. Ignoring this source.`,
		);
		kept = without(kept, victim);
		resolved = mergeAndValidate(kept);
	}

	const resolvedConfig: ProvidersConfig = resolved.success ? resolved.data : {};
	const enabledLayers = kept.map<EnablementLayer>((s) => s.config.providers);

	return buildCatalog(resolvedConfig, enabledLayers, baseline, { external, logger, envVars });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fold a highest-first source list from lowest → highest precedence into a
 * single config and validate it with the full schema.
 */
function mergeAndValidate(
	highestFirst: readonly ProviderConfigSource[],
): ReturnType<typeof providersConfigSchema.safeParse> {
	let merged: EnforcedProvidersConfig = {};
	for (let i = highestFirst.length - 1; i >= 0; i--) {
		merged = mergeConfigFragments(merged, highestFirst[i].config);
	}
	return providersConfigSchema.safeParse(merged);
}

function without(
	sources: readonly ProviderConfigSource[],
	victim: ProviderConfigSource,
): ProviderConfigSource[] {
	return sources.filter((s) => s !== victim);
}

function describeSource(source: ProviderConfigSource): string {
	return source.label ? `"${source.label}" (${source.kind})` : source.kind;
}

function formatZodErrors(error: { issues: Array<{ message: string; path?: unknown[] }> }): string {
	return error.issues.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`).join("; ");
}
