/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Explain a provider config stack: for every key some layer sets, which
 * layer's value is used and what the others said.
 *
 * Precedence is never restated here. The explainer runs the resolver's own
 * fold (`foldProviderCatalog`) and replays its merge step
 * (`foldConfigLayers`) with an observer, so each value's winner is whatever
 * the merge actually kept. Enablement comes from `resolveEnabledDecision`,
 * the function `resolveEnabled` delegates to. Values are masked by
 * `providers-config-safe-fields.ts`. Pure and silent: no logger, no I/O.
 */

import type { SourcedConfigIssue } from "./config-issue.js";
import type { ProviderConfigLayer, ProviderConfigSourceReadReport } from "./config-source.js";
import type {
	ConfigLayerRef,
	ConfigLayerValue,
	ConfigValueTrace,
	ExplainedConfigIssue,
	ProviderCatalogExplanation,
} from "./config-trace.js";
import { connectionEnvVarFor } from "./connection-env.js";
import { isReplacedWholePath } from "./enforce.js";
import { isPlainObject } from "./is-plain-object.js";
import { maskProvidersConfigValue } from "./providers-config-safe-fields.js";
import {
	engineFragmentOf,
	foldConfigLayers,
	foldProviderCatalog,
	isSnowflakeEndpointPath,
	providerFragmentOf,
	RANK,
} from "./resolve-catalog.js";
import type {
	ProviderCatalogFold,
	ProviderConfigSource,
	RankedConfigSource,
} from "./resolve-catalog.js";
import { layerEnablement, resolveEnabledDecision } from "./resolve-enabled.js";
import type { ProvidersConfigFragment } from "./types.js";

export interface ExplainProviderSourcesOptions {
	/** Every layer the host read, in read order, with sources already transformed. */
	readonly reports: readonly ProviderConfigSourceReadReport[];
	/** The env the connection env source is read from. */
	readonly envVars: Record<string, string | undefined>;
}

const NOTE_LIST = "lists replace, never merge";
const NOTE_WHOLE_OBJECT = "replaces whole object";
const NOTE_SNOWFLAKE_ENDPOINT =
	"baseUrl, snowflake.account and snowflake.host are one setting: the highest layer that sets any of them decides";
const NOTE_DEFAULT_ENABLED = "applies to providers a layer does not set enabled for";

/** Explain the stack `reports` resolve to. */
export function explainProviderSources(
	opts: ExplainProviderSourcesOptions,
): ProviderCatalogExplanation {
	const { reports, envVars } = opts;
	const sources = reports.flatMap(({ source }) => (source ? [source] : []));
	const fold = foldProviderCatalog({ sources, envVars });

	const tags = new Map<RankedConfigSource, string>();
	for (const { layer, source } of reports) {
		if (source) tags.set(source, layer.tag);
	}
	const tagOf = (source: RankedConfigSource, path: readonly string[]): string =>
		source.kind === "env"
			? `$${connectionEnvVarFor(path, envVars) ?? "env"}`
			: (tags.get(source) ?? source.kind);

	const providerTraces = foldTraces({
		candidates: fold.highestFirst,
		folded: fold.kept,
		fragmentOf: providerFragmentOf,
		sourceOf: (source) => source,
		root: "providers",
		tagOf,
	});
	const engineTraces = foldTraces({
		candidates: fold.engines.layers,
		folded: fold.engines.layers,
		fragmentOf: engineFragmentOf,
		sourceOf: (layer) => layer.source,
		root: "agentEngines",
		tagOf,
	});

	return {
		layers: layerRefs(reports, fold, envVars),
		entries: [...providerTraces, ...enablementTraces(fold, tagOf), ...engineTraces].sort((a, b) =>
			comparePaths(a.path, b.path),
		),
		issues: [
			...reports.flatMap((report) => report.issues).map((issue) => withScope(issue, "source")),
			// Recovery drops an overlay's provider configuration only.
			...fold.issues.map((issue) => withScope(issue, "providers")),
		],
	};
}

function withScope(
	issue: SourcedConfigIssue,
	scope: ExplainedConfigIssue["scope"],
): ExplainedConfigIssue {
	return { ...issue, scope };
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

function layerRefs(
	reports: readonly ProviderConfigSourceReadReport[],
	fold: ProviderCatalogFold,
	envVars: Record<string, string | undefined>,
): ConfigLayerRef[] {
	const envSource = fold.highestFirst.find((source) => source.kind === "env");
	const envNames = new Set<string>();
	for (const path of envSource ? leafPaths(envSource.config.providers, ["providers"]) : []) {
		const name = connectionEnvVarFor(path, envVars);
		if (name) envNames.add(name);
	}
	const ranked = [
		...reports.map(({ layer }) => ({ rank: RANK[layer.kind], ref: layerRef(layer) })),
		{
			rank: RANK.env,
			ref: {
				tag: "env",
				label: "connection env vars",
				detail: [...envNames].sort().join(", "),
				state: envSource ? "found" : "not set",
			} satisfies ConfigLayerRef,
		},
	];
	// Stable: same-rank layers keep read order, as the resolver does.
	return ranked.sort((a, b) => a.rank - b.rank).map(({ ref }) => ref);
}

function layerRef({ tag, label, detail, state }: ProviderConfigLayer): ConfigLayerRef {
	return { tag, label, detail, state };
}

// ---------------------------------------------------------------------------
// Merged values
// ---------------------------------------------------------------------------

interface FoldTraceOptions<L> {
	/** Every layer that may set a key, highest precedence first. */
	readonly candidates: readonly L[];
	/** The layers the resolver folds, highest precedence first. */
	readonly folded: readonly L[];
	readonly fragmentOf: (layer: L) => ProvidersConfigFragment;
	readonly sourceOf: (layer: L) => RankedConfigSource;
	readonly root: "providers" | "agentEngines";
	readonly tagOf: (source: RankedConfigSource, path: readonly string[]) => string;
}

/**
 * Trace every leaf the candidates set by replaying the resolver's fold: the
 * layer holding a leaf after the last merge step is its winner.
 */
function foldTraces<L>(opts: FoldTraceOptions<L>): ConfigValueTrace[] {
	const { candidates, fragmentOf, root } = opts;
	const folded = new Set(opts.folded);
	const paths = new Map<string, readonly string[]>();
	for (const candidate of candidates) {
		for (const path of leafPaths(fragmentOf(candidate)[root], [root])) {
			if (!isEnablementPath(path)) paths.set(pathKey(path), path);
		}
	}

	const holders = new Map<string, L>();
	const merged = foldConfigLayers(opts.folded, fragmentOf, (layer, fragment, after) => {
		for (const [key, path] of paths) {
			const contributed = leafAt(fragment, path);
			const now = leafAt(after, path);
			if (contributed !== undefined && now === contributed) {
				holders.set(key, layer);
			} else if (now === undefined) {
				// A higher layer replaced the setting this leaf belongs to.
				holders.delete(key);
			}
		}
	});

	return [...paths].map(([key, path]) => {
		const holder = holders.get(key);
		const winner = holder === undefined ? undefined : opts.sourceOf(holder);
		const values = candidates.flatMap((candidate): ConfigLayerValue[] => {
			const value = leafAt(fragmentOf(candidate), path);
			if (value === undefined) return [];
			const source = opts.sourceOf(candidate);
			return [
				{
					layer: opts.tagOf(source, path),
					value: maskProvidersConfigValue(path, value),
					status: !folded.has(candidate)
						? "dropped"
						: candidate === holder
							? "effective"
							: overriddenStatus(winner),
				},
			];
		});
		const isList = candidates.some((c) => Array.isArray(leafAt(fragmentOf(c), path)));
		return trace(
			path,
			maskProvidersConfigValue(path, leafAt(merged, path)),
			values,
			noteFor(path, isList),
		);
	});
}

function noteFor(path: readonly string[], isList: boolean): string | undefined {
	if (isList) return NOTE_LIST;
	if (isReplacedWholePath(path)) return NOTE_WHOLE_OBJECT;
	if (isSnowflakeEndpointPath(path)) return NOTE_SNOWFLAKE_ENDPOINT;
	return undefined;
}

// ---------------------------------------------------------------------------
// Enablement
// ---------------------------------------------------------------------------

/** `providers.<id>.enabled`, `providers.custom.<name>.enabled`, `providers.default.enabled`. */
function isEnablementPath(path: readonly string[]): boolean {
	if (path[0] !== "providers") return false;
	if (path[1] === "custom") return path.length === 4 && path[3] === "enabled";
	return path.length === 3 && path[2] === "enabled";
}

/**
 * Enablement is not a merged value: each layer says enabled through the
 * provider's block or its `providers.default`, and the highest layer that
 * says anything decides (`resolveEnabledDecision`). One trace per provider
 * some layer names, plus one for `providers.default.enabled`.
 */
function enablementTraces(
	fold: ProviderCatalogFold,
	tagOf: (source: RankedConfigSource, path: readonly string[]) => string,
): ConfigValueTrace[] {
	const candidates = fold.highestFirst.filter(
		(source): source is ProviderConfigSource => source.kind !== "env",
	);
	const keptLayers = fold.enablement.map((source) => source.config.providers);
	const kept = new Set<RankedConfigSource>(fold.kept);

	const subjects = new Map<string, { id: string; custom: boolean }>();
	for (const { config } of candidates) {
		for (const [id, block] of Object.entries(config.providers ?? {})) {
			if (id === "default" || id === "custom") continue;
			if (isPlainObject(block) && block.enabled !== undefined) {
				subjects.set(id, { id, custom: false });
			}
		}
		for (const [name, entry] of Object.entries(config.providers?.custom ?? {})) {
			if (entry?.enabled !== undefined) subjects.set(name, { id: name, custom: true });
		}
	}

	const traceFor = (
		path: readonly string[],
		id: string | undefined,
		exists: boolean,
	): ConfigValueTrace => {
		const decision = resolveEnabledDecision(id, keptLayers);
		const winner =
			decision.decidedBy === undefined ? undefined : fold.enablement[decision.decidedBy];
		const viaDefault: string[] = [];
		const layerValues = candidates.flatMap((source): ConfigLayerValue[] => {
			const said = layerEnablement(source.config.providers, id);
			if (!said) return [];
			const layer = tagOf(source, path);
			if (said.via === "default") viaDefault.push(`[${layer}]`);
			return [
				{
					layer,
					value: said.enabled,
					status: !kept.has(source)
						? "dropped"
						: source === winner
							? "effective"
							: overriddenStatus(winner),
				},
			];
		});
		const note =
			id === undefined
				? NOTE_DEFAULT_ENABLED
				: viaDefault.length > 0
					? `from providers.default in ${viaDefault.join(" ")}`
					: undefined;
		return trace(path, exists ? decision.enabled : undefined, layerValues, note);
	};

	const traces = [...subjects.values()].map(({ id, custom }) =>
		traceFor(
			custom ? ["providers", "custom", id, "enabled"] : ["providers", id, "enabled"],
			id,
			!custom || fold.config.providers?.custom?.[id] !== undefined,
		),
	);
	if (candidates.some(({ config }) => config.providers?.default?.enabled !== undefined)) {
		const defaultWinner = resolveEnabledDecision(undefined, keptLayers).decidedBy;
		traces.push(
			traceFor(["providers", "default", "enabled"], undefined, defaultWinner !== undefined),
		);
	}
	return traces;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A value a higher layer beat: `no-effect` when that layer is admin-enforced. */
function overriddenStatus(winner: RankedConfigSource | undefined): ConfigLayerValue["status"] {
	if (winner === undefined) return "dropped";
	return winner.kind === "enforced" || winner.kind === "legacy-positron-enforced"
		? "no-effect"
		: "overridden";
}

function trace(
	path: readonly string[],
	effective: unknown,
	layers: readonly ConfigLayerValue[],
	note: string | undefined,
): ConfigValueTrace {
	return {
		path,
		effective,
		rule: "highest-wins",
		...(note !== undefined ? { note } : {}),
		layers,
	};
}

/**
 * Paths of the values the merge treats as units: scalars, lists, and the
 * objects it replaces whole. Empty objects contribute none.
 */
function leafPaths(value: unknown, path: readonly string[]): (readonly string[])[] {
	if (value === undefined) return [];
	if (isPlainObject(value) && !isReplacedWholePath(path)) {
		return Object.keys(value).flatMap((key) => leafPaths(value[key], [...path, key]));
	}
	return [path];
}

function leafAt(fragment: ProvidersConfigFragment, path: readonly string[]): unknown {
	let node: unknown = fragment;
	for (const key of path) {
		if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined;
		node = node[key];
	}
	return node;
}

function pathKey(path: readonly string[]): string {
	return JSON.stringify(path);
}

function comparePaths(a: readonly string[], b: readonly string[]): number {
	for (let i = 0; i < Math.min(a.length, b.length); i++) {
		if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
	}
	return a.length - b.length;
}
