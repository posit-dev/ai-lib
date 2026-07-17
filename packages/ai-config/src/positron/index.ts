/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * ai-config/positron — Positron `authentication.*` host source.
 *
 * Platform-bound entry (imports `vscode`). Never loaded outside Positron via
 * conditional exports, so the pure `.` and `./node` entries stay vscode-free.
 *
 * `createPositronConfigSource(descriptors)` returns a `ProviderConfigSourceProvider`
 * that reads Positron's `authentication.<key>.*` settings into a `host`-kind
 * config source. Passed to the catalog load/watch seams via
 * `catalogOptions.additionalSources`, it lets the resolver fold VS Code auth
 * settings in at `host` rank (below `providers.json`, above defaults) — so the
 * precedence knowledge lives in ai-config, not in a hand-written adapter fallback.
 *
 * The provider ↔ configKey mapping is **injected** as descriptors (built by the
 * consumer from the bridge's `PROVIDER_MAP` + `CONFIG_KEY_OVERRIDES`) so this
 * entry never imports `ai-provider-bridge` or `ai-credentials`.
 */

import * as vscode from "vscode";

import type { Disposable, ProviderConfigSourceProvider } from "../config-source.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import {
	buildAuthenticationFragment,
	type PositronAuthSettingDescriptor,
	type PositronAuthSettingReader,
} from "./authentication-fragment.js";

export { buildAuthenticationFragment };
export type { PositronAuthSettingDescriptor, PositronAuthSettingReader };

/**
 * A reader over `vscode.workspace.getConfiguration("authentication")`, with
 * `process.env` fallbacks for the Snowflake host/account/home (host environments —
 * TUI / node — set them there). Mirrors the bridge's `createVscodeCredentialConfig`.
 */
function createVscodeAuthReader(): PositronAuthSettingReader {
	return {
		getBaseUrl: (configKey) =>
			vscode.workspace.getConfiguration("authentication").get<string>(`${configKey}.baseUrl`),
		getCustomHeaders: (configKey) =>
			vscode.workspace
				.getConfiguration("authentication")
				.get<Record<string, string>>(`${configKey}.customHeaders`),
		getAwsRegion: () => {
			const awsConfig = vscode.workspace
				.getConfiguration("authentication.aws")
				.get<Record<string, string>>("credentials");
			return awsConfig?.AWS_REGION || process.env.AWS_REGION;
		},
		getSnowflake: () => {
			const snowflakeConfig = vscode.workspace
				.getConfiguration("authentication.snowflake")
				.get<Record<string, string>>("credentials");
			return {
				host: snowflakeConfig?.SNOWFLAKE_HOST || process.env.SNOWFLAKE_HOST,
				account: snowflakeConfig?.SNOWFLAKE_ACCOUNT || process.env.SNOWFLAKE_ACCOUNT,
				home: snowflakeConfig?.SNOWFLAKE_HOME || process.env.SNOWFLAKE_HOME,
			};
		},
		getDatabricks: () => {
			const databricksConfig = vscode.workspace
				.getConfiguration("authentication.databricks")
				.get<Record<string, string>>("credentials");
			return {
				host: databricksConfig?.DATABRICKS_HOST || process.env.DATABRICKS_HOST,
			};
		},
	};
}

/**
 * Build the Positron `authentication.*` host source.
 *
 * `read()` returns a `host`-kind {@link ProviderConfigSource} built from the
 * current settings. `watch()` fires `onChange` whenever any `authentication.*`
 * setting changes — coarse but correct: the catalog watch debounces and diffs,
 * so an over-fire only costs a no-op rebuild.
 *
 * @param descriptors - Per-provider mapping (from the bridge's `PROVIDER_MAP`
 *   + `CONFIG_KEY_OVERRIDES`) describing which `authentication.<configKey>`
 *   section to read for each catalog provider id and how.
 */
export function createPositronConfigSource(
	descriptors: readonly PositronAuthSettingDescriptor[],
): ProviderConfigSourceProvider {
	const reader = createVscodeAuthReader();

	return {
		read(): ProviderConfigSource {
			const config = buildAuthenticationFragment(reader, descriptors);
			return { kind: "host", label: "authentication.*", config };
		},

		watch(onChange: () => void): Disposable {
			return vscode.workspace.onDidChangeConfiguration((e) => {
				if (e.affectsConfiguration("authentication")) {
					onChange();
				}
			});
		},
	};
}
