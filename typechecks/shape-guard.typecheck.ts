/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shape Guard — compile-time assertions that ai-config's vocabulary stays
 * compatible with ai-provider-bridge.
 *
 * This file is type-checked (never emitted) on every PR to either package.
 * A build error here means the two packages' vocabularies have diverged.
 *
 * How it works: each assertion uses conditional types that resolve to `never`
 * when the constraint is violated, then assigns that to a variable typed as
 * `true`. If the constraint holds, the conditional resolves to `true` and the
 * assignment succeeds; if it fails, you get a type error.
 *
 * STATUS: provider-id, model-override-field, protocol, and client-kind guards
 * are all active.
 */

import type {
	BUILTIN_PROVIDER_IDS,
	CLIENT_KIND_VALUES,
	MODEL_METADATA_FIELD_NAMES,
	PROTOCOL_VALUES,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES as AI_CONFIG_SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
} from "ai-config";
import type { SUPPORTED_CUSTOM_CLIENT_KIND_VALUES } from "ai-credentials/types";
import type {
	ModelInfo,
	NonIdentityClientKind,
	NonIdentityFactoryId,
	Protocol,
	PROVIDER_IDS,
} from "ai-provider-bridge";

// ---------------------------------------------------------------------------
// Helper types
// ---------------------------------------------------------------------------

/** True if every element of tuple A is assignable to an element of tuple B. */
type TupleSubset<
	A extends readonly string[],
	B extends readonly string[],
> = A[number] extends B[number] ? true : never;

/** True if A and B have exactly the same element set. */
type TupleEqual<A extends readonly string[], B extends readonly string[]> = [
	TupleSubset<A, B>,
	TupleSubset<B, A>,
] extends [true, true]
	? true
	: never;

/** True if every element of string tuple A is a key of object type T. */
type AllKeysOf<A extends readonly string[], T> = A[number] extends keyof T ? true : never;

/** True if every element of string tuple A is assignable to type T. */
type TupleValuesAssignableTo<A extends readonly string[], T extends string> = A[number] extends T
	? true
	: never;

// ---------------------------------------------------------------------------
// Assertion 1: BUILTIN_PROVIDER_IDS ≡ PROVIDER_IDS
//
// ai-config's local list must exactly match the bridge's authoritative list.
// If the bridge adds or removes a provider id, this fails until ai-config
// is updated (or vice versa).
// ---------------------------------------------------------------------------

const _providerIdsMatch: TupleEqual<typeof BUILTIN_PROVIDER_IDS, typeof PROVIDER_IDS> = true;

// ---------------------------------------------------------------------------
// Assertion 2: MODEL_METADATA_FIELD_NAMES ⊆ keyof ModelInfo
//
// Every metadata field ai-config allows in model overrides must exist on the
// bridge's ModelInfo. Routing-only fields (baseUrl) are intentionally excluded
// — they are config-layer routing concerns, not ModelInfo properties.
// ---------------------------------------------------------------------------

const _overrideFieldsSubset: AllKeysOf<typeof MODEL_METADATA_FIELD_NAMES, ModelInfo> = true;

// ---------------------------------------------------------------------------
// Assertion 3: PROTOCOL_VALUES ⊆ Protocol
//
// Every protocol value ai-config defines must be assignable to the bridge's
// Protocol type. This ensures the two packages' protocol enums stay in sync.
// The bridge's Protocol type is the canonical definition; ai-config mirrors it.
// ---------------------------------------------------------------------------

const _protocolValuesSubset: TupleValuesAssignableTo<typeof PROTOCOL_VALUES, Protocol> = true;

// ---------------------------------------------------------------------------
// Assertion 4: CLIENT_KIND_VALUES ⊆ PROVIDER_IDS ∪ non-identity mappings
//
// Every client-kind value from ai-config must resolve to a factory registered
// under a built-in provider id. Non-identity entries in
// CLIENT_KIND_TO_FACTORY_ID (aws→bedrock, snowflake→snowflake-cortex) map to
// the corresponding provider id. Identity entries are provider ids themselves.
// This assertion verifies that every client kind is either:
// (a) a built-in provider id (identity mapping), or
// (b) a known non-identity key whose target is a built-in provider id.
//
// Since both CLIENT_KIND_TO_FACTORY_ID and PROVIDER_IDS are maintained in the
// bridge package, a divergence here means a client kind was added without a
// factory registration.
// ---------------------------------------------------------------------------

// 4a: Non-identity factory targets are valid provider ids.
// NonIdentityFactoryId is derived from NON_IDENTITY_MAPPING in ProviderRegistry
// (the single source of truth for the client-kind → factory-id mapping).
const _nonIdentityTargetsAreProviderIds: NonIdentityFactoryId extends (typeof PROVIDER_IDS)[number]
	? true
	: never = true;

// 4b: Every client kind is either a provider id (identity) or a non-identity key.
// NonIdentityClientKind is derived from NON_IDENTITY_MAPPING in ProviderRegistry.
type AllClientKindsCovered = (typeof CLIENT_KIND_VALUES)[number] extends
	| (typeof PROVIDER_IDS)[number]
	| NonIdentityClientKind
	? true
	: never;
const _clientKindsCovered: AllClientKindsCovered = true;

// ---------------------------------------------------------------------------
// Assertion 5: SUPPORTED_CUSTOM_CLIENT_KIND_VALUES ⊆ CLIENT_KIND_VALUES
//
// Every supported custom client kind in ai-credentials must be a valid
// client kind from ai-config. This enforces the no-import-edge pattern: the
// values are plain string literals, and this guard ensures they stay in sync
// with the CLIENT_KIND_VALUES enum.
// ---------------------------------------------------------------------------

const _customClientKindsCovered: TupleSubset<
	typeof SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
	typeof CLIENT_KIND_VALUES
> = true;

// ---------------------------------------------------------------------------
// Assertion 6: ai-config's SUPPORTED_CUSTOM_CLIENT_KIND_VALUES ≡ ai-credentials'
//
// ai-config mirrors ai-credentials/types' supported-custom-kinds list locally
// (no import edge between the two leaf packages). This guard asserts the two
// lists are EXACTLY equal — the schema's custom discriminated union and the
// credential resolver must offer the same set of custom `type` values, or a
// kind would be schema-valid but credential-unresolvable (or vice versa).
// ---------------------------------------------------------------------------

const _supportedCustomKindsEqual: TupleEqual<
	typeof AI_CONFIG_SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
	typeof SUPPORTED_CUSTOM_CLIENT_KIND_VALUES
> = true;

// ---------------------------------------------------------------------------
// Suppress unused-variable warnings
// ---------------------------------------------------------------------------

void _providerIdsMatch;
void _overrideFieldsSubset;
void _protocolValuesSubset;
void _nonIdentityTargetsAreProviderIds;
void _clientKindsCovered;
void _customClientKindsCovered;
void _supportedCustomKindsEqual;
