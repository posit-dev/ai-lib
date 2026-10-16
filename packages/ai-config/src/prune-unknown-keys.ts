/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Schema-guided removal of unrecognized keys from a config fragment. Internal
 * to ai-config — not exported from any entrypoint.
 *
 * Only keys are judged here; values are never validated or coerced. A value of
 * the wrong container kind (an array or `null` where an object belongs, an
 * object where an array belongs) passes through untouched so the caller's
 * schema validation sees what was written and rejects it.
 *
 * Not a security boundary: callers must reject unsafe `__proto__` keys on the
 * raw value with `unsafeObjectKeyPaths` before pruning, because pruning can
 * remove the unknown field that holds one. Copies are still built without the
 * `__proto__` setter as a second guard.
 */

import * as z from "zod/v4";

import type { ConfigIssue } from "./config-issue.js";
import { isPlainObject } from "./is-plain-object.js";

type ConfigPath = readonly (string | number)[];

export interface PrunedValue {
	readonly value: unknown;
	readonly issues: ConfigIssue[];
}

/**
 * Return a copy of `value` with every key `schema` does not recognize removed,
 * at any depth, plus one warning per removed key. `path` is the location of
 * `value` in the whole config, so each warning carries the removed key's full
 * path.
 *
 * - Object schemas: a key is recognized only if it is an own key of the
 *   schema's shape (`constructor`, `toString`, ... are not).
 * - Record schemas: keys are data (header names, model ids, provider names)
 *   and are kept when the key schema accepts them; only rejected keys (e.g. an
 *   unknown protocol under `endpoints`) are removed.
 * - Array schemas: each element is pruned against the element schema.
 * - Optional/nullable/default wrappers are unwrapped; preprocess pipes are
 *   pruned against their output schema.
 * - Every other schema (enums, literals, primitives, unions) passes the value
 *   through unchanged.
 */
export function pruneUnknownKeys(
	value: unknown,
	schema: z.core.$ZodType,
	path: ConfigPath,
): PrunedValue {
	const issues: ConfigIssue[] = [];
	return { value: prune(value, schema, path, issues), issues };
}

function prune(
	value: unknown,
	schema: z.core.$ZodType,
	path: ConfigPath,
	issues: ConfigIssue[],
): unknown {
	if (
		schema instanceof z.ZodOptional ||
		schema instanceof z.ZodNullable ||
		schema instanceof z.ZodDefault
	) {
		return prune(value, schema.unwrap(), path, issues);
	}
	if (schema instanceof z.ZodPipe) {
		// `z.preprocess` is a pipe from a transform into the real schema; any
		// other pipe validates its input against `in`.
		return prune(value, schema.in instanceof z.ZodTransform ? schema.out : schema.in, path, issues);
	}
	if (schema instanceof z.ZodObject) {
		if (!isPlainObject(value)) return value;
		const shape: Record<string, z.core.$ZodType> = schema.shape;
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			const keyPath = [...path, key];
			if (!Object.hasOwn(shape, key)) {
				issues.push(unrecognizedKey(keyPath, key));
				continue;
			}
			defineKey(copy, key, prune(value[key], shape[key], keyPath, issues));
		}
		return copy;
	}
	if (schema instanceof z.ZodRecord) {
		if (!isPlainObject(value)) return value;
		const copy: Record<string, unknown> = {};
		for (const key of Object.keys(value)) {
			const keyPath = [...path, key];
			if (!z.safeParse(schema.keyType, key).success) {
				issues.push(unrecognizedKey(keyPath, key));
				continue;
			}
			defineKey(copy, key, prune(value[key], schema.valueType, keyPath, issues));
		}
		return copy;
	}
	if (schema instanceof z.ZodArray) {
		if (!Array.isArray(value)) return value;
		const element = schema.element;
		return value.map((item, index) => prune(item, element, [...path, index], issues));
	}
	return value;
}

/** Add an own data property without ever invoking the `__proto__` setter. */
function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

function unrecognizedKey(path: ConfigPath, key: string): ConfigIssue {
	return { severity: "warning", path, message: `Unrecognized key: "${key}".` };
}
