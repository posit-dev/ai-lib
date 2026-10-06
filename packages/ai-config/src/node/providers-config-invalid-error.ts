/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Typed, secret-safe failure for a providers.json mutation that could not
 * proceed because a config was invalid.
 *
 * Hosts surface this to users ("why did my save fail?"). It deliberately
 * carries only diagnostics that cannot contain credential material:
 *
 * - the config file path;
 * - for `syntax`: the JSONC parse error code, line, and column;
 * - for `schema`: Zod issue paths (key names) and messages.
 *
 * Zod 4's built-in messages report expected types and options, never the
 * received value, and ai-config's custom messages name keys only. No raw
 * input is ever copied in, so hosts may forward these fields as-is.
 */

import * as z from "zod/v4";

import { configIssuePath } from "../config-issue.js";
import type {
	ProvidersConfigInvalidDetail,
	ProvidersConfigInvalidPhase,
	ProvidersConfigSchemaIssue,
} from "../providers-config-invalid.js";
import { JsoncSyntaxError } from "./parse-jsonc.js";

export class ProvidersConfigInvalidError extends Error {
	override readonly name = "ProvidersConfigInvalidError";

	constructor(
		readonly configPath: string,
		readonly phase: ProvidersConfigInvalidPhase,
		readonly detail: ProvidersConfigInvalidDetail,
	) {
		super(formatMessage(configPath, phase, detail));
	}
}

/**
 * Classify a parse/validate failure of the existing file. Returns `undefined`
 * for failures that are not invalid content (e.g. the file was unreadable).
 */
export function existingFileInvalidError(
	configPath: string,
	error: unknown,
): ProvidersConfigInvalidError | undefined {
	if (error instanceof JsoncSyntaxError) {
		return new ProvidersConfigInvalidError(configPath, "existing-file", {
			kind: "syntax",
			code: error.code,
			line: error.line,
			column: error.column,
		});
	}
	if (error instanceof z.ZodError) {
		return new ProvidersConfigInvalidError(configPath, "existing-file", {
			kind: "schema",
			issues: schemaIssues(error.issues),
		});
	}
	return undefined;
}

/** Build the failure for a mutation result that does not validate. */
export function proposedResultInvalidError(
	configPath: string,
	issues: readonly z.core.$ZodIssue[],
): ProvidersConfigInvalidError {
	return new ProvidersConfigInvalidError(configPath, "proposed-result", {
		kind: "schema",
		issues: schemaIssues(issues),
	});
}

function schemaIssues(issues: readonly z.core.$ZodIssue[]): ProvidersConfigSchemaIssue[] {
	return issues.map((issue) => ({ path: configIssuePath(issue.path), message: issue.message }));
}

function formatMessage(
	configPath: string,
	phase: ProvidersConfigInvalidPhase,
	detail: ProvidersConfigInvalidDetail,
): string {
	const summary =
		detail.kind === "syntax"
			? `${detail.code} at line ${detail.line}, column ${detail.column}`
			: detail.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
	return phase === "existing-file"
		? `[ai-config] Cannot mutate ${configPath}: ${summary}. Mutation aborted until the file is fixed.`
		: `[ai-config] Mutated config is invalid: ${summary}`;
}
