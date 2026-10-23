/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as z from "zod/v4";

import { configIssuePath, wholeSourceIssue } from "./config-issue.js";
import type { ConfigIssue } from "./config-issue.js";
import { customProviderNameIssues } from "./custom-provider-name.js";
import { isPlainObject } from "./is-plain-object.js";
import { pruneUnknownKeys } from "./prune-unknown-keys.js";
import {
	ACP_AGENT_ID_MESSAGE,
	ACP_AGENT_ID_PATTERN,
	acpAgentEngineSchema,
	agentEnginesSchema,
	builtinProviderBlockSchema,
	builtinProviderBlockSchemas,
	customProviderEntryFragmentSchema,
	customProviderEntrySchema,
	defaultBlockSchema,
	providersConfigFragmentSchema,
	providersConfigSchema,
} from "./schema.js";
import type { ProvidersConfig, ProvidersConfigFragment } from "./types.js";
import { unsafeObjectKeyPaths } from "./unsafe-object-key.js";
import { isBuiltinProviderId } from "./vocabulary.js";
import type { BuiltinProviderId } from "./vocabulary.js";

export interface SalvagedProvidersConfig {
	readonly config: ProvidersConfig;
	readonly issues: ConfigIssue[];
}

/**
 * Why a whole source could not be salvaged. Internal: each reader turns a
 * reason into a message naming its own source (file or env var).
 */
export type SalvageFailureReason =
	| { readonly kind: "not-object" }
	| { readonly kind: "unsupported-version" }
	| { readonly kind: "providers-not-object" }
	| {
			readonly kind: "seal-failed";
			readonly path: readonly (string | number)[];
			readonly message: string;
	  };

/**
 * Internal walker result. `issues` holds only per-key/per-block warnings
 * found before the walk finished (or stopped); whole-source failures are
 * reported as a `reason`, never as a finished message.
 */
export type SalvageResult<T> =
	| { readonly ok: true; readonly config: T; readonly issues: ConfigIssue[] }
	| { readonly ok: false; readonly reason: SalvageFailureReason; readonly issues: ConfigIssue[] };

/** The slice of a Zod schema's `safeParse` the walker's seal relies on. */
interface Sealer<T> {
	safeParse(input: unknown):
		| { success: true; data: T }
		| {
				success: false;
				error: { issues: readonly { message: string; path: readonly PropertyKey[] }[] };
		  };
}

/**
 * What differs between the user file and an admin env fragment: the block
 * schemas, whether unrecognized keys are pruned before validation, and the
 * root schema that seals the reconstructed object (which fixes the result
 * type `T`).
 */
interface SalvageProfile<T> {
	readonly builtinBlockSchema: (id: BuiltinProviderId) => z.core.$ZodType;
	readonly defaultBlockSchema: z.core.$ZodType;
	readonly customEntrySchema: z.core.$ZodType;
	readonly pruneUnknownKeys: boolean;
	readonly seal: Sealer<T>;
}

/** User providers.json: tailored strict blocks, whole blocks kept or dropped. */
const FULL_PROFILE: SalvageProfile<ProvidersConfig> = {
	builtinBlockSchema: (id) => builtinProviderBlockSchemas[id],
	defaultBlockSchema,
	customEntrySchema: customProviderEntrySchema,
	pruneUnknownKeys: false,
	seal: providersConfigSchema,
};

/** Admin env fragments: superset blocks, unrecognized keys pruned first. */
const FRAGMENT_PROFILE: SalvageProfile<ProvidersConfigFragment> = {
	builtinBlockSchema: () => builtinProviderBlockSchema,
	defaultBlockSchema,
	customEntrySchema: customProviderEntryFragmentSchema,
	pruneUnknownKeys: true,
	seal: providersConfigFragmentSchema,
};

const ROOT_KEYS = new Set(["$schema", "version", "providers", "agentEngines"]);

/** Schemas of the `agentEngines` fields salvaged one by one (`acp` is per agent). */
const AGENT_ENGINE_FIELD_SCHEMAS: Readonly<Record<string, z.core.$ZodType>> =
	agentEnginesSchema.shape;

type ConfigPath = readonly (string | number)[];

/**
 * Recover independently-valid provider blocks from parsed providers.json.
 * Whole blocks are retained or dropped; individual fields are never pruned.
 */
export function salvageProvidersConfig(parsed: unknown): SalvagedProvidersConfig {
	const result = salvageWithProfile(parsed, FULL_PROFILE);
	if (result.ok) {
		return { config: result.config, issues: result.issues };
	}
	const { reason } = result;
	if (reason.kind === "not-object") {
		// Nothing was walked, so there are no earlier warnings to keep.
		return {
			config: {},
			issues: [wholeSourceIssue("Expected providers.json to contain a JSON object.")],
		};
	}
	return { config: {}, issues: [...result.issues, wholeSourceIssue(fileFailureMessage(reason))] };
}

/**
 * Internal (not exported from the package entry): salvage a parsed admin
 * config fragment. Unrecognized keys are removed at any depth, a block whose
 * values are invalid is dropped, and every such drop is a warning with a
 * path. Only an unusable payload fails whole, as a reason.
 */
export function salvageProvidersConfigFragment(
	parsed: unknown,
): SalvageResult<ProvidersConfigFragment> {
	return salvageWithProfile(parsed, FRAGMENT_PROFILE);
}

function fileFailureMessage(reason: Exclude<SalvageFailureReason, { kind: "not-object" }>): string {
	switch (reason.kind) {
		case "unsupported-version":
			return "Unsupported providers.json version; expected 1.";
		case "providers-not-object":
			return '"providers" must be an object of provider blocks.';
		case "seal-failed": {
			// A salvage bug discarded the whole file: source-wide issue, with the
			// failing path kept in the message prose for debugging.
			const at = reason.path.length > 0 ? ` at ${reason.path.join(".")}` : "";
			return `Internal salvage validation failed${at}: ${reason.message}`;
		}
	}
}

function salvageWithProfile<T>(parsed: unknown, profile: SalvageProfile<T>): SalvageResult<T> {
	const strict = profile.seal.safeParse(parsed);
	if (strict.success) {
		return { ok: true, config: strict.data, issues: [] };
	}

	if (!isPlainObject(parsed)) {
		return { ok: false, reason: { kind: "not-object" }, issues: [] };
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
			return { ok: false, reason: { kind: "unsupported-version" }, issues };
		}
		reconstructed.version = 1;
	}

	if (parsed.providers !== undefined) {
		if (!isPlainObject(parsed.providers)) {
			return { ok: false, reason: { kind: "providers-not-object" }, issues };
		}
		reconstructed.providers = salvageProvidersMap(parsed.providers, profile, issues);
	}

	if (parsed.agentEngines !== undefined) {
		if (isPlainObject(parsed.agentEngines)) {
			reconstructed.agentEngines = salvageAgentEngines(parsed.agentEngines, profile, issues);
		} else {
			issues.push(warning(["agentEngines"], "Invalid input: expected an object."));
		}
	}

	const sealed = profile.seal.safeParse(reconstructed);
	if (!sealed.success) {
		const first = sealed.error.issues[0];
		return {
			ok: false,
			reason: {
				kind: "seal-failed",
				path: configIssuePath(first?.path ?? []),
				message: first?.message ?? "unknown validation error",
			},
			issues,
		};
	}

	return { ok: true, config: sealed.data, issues };
}

function salvageProvidersMap<T>(
	providers: Record<string, unknown>,
	profile: SalvageProfile<T>,
	issues: ConfigIssue[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(providers)) {
		const path = ["providers", key];
		if (isBuiltinProviderId(key)) {
			keepBlock(result, key, value, profile.builtinBlockSchema(key), profile, path, issues);
			continue;
		}
		if (key === "default") {
			keepBlock(result, key, value, profile.defaultBlockSchema, profile, path, issues);
			continue;
		}
		if (key === "custom") {
			salvageCustomProviders(result, value, profile, issues);
			continue;
		}
		issues.push(
			warning(path, `"${key}" is not a known provider id; did you mean providers.custom.${key}?`),
		);
	}
	return result;
}

function salvageCustomProviders<T>(
	providers: Record<string, unknown>,
	value: unknown,
	profile: SalvageProfile<T>,
	issues: ConfigIssue[],
): void {
	if (!isPlainObject(value)) {
		issues.push(warning(["providers", "custom"], "Invalid input: expected an object."));
		return;
	}

	const custom: Record<string, unknown> = {};
	for (const [name, entry] of Object.entries(value)) {
		const path = ["providers", "custom", name];
		// Checked before anything is copied: rejects `__proto__` and
		// reserved/built-in names.
		const nameIssue = customProviderNameIssues(name)[0];
		if (nameIssue) {
			issues.push(warning(path, nameIssue));
			continue;
		}
		keepBlock(custom, name, entry, profile.customEntrySchema, profile, path, issues);
	}
	providers.custom = custom;
}

/**
 * Recover the `agentEngines` block field by field: each engine block, each
 * pool setting and each ACP agent is kept or dropped on its own, so one bad
 * entry never takes down its siblings (an admin's master switch included).
 */
function salvageAgentEngines<T>(
	agentEngines: Record<string, unknown>,
	profile: SalvageProfile<T>,
	issues: ConfigIssue[],
): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(agentEngines)) {
		const path = ["agentEngines", key];
		if (key === "acp") {
			salvageAcpAgents(result, value, profile, issues);
			continue;
		}
		if (!Object.hasOwn(AGENT_ENGINE_FIELD_SCHEMAS, key)) {
			issues.push(warning(path, `Unrecognized key: "${key}".`));
			continue;
		}
		const block = ENGINES_WITH_NAMED_PRINCIPALS.has(key)
			? withoutObsoleteEngineKey(value, path, issues)
			: value;
		keepBlock(result, key, block, AGENT_ENGINE_FIELD_SCHEMAS[key], profile, path, issues);
	}
	return result;
}

function salvageAcpAgents<T>(
	agentEngines: Record<string, unknown>,
	value: unknown,
	profile: SalvageProfile<T>,
	issues: ConfigIssue[],
): void {
	if (!isPlainObject(value)) {
		issues.push(warning(["agentEngines", "acp"], "Invalid input: expected an object."));
		return;
	}
	const agents: Record<string, unknown> = {};
	for (const [agentId, entry] of Object.entries(value)) {
		const path = ["agentEngines", "acp", agentId];
		// Checked before anything is copied; the pattern also rejects `__proto__`.
		if (!ACP_AGENT_ID_PATTERN.test(agentId)) {
			issues.push(warning(path, ACP_AGENT_ID_MESSAGE));
			continue;
		}
		const agent = withoutObsoleteEngineKey(entry, path, issues);
		keepBlock(agents, agentId, agent, acpAgentEngineSchema, profile, path, issues);
	}
	agentEngines.acp = agents;
}

/** The engine blocks that accepted `allowNamedPrincipals` (ACP agents too). */
const ENGINES_WITH_NAMED_PRINCIPALS: ReadonlySet<string> = new Set(["copilot", "codex"]);

/**
 * `allowNamedPrincipals` shipped on these blocks before every enabled engine
 * was offered to every user. Files that still set it keep their engine
 * configuration: the key is removed with a warning, where strict validation
 * would drop the whole block. Other unknown keys still drop it. Remove this
 * after one release.
 */
function withoutObsoleteEngineKey(
	value: unknown,
	path: ConfigPath,
	issues: ConfigIssue[],
): unknown {
	if (!isPlainObject(value) || !Object.hasOwn(value, "allowNamedPrincipals")) return value;
	// An own `__proto__` key survives the copy, so `keepBlock()` still rejects it.
	const { allowNamedPrincipals: _obsolete, ...rest } = value;
	issues.push(
		warning(
			[...path, "allowNamedPrincipals"],
			'"allowNamedPrincipals" is obsolete and ignored: every enabled engine is offered to every user. Remove it from the file.',
		),
	);
	return rest;
}

/**
 * Keep one provider block if it survives, in order: the unsafe-key scan on
 * the raw block (pruning could otherwise remove the unknown field holding a
 * `__proto__` key), pruning (fragment profile only), and validation. A block
 * failing the scan or validation is dropped with a warning.
 */
function keepBlock<T>(
	target: Record<string, unknown>,
	key: string,
	value: unknown,
	schema: z.core.$ZodType,
	profile: SalvageProfile<T>,
	path: ConfigPath,
	issues: ConfigIssue[],
): void {
	const unsafePath = unsafeObjectKeyPaths(value)[0];
	if (unsafePath) {
		issues.push(
			warning(path, `Object key "__proto__" at ${formatRelativePath(unsafePath)} is unsafe.`),
		);
		return;
	}
	let candidate = value;
	if (profile.pruneUnknownKeys) {
		const pruned = pruneUnknownKeys(value, schema, path);
		issues.push(...pruned.issues);
		candidate = pruned.value;
	}
	const parsed = z.safeParse(schema, candidate);
	if (parsed.success) {
		target[key] = parsed.data;
		return;
	}
	issues.push(warning(path, parsed.error.issues[0]?.message ?? "Invalid provider block."));
}

function formatRelativePath(path: ConfigIssue["path"]): string {
	return path.length === 0 ? "the provider block" : path.map(String).join(".");
}

function warning(path: ConfigPath, message: string): ConfigIssue {
	return { severity: "warning", path, message };
}
