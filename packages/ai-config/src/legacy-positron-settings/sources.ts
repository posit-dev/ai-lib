/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): delete this module with the
 * legacy settings channels.
 *
 * Internal builders for the two legacy config-source layers. NOT exported
 * from the package entries — the `legacyPositronSettings` loader option is
 * the only public runtime surface; the load and watch seams call this to
 * assemble both layers so neither path can miss one.
 *
 * - `legacy-positron`: user-set legacy settings via the injected reader,
 *   below `user`, above `default`. Watchable through the reader's coarse
 *   watch (the catalog watch debounces and diffs, so an over-fire only costs
 *   a no-op rebuild).
 * - `legacy-positron-enforced`: the `POSITRON_ENFORCED_SETTINGS` env payload,
 *   above `user`, below `enforced`. Payload-only reads — no reader, no
 *   ambient env fallbacks, so an ambient variable can never be promoted to
 *   enforced rank. Static (env vars don't change within a process).
 */

import type { ProviderConfigSourceProvider } from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import type { ProvidersConfigFragment, LoggerLike } from "../types.js";
import { translateLegacyPositronSettings } from "./translate.js";
import type { LegacySettingsReader } from "./translate.js";

/** The legacy Workbench admin-enforcement env var (name owned by Workbench). */
export const POSITRON_ENFORCED_SETTINGS_ENV_VAR = "POSITRON_ENFORCED_SETTINGS";

/**
 * Build both legacy source providers for a loader that was given a
 * `legacyPositronSettings` reader. The caller folds them into the load path
 * (read once) and the watch path (read per rebuild + subscribe).
 */
export function createLegacyPositronSourceProviders(
	reader: LegacySettingsReader,
	env: Readonly<Record<string, string | undefined>>,
	logger?: LoggerLike,
): ProviderConfigSourceProvider[] {
	return [
		createEnforcedSettingsProvider(env, logger),
		createReaderSettingsProvider(reader, logger),
	];
}

// ---------------------------------------------------------------------------
// legacy-positron — reader-backed, watchable
// ---------------------------------------------------------------------------

function createReaderSettingsProvider(
	reader: LegacySettingsReader,
	logger?: LoggerLike,
): ProviderConfigSourceProvider {
	// Owned by the provider (which re-reads on every catalog rebuild) so each
	// dropped key warns once, not once per rebuild.
	const warnedKeys = new Set<string>();

	return {
		read(): ProviderConfigSource | undefined {
			const { config } = translateLegacyPositronSettings(reader, logger, warnedKeys);
			if (!hasProviders(config)) {
				return undefined;
			}
			return { kind: "legacy-positron", label: "legacy Positron settings", config };
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
	logger?: LoggerLike,
): ProviderConfigSourceProvider {
	const warnedKeys = new Set<string>();
	let warnedEnvelope = false;

	const warnEnvelopeOnce = (message: string) => {
		if (warnedEnvelope) {
			return;
		}
		warnedEnvelope = true;
		logger?.warn(message);
	};

	return {
		read(): ProviderConfigSource | undefined {
			const raw = env[POSITRON_ENFORCED_SETTINGS_ENV_VAR];
			if (!raw) {
				return undefined;
			}

			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				// No error detail: JSON.parse messages embed input snippets, and
				// this payload can carry credential-adjacent values.
				warnEnvelopeOnce(
					`[ai-config] Failed to parse ${POSITRON_ENFORCED_SETTINGS_ENV_VAR} as JSON. Ignoring.`,
				);
				return undefined;
			}
			if (!isPlainObject(parsed)) {
				warnEnvelopeOnce(
					`[ai-config] ${POSITRON_ENFORCED_SETTINGS_ENV_VAR} is not a JSON object. Ignoring.`,
				);
				return undefined;
			}

			// A flat dotted-key payload read through the shared translator; keys
			// shaped like "[lang]" overrides are never queried, so they are inert.
			const payload = parsed;
			const { config } = translateLegacyPositronSettings(
				{ get: (key) => payload[key] },
				logger,
				warnedKeys,
			);
			if (!hasProviders(config)) {
				return undefined;
			}
			return {
				kind: "legacy-positron-enforced",
				label: POSITRON_ENFORCED_SETTINGS_ENV_VAR,
				config,
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
