/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * `$ref` inlining for outgoing tool schemas.
 *
 * Some serving stacks reject tool schemas that contain JSON-pointer
 * references: Kimi K2.7 Code's Baseten deployment returns HTTP 500 for any
 * tool schema with a `$ref`, even a non-recursive one. References are easy
 * to emit accidentally — zod v4's `z.json()` serializes to a recursive
 * `$ref`, and MCP servers commonly produce `$defs`/`definitions` — so the
 * Posit AI openai-chat path inlines every reference before the request
 * leaves the client.
 *
 * Resolution is best-effort but the output invariant is strict: no `$ref`
 * remains. Local pointers (`#`, `#/definitions/…`, `#/$defs/…`) are inlined;
 * a reference that cannot be inlined faithfully (a cycle, an external URI, a
 * dangling pointer) becomes the permissive `{}` schema, keeping any sibling
 * annotations such as `description`. Loosening validation guidance is
 * strictly better than a request the server rejects outright.
 */

/**
 * Return `body` with every tool's `parameters` schema dereferenced.
 * Bodies whose tool schemas contain no `$ref` are returned unchanged.
 */
export function dereferenceToolParameters(body: Record<string, unknown>): Record<string, unknown> {
	const tools = body.tools;
	if (!Array.isArray(tools)) {
		return body;
	}

	let changed = false;
	const newTools = tools.map((tool: unknown) => {
		if (!isRecord(tool) || !isRecord(tool.function)) {
			return tool;
		}
		const parameters = tool.function.parameters;
		if (!containsRef(parameters)) {
			return tool;
		}
		changed = true;
		return {
			...tool,
			function: { ...tool.function, parameters: dereferenceJsonSchema(parameters) },
		};
	});

	return changed ? { ...body, tools: newTools } : body;
}

/**
 * Return a copy of `schema` with all local `$ref`s inlined and the
 * root-level `definitions`/`$defs` containers dropped.
 */
export function dereferenceJsonSchema(schema: unknown): unknown {
	if (!isRecord(schema)) {
		return schema;
	}
	const result = inline(schema, schema, new Set(), 0);
	if (isRecord(result)) {
		const { definitions: _definitions, $defs: _$defs, ...rest } = result;
		return rest;
	}
	return result;
}

/**
 * Guard against pathological pointer chains; anything deeper collapses to
 * the permissive `{}` schema, preserving the no-`$ref` invariant.
 */
const MAX_DEPTH = 100;

function inline(
	node: unknown,
	root: Record<string, unknown>,
	expanding: Set<unknown>,
	depth: number,
): unknown {
	if (depth > MAX_DEPTH) {
		return {};
	}
	if (Array.isArray(node)) {
		return node.map((item) => inline(item, root, expanding, depth + 1));
	}
	if (!isRecord(node)) {
		return node;
	}

	const ref = node.$ref;
	if (typeof ref !== "string") {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(node)) {
			out[key] = inline(value, root, expanding, depth + 1);
		}
		return out;
	}

	// Reference node: inline the target, then lay walked siblings (e.g.
	// `description`) over it. A cycle or unresolvable target inlines as `{}`.
	const target = resolvePointer(root, ref);
	let inlined: unknown = {};
	if (target !== undefined && !expanding.has(target)) {
		expanding.add(target);
		inlined = inline(target, root, expanding, depth + 1);
		expanding.delete(target);
	}

	const siblings = Object.entries(node).filter(([key]) => key !== "$ref");
	if (!isRecord(inlined)) {
		// Boolean schemas are valid targets; only usable verbatim without siblings.
		return siblings.length === 0 ? inlined : {};
	}
	const result: Record<string, unknown> = { ...inlined };
	for (const [key, value] of siblings) {
		result[key] = inline(value, root, expanding, depth + 1);
	}
	return result;
}

/** Resolve a local JSON pointer (`#`, `#/a/b`) against the schema root. */
function resolvePointer(root: Record<string, unknown>, ref: string): unknown {
	if (ref === "#") {
		return root;
	}
	if (!ref.startsWith("#/")) {
		return undefined;
	}
	let current: unknown = root;
	for (const raw of ref.slice(2).split("/")) {
		const key = raw.replace(/~1/g, "/").replace(/~0/g, "~");
		if (Array.isArray(current)) {
			const index = Number(key);
			current = Number.isInteger(index) ? current[index] : undefined;
		} else if (isRecord(current)) {
			current = current[key];
		} else {
			return undefined;
		}
		if (current === undefined) {
			return undefined;
		}
	}
	return current;
}

function containsRef(node: unknown): boolean {
	if (Array.isArray(node)) {
		return node.some(containsRef);
	}
	if (!isRecord(node)) {
		return false;
	}
	if (typeof node.$ref === "string") {
		return true;
	}
	return Object.values(node).some(containsRef);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
