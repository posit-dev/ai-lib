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
 * - **Enablement:** resolved from the accepted per-source `providers` maps
 *   ordered highest → lowest, preserving "id beats default" within each layer
 *   (see {@link resolveEnabled}). The enforced layer is on top.
 *
 * **Invalid-source tolerance.** Sources are folded lowest → highest and the
 * accumulated config is validated after each one. A source whose contribution
 * makes the merge structurally invalid (e.g. a relaxed fragment introduces a
 * custom entry with no `type` that no lower source completes) is dropped with
 * a warning; **every other valid source is preserved** — so a valid `host`
 * source is not erased by an invalid `enforced`/`default` overlay above it.
 * Connection and enablement use the identical accepted-source order, so a
 * dropped source never contributes to either.
 */
export function resolveProviderCatalog(
	opts: ResolveProviderCatalogOptions,
): readonly ResolvedProvider[] {
	const { sources, baseline, external, envVars, logger } = opts;

	// Order sources by precedence rank (highest precedence first). Array.sort
	// is stable, so same-kind sources keep their array order (earlier wins).
	const highestFirst = [...sources].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);

	// Fold lowest → highest precedence, validating after each source so the
	// sealed enforced source (rank 0) is applied last and an individually-bad
	// overlay is dropped without discarding the other sources.
	let mergedValid: EnforcedProvidersConfig = {};
	let resolvedConfig: ProvidersConfig = {};
	const accepted = new Set<ProviderConfigSource>();

	for (let i = highestFirst.length - 1; i >= 0; i--) {
		const source = highestFirst[i];
		const candidate = mergeConfigFragments(mergedValid, source.config);
		const parsed = providersConfigSchema.safeParse(candidate);
		if (parsed.success) {
			mergedValid = candidate;
			resolvedConfig = parsed.data;
			accepted.add(source);
		} else {
			logger?.warn(
				`[ai-config] Config source ${describeSource(source)} produces an invalid merged result: ${formatZodErrors(parsed.error)}. Ignoring this source.`,
			);
		}
	}

	// Enablement layers from the accepted sources, in the same highest-first
	// order used for the merge, so connection and enablement never disagree.
	const enabledLayers = highestFirst
		.filter((s) => accepted.has(s))
		.map<EnablementLayer>((s) => s.config.providers);

	return buildCatalog(resolvedConfig, enabledLayers, baseline, { external, logger, envVars });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeSource(source: ProviderConfigSource): string {
	return source.label ? `"${source.label}" (${source.kind})` : source.kind;
}

function formatZodErrors(error: { issues: Array<{ message: string; path?: unknown[] }> }): string {
	return error.issues.map((i) => `${i.path?.join(".") ?? ""}: ${i.message}`).join("; ");
}
