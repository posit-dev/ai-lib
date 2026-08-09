/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderConfigSource, ProviderConfigSourceKind } from "./resolve-catalog.js";

/**
 * A structured problem found while reading or resolving provider config.
 *
 * The severity/scope contract is encoded in the type: a **warning** is a
 * per-key salvage drop (one entry ignored, the rest of the source survives);
 * an **error** is a whole-source failure (the source was discarded whole), so
 * its path is always empty and offending key paths live in the message prose.
 */
export type ConfigIssue =
	| {
			readonly severity: "warning";
			readonly path: readonly (string | number)[];
			readonly message: string;
	  }
	| {
			readonly severity: "error";
			readonly path: readonly [];
			readonly message: string;
	  };

/** A config issue with the identity of the source that produced it. */
export type SourcedConfigIssue = ConfigIssue & {
	readonly source: {
		readonly kind: ProviderConfigSourceKind | "env";
		readonly label: string;
	};
};

/** Normalize an optional source label before exposing it in an issue. */
export function configIssueSource(
	source:
		| Pick<ProviderConfigSource, "kind" | "label">
		| { readonly kind: "env"; readonly label?: string },
): SourcedConfigIssue["source"] {
	return { kind: source.kind, label: source.label ?? source.kind };
}

/** Attach source identity to an issue returned by source-agnostic parsing. */
export function sourceConfigIssue(
	issue: ConfigIssue,
	source: Pick<ProviderConfigSource, "kind" | "label">,
): SourcedConfigIssue {
	return { ...issue, source: configIssueSource(source) };
}

/**
 * The canonical whole-source failure: the source was discarded whole, so the
 * issue is always error severity with an empty path. Offending key paths
 * belong in the message prose. This is the only issue shape hosts surface in
 * the UI; constructing it here keeps the contract unrepresentable-when-wrong
 * instead of recreated at each producer.
 */
export function wholeSourceIssue(message: string): ConfigIssue {
	return { severity: "error", path: [], message };
}

/** Attach source identity to a whole-source failure. */
export function sourcedWholeSourceIssue(
	source: Parameters<typeof configIssueSource>[0],
	message: string,
): SourcedConfigIssue {
	return { ...wholeSourceIssue(message), source: configIssueSource(source) };
}

/** Render a structured issue for compatibility logging surfaces. */
export function formatConfigIssue(issue: SourcedConfigIssue): string {
	const path = issue.path.length > 0 ? ` at ${issue.path.join(".")}` : "";
	return `[ai-config] ${issue.source.label} (${issue.source.kind})${path}: ${issue.message}`;
}

/** Normalize Zod's PropertyKey path vocabulary to the public issue shape. */
export function configIssuePath(path: readonly PropertyKey[]): readonly (string | number)[] {
	return path.map((segment) =>
		typeof segment === "symbol" ? (segment.description ?? segment.toString()) : segment,
	);
}
