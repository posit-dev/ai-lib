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
 */

import type { BUILTIN_PROVIDER_IDS, MODEL_OVERRIDE_FIELD_NAMES } from "ai-config";
import type { PROVIDER_IDS, ModelInfo } from "ai-provider-bridge";

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

// ---------------------------------------------------------------------------
// Assertion 1: BUILTIN_PROVIDER_IDS ≡ PROVIDER_IDS
//
// ai-config's local list must exactly match the bridge's authoritative list.
// If the bridge adds or removes a provider id, this fails until ai-config
// is updated (or vice versa).
// ---------------------------------------------------------------------------

const _providerIdsMatch: TupleEqual<typeof BUILTIN_PROVIDER_IDS, typeof PROVIDER_IDS> = true;

// ---------------------------------------------------------------------------
// Assertion 2: MODEL_OVERRIDE_FIELD_NAMES ⊆ keyof ModelInfo
//
// Every field ai-config allows in model overrides must exist on the bridge's
// ModelInfo. If the bridge renames or removes a field, this fails.
// ---------------------------------------------------------------------------

const _overrideFieldsSubset: AllKeysOf<typeof MODEL_OVERRIDE_FIELD_NAMES, ModelInfo> = true;

// ---------------------------------------------------------------------------
// Suppress unused-variable warnings
// ---------------------------------------------------------------------------

void _providerIdsMatch;
void _overrideFieldsSubset;
