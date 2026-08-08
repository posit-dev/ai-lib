/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { RefinementCtx } from "zod/v4";

import { configIssuePath } from "./config-issue.js";
import type { ConfigIssue } from "./config-issue.js";

const UNSAFE_OBJECT_KEY = "__proto__";

/** Find raw own keys that Zod object/record parsing would otherwise omit. */
export function unsafeObjectKeyPaths(value: unknown): readonly ConfigIssue["path"][] {
	const paths: ConfigIssue["path"][] = [];
	visit(value, [], paths, new WeakSet<object>());
	return paths;
}

/** Reject unsafe raw keys before the full config schema can silently omit them. */
export function validateUnsafeObjectKeys(value: unknown, ctx: RefinementCtx): unknown {
	for (const path of unsafeObjectKeyPaths(value)) {
		// providers.custom has its own shared provider-name policy and message.
		if (
			path.length === 3 &&
			path[0] === "providers" &&
			path[1] === "custom" &&
			path[2] === UNSAFE_OBJECT_KEY
		) {
			continue;
		}
		ctx.addIssue({
			code: "custom",
			path: [...path],
			message: `Object key "${UNSAFE_OBJECT_KEY}" is unsafe.`,
		});
	}
	return value;
}

function visit(
	value: unknown,
	path: readonly (string | number)[],
	paths: ConfigIssue["path"][],
	seen: WeakSet<object>,
): void {
	if (typeof value !== "object" || value === null || seen.has(value)) {
		return;
	}
	seen.add(value);

	if (Array.isArray(value)) {
		for (const [index, item] of value.entries()) {
			visit(item, [...path, index], paths, seen);
		}
		return;
	}

	for (const key of Object.keys(value)) {
		const nextPath = [...path, key];
		if (key === UNSAFE_OBJECT_KEY) {
			paths.push(configIssuePath(nextPath));
			continue;
		}
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (descriptor && "value" in descriptor) {
			visit(descriptor.value, nextPath, paths, seen);
		}
	}
}
