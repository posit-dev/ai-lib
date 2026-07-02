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
 * Load ~/.posit/genai/providers.json, read the enforced/default env overlays,
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
	const sources = await loadConfigSources({
		configPath: opts.configPath,
		enforcedEnvVar: opts.enforcedEnvVar,
		defaultEnvVar: opts.defaultEnvVar,
		env: opts.envVars,
		logger: opts.logger,
	});

	return resolveProviderCatalog({
		sources,
		baseline: opts.baseline,
		external: opts.external,
		envVars: opts.envVars,
		logger: opts.logger,
	});
}
