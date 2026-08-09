/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): delete this module with the
 * legacy settings channels.
 *
 * Internal builders for the two legacy config-source layers. NOT exported
 * from the package entries — the `legacyPositronSettings` and
 * `legacyPositronEnforcedSettings` loader options are the only public runtime
 * surface; the load and watch seams call this single assembly point so
 * neither path can diverge on which layers an option enables.
 *
 * - `legacy-positron` (the `reader` option): user-set legacy settings via the
 *   injected reader, below `user`, above `default`. Watchable through the
 *   reader's coarse watch (the catalog watch debounces and diffs, so an
 *   over-fire only costs a no-op rebuild).
 * - `legacy-positron-enforced` (the `enforcedSettings` flag): the
 *   `POSITRON_ENFORCED_SETTINGS` env payload, above `user`, below `enforced`.
 *   Payload-only reads — no reader, no ambient env fallbacks, so an ambient
 *   variable can never be promoted to enforced rank. Static (env vars don't
 *   change within a process).
 */

import { sourceConfigIssue } from "../config-issue.js";
import type { ConfigIssue } from "../config-issue.js";
import type {
	ProviderConfigSourceProvider,
	ProviderConfigSourceReadReport,
} from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import type { ProvidersConfigFragment } from "../types.js";
import { translateLegacyPositronSettingsReport } from "./translate.js";
import type { LegacySettingsReader } from "./translate.js";

/** The legacy Workbench admin-enforcement env var (name owned by Workbench). */
export const POSITRON_ENFORCED_SETTINGS_ENV_VAR = "POSITRON_ENFORCED_SETTINGS";

/**
 * Build the legacy source providers a loader opted into: the enforced layer
 * when `legacyPositronEnforcedSettings` is true, the reader layer when a
 * `legacyPositronSettings` reader is given (independently — enabling one
 * never enables the other). Accepts the loader's own option fields so the
 * option → layer mapping lives only here; callers pass their `opts` straight
 * through and fold the result into the load path (read once) and the watch
 * path (read per rebuild + subscribe).
 */
export function createLegacyPositronSourceProviders(
	opts: {
		readonly legacyPositronSettings?: LegacySettingsReader;
		readonly legacyPositronEnforcedSettings?: boolean;
	},
	env: Readonly<Record<string, string | undefined>>,
): ProviderConfigSourceProvider[] {
	const providers: ProviderConfigSourceProvider[] = [];
	if (opts.legacyPositronEnforcedSettings) {
		providers.push(createEnforcedSettingsProvider(env));
	}
	if (opts.legacyPositronSettings) {
		providers.push(createReaderSettingsProvider(opts.legacyPositronSettings));
	}
	return providers;
}

// ---------------------------------------------------------------------------
// legacy-positron — reader-backed, watchable
// ---------------------------------------------------------------------------

function createReaderSettingsProvider(reader: LegacySettingsReader): ProviderConfigSourceProvider {
	return {
		read(): ProviderConfigSourceReadReport {
			const identity = {
				kind: "legacy-positron",
				label: "legacy Positron settings",
			} satisfies Pick<ProviderConfigSource, "kind" | "label">;
			const { config, issues } = translateLegacyPositronSettingsReport(reader);
			return {
				source: hasProviders(config) ? { ...identity, config } : undefined,
				issues: issues.map((issue) => sourceConfigIssue(issue, identity)),
			};
		},

		watch(onChange: () => void) {
			return reader.watch(onChange);
		},
	};
}

// ---------------------------------------------------------------------------
// legacy-positron-enforced — env-payload-backed, static
// ---------------------------------------------------------------------------

function createEnforcedSettingsProvider(
	env: Readonly<Record<string, string | undefined>>,
): ProviderConfigSourceProvider {
	return {
		read(): ProviderConfigSourceReadReport {
			const identity = {
				kind: "legacy-positron-enforced",
				label: POSITRON_ENFORCED_SETTINGS_ENV_VAR,
			} satisfies Pick<ProviderConfigSource, "kind" | "label">;
			const raw = env[POSITRON_ENFORCED_SETTINGS_ENV_VAR];
			if (!raw) {
				return { issues: [] };
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// No error detail: JSON.parse messages embed input snippets, and
				// this payload can carry credential-adjacent values.
				return issueOnly(
					identity,
					`Failed to parse ${POSITRON_ENFORCED_SETTINGS_ENV_VAR} as JSON. Ignoring.`,
				);
			}
			if (!isPlainObject(parsed)) {
				return issueOnly(
					identity,
					`${POSITRON_ENFORCED_SETTINGS_ENV_VAR} is not a JSON object. Ignoring.`,
				);
			}

			// A flat dotted-key payload read through the shared translator; keys
			// shaped like "[lang]" overrides are never queried, so they are inert.
			const payload = parsed;
			const { config, issues } = translateLegacyPositronSettingsReport({
				get: (key) => payload[key],
			});
			return {
				source: hasProviders(config) ? { ...identity, config } : undefined,
				issues: issues.map((issue) => sourceConfigIssue(issue, identity)),
			};
		},
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasProviders(config: ProvidersConfigFragment): boolean {
	return !!config.providers && Object.keys(config.providers).length > 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function issueOnly(
	identity: Pick<ProviderConfigSource, "kind" | "label">,
	message: string,
): ProviderConfigSourceReadReport {
	const issue: ConfigIssue = { severity: "error", path: [], message };
	return { issues: [sourceConfigIssue(issue, identity)] };
}
