/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { configIssuePath, wholeSourceIssue } from "./config-issue.js";
import type { ConfigIssue } from "./config-issue.js";
import { customProviderNameIssues } from "./custom-provider-name.js";
import { isPlainObject } from "./is-plain-object.js";
import {
	builtinProviderBlockSchemas,
	customProviderEntrySchema,
	defaultBlockSchema,
	providersConfigSchema,
} from "./schema.js";
import type { ProvidersConfig } from "./types.js";
import { unsafeObjectKeyPaths } from "./unsafe-object-key.js";
import { isBuiltinProviderId } from "./vocabulary.js";

export interface SalvagedProvidersConfig {
	readonly config: ProvidersConfig;
	readonly issues: ConfigIssue[];
}

const ROOT_KEYS = new Set(["$schema", "version", "providers"]);

/**
 * Recover independently-valid provider blocks from parsed providers.json.
 * Whole blocks are retained or dropped; individual fields are never pruned.
 */
export function salvageProvidersConfig(parsed: unknown): SalvagedProvidersConfig {
	const strict = providersConfigSchema.safeParse(parsed);
	if (strict.success) {
		return { config: strict.data, issues: [] };
	}

	if (!isPlainObject(parsed)) {
		return degradedIssue("Expected providers.json to contain a JSON object.");
	}

	const issues: ConfigIssue[] = [];
	const reconstructed: Record<string, unknown> = {};

	for (const key of Object.keys(parsed)) {
		if (!ROOT_KEYS.has(key)) {
			issues.push(warning([key], `Unrecognized root key: "${key}".`));
		}
	}

	if (parsed.$schema !== undefined) {
		if (typeof parsed.$schema === "string") {
			reconstructed.$schema = parsed.$schema;
		} else {
			issues.push(
				warning(["$schema"], "Invalid input: expected string, received non-string value."),
			);
		}
	}

	if (parsed.version !== undefined) {
		if (parsed.version !== 1) {
			issues.push(wholeSourceIssue("Unsupported providers.json version; expected 1."));
			return { config: {}, issues };
		}
		reconstructed.version = 1;
	}

	if (parsed.providers !== undefined) {
		if (!isPlainObject(parsed.providers)) {
			issues.push(wholeSourceIssue('"providers" must be an object of provider blocks.'));
			return { config: {}, issues };
		}
		reconstructed.providers = salvageProvidersMap(parsed.providers, issues);
	}

	const sealed = providersConfigSchema.safeParse(reconstructed);
	if (!sealed.success) {
		// A salvage bug discarded the whole file: source-wide issue, with the
		// failing path kept in the message prose for debugging.
		const first = sealed.error.issues[0];
		const firstPath = configIssuePath(first?.path ?? []);
		const at = firstPath.length > 0 ? ` at ${firstPath.join(".")}` : "";
		return {
			config: {},
			issues: [
				...issues,
				wholeSourceIssue(
					`Internal salvage validation failed${at}: ${first?.message ?? "unknown validation error"}`,
				),
			],
		};
	}

	return { config: sealed.data, issues };
}

function salvageProvidersMap(
	providers: Record<string, unknown>,
	issues: ConfigIssue[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(providers)) {
		if (isBuiltinProviderId(key)) {
			keepParsed(result, key, value, builtinProviderBlockSchemas[key], ["providers", key], issues);
			continue;
		}
		if (key === "default") {
			keepParsed(result, key, value, defaultBlockSchema, ["providers", key], issues);
			continue;
		}
		if (key === "custom") {
			salvageCustomProviders(result, value, issues);
			continue;
		}
		issues.push(
			warning(
				["providers", key],
				`"${key}" is not a known provider id; did you mean providers.custom.${key}?`,
			),
		);
	}
	return result;
}

function salvageCustomProviders(
	providers: Record<string, unknown>,
	value: unknown,
	issues: ConfigIssue[],
): void {
	if (!isPlainObject(value)) {
		issues.push(warning(["providers", "custom"], "Invalid input: expected an object."));
		return;
	}

	const custom: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		const path = ["providers", "custom", name];
		const nameIssue = customProviderNameIssues(name)[0];
		if (nameIssue) {
			issues.push(warning(path, nameIssue));
			continue;
		}
		keepParsed(custom, name, entry, customProviderEntrySchema, path, issues);
	}
	providers.custom = custom;
}

function keepParsed<T>(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
	schema: {
		safeParse(
			input: unknown,
		):
			| { success: true; data: T }
			| { success: false; error: { issues: readonly { message: string }[] } };
	},
	path: readonly (string | number)[],
	issues: ConfigIssue[],
): void {
	const unsafePath = unsafeObjectKeyPaths(value)[0];
	if (unsafePath) {
		issues.push(
			warning(path, `Object key "__proto__" at ${formatRelativePath(unsafePath)} is unsafe.`),
		);
		return;
	}
	const parsed = schema.safeParse(value);
	if (parsed.success) {
		target[key] = parsed.data;
		return;
	}
	issues.push(warning(path, parsed.error.issues[0]?.message ?? "Invalid provider block."));
}

function formatRelativePath(path: ConfigIssue["path"]): string {
	return path.length === 0 ? "the provider block" : path.map(String).join(".");
}

function warning(path: readonly (string | number)[], message: string): ConfigIssue {
	return { severity: "warning", path, message };
}

function degradedIssue(message: string): SalvagedProvidersConfig {
	return { config: {}, issues: [wholeSourceIssue(message)] };
}
