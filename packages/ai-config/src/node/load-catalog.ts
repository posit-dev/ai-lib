/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Load the resolved provider catalog from disk.
 *
 * This is the **public read seam** — the one function consumers call to get
 * the full provider catalog with enablement, connection, model policy, and
 * client kind resolved from the config sources (file + env fragments) +
 * platform baseline.
 *
 * The precedence stack itself lives in the pure `resolveProviderCatalog()`
 * seam; this function only reads the default node sources and delegates.
 */

import { resolveProviderCatalog } from "../resolve-catalog";
import type { ResolvedProvider } from "../types";
import { loadConfigSources } from "./load-config";
import type { LoadCatalogOptions } from "./types";

/**
 * Load ~/.posit/ai/providers.json, read the enforced/default env overlays,
 * resolve the platform baseline, and return the full resolved provider
 * catalog.
 *
 * Consumers iterate the returned catalog instead of the static
 * `PROVIDER_REGISTRY`. Each entry carries: `id`, `clientKind`, `enabled`,
 * `connection`, and `models` (policy and custom declarations, not discovered
 * models).
 *
 * The file need not exist — a missing file is equivalent to `{}`.
 *
 * @param opts - Platform baseline and optional path/env overrides.
 * @returns Array of resolved provider entries (built-ins + custom).
 */
export async function loadResolvedProviderCatalog(
	opts: LoadCatalogOptions,
): Promise<readonly ResolvedProvider[]> {
	// This is the node seam — inject `process.env` so the pure resolver stays
	// free of Node globals while node callers keep env-based overrides.
	const env = opts.envVars ?? process.env;

	const sources = await loadConfigSources({
		configPath: opts.configPath,
		enforcedEnvVar: opts.enforcedEnvVar,
		defaultEnvVar: opts.defaultEnvVar,
		env,
		logger: opts.logger,
	});

	// Fold in any host/additional sources (e.g. Positron's `authentication.*`
	// host source) by reading each once. The watch path subscribes to their
	// change signals separately; this load-path fold is load-bearing because
	// the watch's initial rebuild does not emit, so without it the first
	// catalog would miss host settings until the first change fires.
	const additional = await Promise.all((opts.additionalSources ?? []).map((p) => p.read()));
	for (const source of additional) {
		if (source) {
			sources.push(source);
		}
	}

	return resolveProviderCatalog({
		sources,
		baseline: opts.baseline,
		external: opts.external,
		envVars: env,
		logger: opts.logger,
	});
}
