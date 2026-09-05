/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Web-search capability finalization.
 *
 * Discovery reports intrinsic model metadata (the family rules in the
 * capability tables). Whether a model may actually advertise the hosted
 * web-search toggle depends on the resolved serving context — effective
 * route, effective endpoint, provider kind, AWS region, and FIPS policy —
 * which only exists after `resolveModels()` has applied overrides and
 * routing. This module owns that final step so every host (Node, Positron)
 * computes the same final `supportsWebSearch` from the same inputs.
 *
 * Policy (see the OpenAI/Bedrock web-search plan):
 *
 * 1. A non-Responses effective route never has hosted search on OpenAI or
 *    Bedrock, regardless of any override.
 * 2. Built-in OpenAI on its canonical Responses endpoint defaults to `true`;
 *    an explicit `false` override wins.
 * 3. A redirected built-in OpenAI endpoint defaults to `false`; an explicit
 *    `true` may opt in when the gateway genuinely serves Responses search.
 * 4. A custom OpenAI provider defaults to `false` and requires an explicit
 *    `true` plus Responses routing.
 * 5. Bedrock requires a documented Mantle GPT family, the Mantle Responses
 *    route, a web-search-enabled region, and no FIPS veto. An explicit
 *    `false` disables it; an explicit `true` cannot bypass the service gates.
 * 6. Providers outside this policy keep their already-resolved capability
 *    unchanged (no context is built for them).
 */

import { OPENAI_API_VERSION, OPENAI_HOST } from "../base-url.js";
import { BEDROCK_DEFAULTS } from "../defaults.js";
import type { ResolvedConnection, ResolvedModelInfo } from "../types.js";
import type { ClientKind } from "../vocabulary.js";
import { getBedrockMantleModelCapabilities } from "./bedrock-mantle-helpers.js";

/**
 * AWS regions where Bedrock Mantle web search is available — deliberately
 * narrower than Mantle inference availability. Verified against
 * https://docs.aws.amazon.com/bedrock/latest/userguide/web-search.html on
 * 2026-09-05. A newly supported region requires a deliberate update backed
 * by current AWS documentation.
 */
const MANTLE_WEB_SEARCH_REGIONS: ReadonlySet<string> = new Set([
	"us-east-1",
	"us-east-2",
	"us-west-2",
]);

/** The canonical OpenAI Responses API root (host + version segment). */
const OPENAI_CANONICAL_BASE_URL = `${OPENAI_HOST}/${OPENAI_API_VERSION}`;

/**
 * The serving contexts the web-search policy applies to. Providers that fit
 * none of these keep their discovered/declared capability untouched.
 */
export type WebSearchServing =
	| { readonly kind: "openai-builtin" }
	| { readonly kind: "openai-custom" }
	| {
			readonly kind: "bedrock-mantle";
			/** Effective AWS region (credential-synthesis fallback applied). */
			readonly awsRegion: string;
			/**
			 * Whether AWS FIPS endpoints are mandated. `undefined` means the
			 * host could not determine it; Mantle discovery already withholds
			 * Mantle models under FIPS, and the client vetoes the route at
			 * request time, so an unknown flag fails safe for discovered
			 * models.
			 */
			readonly awsFips: boolean | undefined;
	  };

/**
 * Build the serving context for one catalog provider, or `undefined` when
 * the provider is outside the web-search policy (rule 6).
 *
 * @param provider - The resolved catalog entry (id, clientKind, connection).
 * @param awsFips - The host-resolved FIPS flag for AWS providers; pass
 *   `undefined` when unknown.
 */
export function resolveWebSearchServing(
	provider: {
		readonly id: string;
		readonly clientKind: ClientKind;
		readonly connection?: ResolvedConnection;
	},
	awsFips?: boolean,
): WebSearchServing | undefined {
	if (provider.clientKind === "openai") {
		// Among built-ins only `openai` itself has the "openai" client kind;
		// every other built-in (databricks, ms-foundry, openai-compatible, …)
		// has its own kind and stays outside the policy.
		return { kind: provider.id === "openai" ? "openai-builtin" : "openai-custom" };
	}
	if (provider.clientKind === "aws") {
		return {
			kind: "bedrock-mantle",
			// The resolved connection deliberately omits the built-in region
			// default (it is applied at credential-synthesis time), so apply
			// the same last-resort fallback here.
			awsRegion: provider.connection?.aws?.region ?? BEDROCK_DEFAULTS.aws.region,
			awsFips,
		};
	}
	return undefined;
}

/**
 * Compute the final `supportsWebSearch` for one resolved model.
 *
 * @param model - The model after override application and routing resolution.
 * @param explicit - The user-configured `supportsWebSearch` value (from a
 *   custom model declaration or an override), or `undefined` when the user
 *   never stated one. Kept separate from the discovered value so deliberate
 *   opt-ins and opt-outs survive finalization.
 * @param serving - The provider's serving context, or `undefined` for
 *   providers outside the policy (the model's value passes through).
 */
export function finalizeWebSearchCapability(
	model: ResolvedModelInfo,
	explicit: boolean | undefined,
	serving: WebSearchServing | undefined,
): boolean {
	if (!serving) {
		return model.supportsWebSearch;
	}

	if (serving.kind === "bedrock-mantle") {
		// Rule 5: every gate is a service fact; no override can bypass them.
		// Unlike the OpenAI client kinds, Bedrock has no Responses default —
		// an unresolved protocol means the Converse/Anthropic heuristic route.
		if (model.resolvedProtocol !== "openai-responses") {
			return false;
		}
		if (serving.awsFips === true) {
			return false;
		}
		if (!MANTLE_WEB_SEARCH_REGIONS.has(serving.awsRegion)) {
			return false;
		}
		if (explicit === false) {
			return false;
		}
		// The family rule is re-derived from the model ID rather than read
		// from the (possibly overridden) model record, so an explicit `true`
		// cannot manufacture eligibility for gpt-oss or unknown families.
		return getBedrockMantleModelCapabilities(model.id)?.supportsWebSearch === true;
	}

	// OpenAI client kinds default to the Responses route when no protocol is
	// configured (the provider factory constructs the client in Responses
	// mode), so an unresolved protocol is the Responses route here.
	const effectiveRoute = model.resolvedProtocol ?? "openai-responses";
	if (effectiveRoute !== "openai-responses") {
		// Rule 1: Chat Completions (and MLflow-Responses) carry no hosted
		// search on these routes, regardless of any override.
		return false;
	}
	if (explicit !== undefined) {
		// Rules 2–4: an explicit value always wins on the Responses route —
		// `false` opts out of the canonical default, `true` opts in on a
		// redirected or custom endpoint.
		return explicit;
	}
	if (serving.kind === "openai-builtin") {
		// Rule 2 vs 3: only the canonical endpoint defaults on.
		return isCanonicalOpenAIEndpoint(model.resolvedBaseUrl);
	}
	// Rule 4: custom OpenAI providers require explicit opt-in.
	return false;
}

/**
 * Whether the effective base URL is OpenAI's canonical API root. An
 * unresolved base URL means the client falls back to its built-in default,
 * which is the canonical endpoint.
 */
function isCanonicalOpenAIEndpoint(baseUrl: string | undefined): boolean {
	if (baseUrl === undefined) {
		return true;
	}
	return baseUrl.replace(/\/+$/, "") === OPENAI_CANONICAL_BASE_URL;
}
