/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Node read seam: assemble source reports, resolve, and render once. */

import { formatConfigIssue } from "../config-issue.js";
import type { SourcedConfigIssue } from "../config-issue.js";
import { createHostDefaultsSourceProviders } from "../config-source.js";
import type { ProviderConfigSourceReadReport } from "../config-source.js";
import type { ProviderCatalogExplanation } from "../config-trace.js";
import { explainProviderSources } from "../explain-catalog.js";
import { createLegacyPositronSourceProviders } from "../legacy-positron-settings/sources.js";
import { resolveProviderCatalogReport } from "../resolve-catalog.js";
import type {
	AgentEnginesConfig,
	ResolvedAgentEnginesProvenance,
	ResolvedProvider,
} from "../types.js";
import { loadConfigSourceReports } from "./load-config.js";
import type { LoadCatalogOptions } from "./types.js";

export interface LoadedProviderCatalogReport {
	readonly catalog: readonly ResolvedProvider[];
	/** The layers' `agentEngines` blocks merged by precedence; `{}` when none sets one. */
	readonly agentEngines: AgentEnginesConfig;
	/** Which layer decided the master switch and each engine's `enabled`. */
	readonly agentEnginesProvenance: ResolvedAgentEnginesProvenance;
	readonly issues: readonly SourcedConfigIssue[];
}

/** Load a resolved catalog together with the complete current issue snapshot. */
export async function loadProviderCatalogReport(
	opts: LoadCatalogOptions,
): Promise<LoadedProviderCatalogReport> {
	const env = opts.envVars ?? process.env;
	const reports = await readCatalogLayers(opts, env);
	const sources = reports.flatMap(({ source }) => (source ? [source] : []));
	const resolver = resolveProviderCatalogReport({
		sources,
		envVars: env,
	});
	const issues = [...reports.flatMap((report) => report.issues), ...resolver.issues];
	for (const issue of issues) {
		opts.logger?.warn(formatConfigIssue(issue));
	}

	return {
		catalog: resolver.catalog,
		agentEngines: resolver.agentEngines,
		agentEnginesProvenance: resolver.agentEnginesProvenance,
		issues,
	};
}

/** Options for {@link explainProviderCatalog}: the load options, without a logger. */
export type ExplainProviderCatalogOptions = Omit<LoadCatalogOptions, "logger">;

/**
 * Explain the catalog the same options would load: every layer read (with
 * missing / empty / invalid / not set states), and for each key some layer
 * sets, the layer whose value is used and what the others said. Values are
 * masked. Read-only and silent: never writes, never logs; issues carry no
 * parser message (it can quote the input), only where and how bad.
 */
export async function explainProviderCatalog(
	opts: ExplainProviderCatalogOptions,
): Promise<ProviderCatalogExplanation> {
	const env = opts.envVars ?? process.env;
	return explainProviderSources({ reports: await readCatalogLayers(opts, env), envVars: env });
}

/**
 * Read every layer the options enable, in read order, applying
 * `transformSource`. The one source assembly behind both the load and the
 * explanation, so they see the same sources.
 */
async function readCatalogLayers(
	opts: ExplainProviderCatalogOptions,
	env: Record<string, string | undefined>,
): Promise<ProviderConfigSourceReadReport[]> {
	const reports = await loadConfigSourceReports({
		configPath: opts.configPath,
		enforcedEnvVar: opts.enforcedEnvVar,
		defaultEnvVar: opts.defaultEnvVar,
		env,
	});

	const extraProviders = [
		...createLegacyPositronSourceProviders(opts, env),
		...createHostDefaultsSourceProviders(opts.hostDefaults),
	];
	reports.push(...(await Promise.all(extraProviders.map((provider) => provider.read()))));

	const transform = opts.transformSource;
	return reports.map((report) => ({
		...report,
		...(report.source && transform ? { source: transform(report.source) } : {}),
	}));
}

/** Compatibility wrapper retaining the historical bare-catalog return type. */
export async function loadResolvedProviderCatalog(
	opts: LoadCatalogOptions,
): Promise<readonly ResolvedProvider[]> {
	return (await loadProviderCatalogReport(opts)).catalog;
}
