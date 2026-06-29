/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Load the resolved provider catalog from disk.
 *
 * This is the **public read seam** — the one function consumers call to get
 * the full provider catalog with enablement, connection, model policy, and
 * client kind resolved from the config file + enforced fragment + platform
 * baseline.
 */

import type { ResolvedProvider } from "../types";
import { buildCatalog } from "./build-catalog";
import { loadProvidersConfig } from "./load-config";
import type { LoadCatalogOptions } from "./types";

/**
 * Load ~/.posit/genai/providers.json, enforce the env fragment, resolve the
 * platform baseline, and return the full resolved provider catalog.
 *
 * This is the **single deep read seam** (decisions #9/#10). Consumers iterate
 * the returned catalog instead of the static `PROVIDER_REGISTRY`. Each entry
 * carries: `id`, `clientKind`, `enabled`, `connection`, and `models` (policy
 * and custom declarations, not discovered models).
 *
 * The file need not exist — a missing file is equivalent to `{}`.
 *
 * @param opts - Platform baseline and optional path/env overrides.
 * @returns Array of resolved provider entries (built-ins + custom).
 */
export async function loadResolvedProviderCatalog(
	opts: LoadCatalogOptions,
): Promise<readonly ResolvedProvider[]> {
	const {
		userConfig: _,
		enforcedConfig,
		mergedConfig,
	} = await loadProvidersConfig({
		configPath: opts.configPath,
		enforcedEnvVar: opts.enforcedEnvVar,
		logger: opts.logger,
	});

	return buildCatalog(mergedConfig, enforcedConfig?.providers, opts.baseline, {
		external: opts.external,
		logger: opts.logger,
		envVars: opts.envVars,
	});
}
