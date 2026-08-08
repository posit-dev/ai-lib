/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ProviderConfigSource, ProviderConfigSourceKind } from "./resolve-catalog.js";

/** A structured problem found while reading or resolving provider config. */
export interface ConfigIssue {
	readonly severity: "warning" | "error";
	readonly path: readonly (string | number)[];
	readonly message: string;
}

/** A config issue with the identity of the source that produced it. */
export interface SourcedConfigIssue extends ConfigIssue {
	readonly source: {
		readonly kind: ProviderConfigSourceKind | "env";
		readonly label: string;
	};
}

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
