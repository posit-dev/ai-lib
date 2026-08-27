/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Node read seam: assemble source reports, resolve, and render once. */

import { formatConfigIssue } from "../config-issue.js";
import type { SourcedConfigIssue } from "../config-issue.js";
import { createLegacyPositronSourceProviders } from "../legacy-positron-settings/sources.js";
import { resolveProviderCatalogReport } from "../resolve-catalog.js";
import type { ResolvedProvider } from "../types.js";
import { loadConfigSourceReports } from "./load-config.js";
import type { LoadCatalogOptions } from "./types.js";

export interface LoadedProviderCatalogReport {
	readonly catalog: readonly ResolvedProvider[];
	readonly issues: readonly SourcedConfigIssue[];
}

/** Load a resolved catalog together with the complete current issue snapshot. */
export async function loadProviderCatalogReport(
	opts: LoadCatalogOptions,
): Promise<LoadedProviderCatalogReport> {
	const env = opts.envVars ?? process.env;
	const reports = await loadConfigSourceReports({
		configPath: opts.configPath,
		enforcedEnvVar: opts.enforcedEnvVar,
		defaultEnvVar: opts.defaultEnvVar,
		env,
	});

	const legacyProviders = createLegacyPositronSourceProviders(opts, env);
	reports.push(...(await Promise.all(legacyProviders.map((provider) => provider.read()))));

	const loaded = reports.flatMap((report) => (report.source ? [report.source] : []));
	const sources = opts.transformSource ? loaded.map(opts.transformSource) : loaded;
	const resolver = resolveProviderCatalogReport({
		sources,
		envVars: env,
	});
	const issues = [...reports.flatMap((report) => report.issues), ...resolver.issues];
	for (const issue of issues) {
		opts.logger?.warn(formatConfigIssue(issue));
	}

	return { catalog: resolver.catalog, issues };
}

/** Compatibility wrapper retaining the historical bare-catalog return type. */
export async function loadResolvedProviderCatalog(
	opts: LoadCatalogOptions,
): Promise<readonly ResolvedProvider[]> {
	return (await loadProviderCatalogReport(opts)).catalog;
}
