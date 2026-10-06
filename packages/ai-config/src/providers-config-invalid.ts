/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Browser-safe shapes describing why providers.json is (or would become)
 * invalid. Thrown inside `ProvidersConfigInvalidError` by the node entry's
 * mutation seam; exported from the pure entry so hosts can carry the same
 * shapes across browser boundaries without importing node code.
 *
 * Every field is secret-safe: key paths, Zod 4 messages (which never echo
 * received values), and syntax positions.
 */

/** Which config failed validation. */
export type ProvidersConfigInvalidPhase =
	/** The file already on disk is invalid; nothing was attempted. */
	| "existing-file"
	/** The file was valid, but the requested change would make it invalid. */
	| "proposed-result";

/** One schema problem: where it is, and what is wrong. */
export interface ProvidersConfigSchemaIssue {
	readonly path: readonly (string | number)[];
	readonly message: string;
}

/** Why the config is invalid. */
export type ProvidersConfigInvalidDetail =
	| {
			readonly kind: "syntax";
			/** jsonc-parser error code name, e.g. `PropertyNameExpected`. */
			readonly code: string;
			/** 1-based. */
			readonly line: number;
			/** 1-based. */
			readonly column: number;
	  }
	| {
			readonly kind: "schema";
			readonly issues: readonly ProvidersConfigSchemaIssue[];
	  };
