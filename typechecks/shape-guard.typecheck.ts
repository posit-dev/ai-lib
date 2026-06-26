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
 * STATUS: provider-id and model-override-field guards are active. Protocol and
 * client-kind guards are deferred to Phase 4, which widens the bridge's
 * protocol enum from `"anthropic" | "openai"` to the richer set that
 * ai-config already defines. Until then, a protocol guard would always fail
 * because the bridge and ai-config intentionally diverge (ai-config defines
 * the target state; the bridge hasn't caught up yet).
 */

import type { BUILTIN_PROVIDER_IDS, MODEL_METADATA_FIELD_NAMES } from "ai-config";
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
// Assertion 2: MODEL_METADATA_FIELD_NAMES ⊆ keyof ModelInfo
//
// Every metadata field ai-config allows in model overrides must exist on the
// bridge's ModelInfo. Routing-only fields (baseUrl) are intentionally excluded
// — they are config-layer routing concerns, not ModelInfo properties.
// Note: this checks field *names* only, not that their types match — the
// bridge's ModelInfo.protocol is `"anthropic" | "openai"` while ai-config
// accepts the wider Protocol enum. Type compatibility is deferred to Phase 4
// when the bridge widens its protocol type.
// ---------------------------------------------------------------------------

const _overrideFieldsSubset: AllKeysOf<typeof MODEL_METADATA_FIELD_NAMES, ModelInfo> = true;

// ---------------------------------------------------------------------------
// TODO (Phase 4): Protocol and client-kind compatibility guards
//
// Once the bridge widens ModelInfo.protocol from `"anthropic" | "openai"` to
// the richer enum (Phase 4), add:
//
// - Assertion 3: ai-config PROTOCOL_VALUES ⊆ bridge's protocol union
// - Assertion 4: ai-config CLIENT_KIND_VALUES elements map to bridge clients
//
// These cannot be written today because the bridge hasn't widened yet — the
// two packages intentionally diverge (ai-config defines the target state).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Suppress unused-variable warnings
// ---------------------------------------------------------------------------

void _providerIdsMatch;
void _overrideFieldsSubset;
