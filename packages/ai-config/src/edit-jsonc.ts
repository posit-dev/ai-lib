/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure, policy-free JSONC editing.
 *
 * The transformer preserves source text outside the changed JSON paths. Callers
 * remain responsible for validating the source and intended value against
 * their own configuration contract.
 */

import {
	applyEdits,
	getNodeValue,
	modify,
	parseTree,
	printParseErrorCode,
	type FormattingOptions,
	type JSONPath,
	type Node,
	type ParseError,
} from "jsonc-parser";

interface JsoncChange {
	path: JSONPath;
	value: unknown;
}

/**
 * Apply the smallest semantic set of edits needed to make JSONC text represent
 * an intended JSON value.
 *
 * The intended value is normalized through JSON.stringify/JSON.parse before it
 * is compared or written. This intentionally inherits JSON.stringify's value
 * semantics, including toJSON handling and errors for BigInt and cycles.
 */
export function editJsonc(originalText: string, intendedValue: unknown): string {
	const normalizedValue = normalizeJsonValue(intendedValue);
	const { root, value: currentValue } = parseJsoncTree(originalText);
	const changes: JsoncChange[] = [];
	collectChanges(currentValue, normalizedValue, [], changes);

	if (changes.length === 0) {
		return originalText;
	}

	const duplicatePaths = collectDuplicatePaths(root);
	for (const change of changes) {
		const ambiguousPath = duplicatePaths.find((path) => pathsOverlap(path, change.path));
		if (ambiguousPath !== undefined) {
			throw new Error(
				`Cannot edit JSONC path ${formatPath(change.path)} because duplicate key path ${formatPath(ambiguousPath)} is ambiguous`,
			);
		}
	}

	const formattingOptions = inferFormattingOptions(originalText, root);
	let editedText = originalText;
	for (const change of changes) {
		const edits = modify(editedText, change.path, change.value, { formattingOptions });
		editedText = applyEdits(editedText, edits);
	}

	const editedValue = parseJsoncTree(editedText).value;
	if (!jsonValuesEqual(editedValue, normalizedValue)) {
		throw new Error("JSONC edit did not produce the intended JSON value");
	}

	return editedText;
}

/** Normalize a value through the same serialization round trip used by JSON writers. */
export function normalizeJsonValue(value: unknown): unknown {
	const serialized = JSON.stringify(value);
	if (serialized === undefined) {
		throw new TypeError("The intended value cannot be represented as JSON");
	}
	return JSON.parse(serialized);
}

function parseJsoncTree(text: string): { root: Node | undefined; value: unknown } {
	const errors: ParseError[] = [];
	const root = parseTree(text, errors, { allowTrailingComma: true });
	if (errors.length > 0) {
		const first = errors[0];
		throw new SyntaxError(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
	}
	return { root, value: root === undefined ? undefined : getNodeValue(root) };
}

function collectChanges(
	current: unknown,
	intended: unknown,
	path: JSONPath,
	changes: JsoncChange[],
): void {
	if (jsonValuesEqual(current, intended)) {
		return;
	}

	if (!isJsonObject(current) || !isJsonObject(intended)) {
		changes.push({ path, value: intended });
		return;
	}

	for (const key of Object.keys(current)) {
		if (!Object.prototype.hasOwnProperty.call(intended, key)) {
			changes.push({ path: [...path, key], value: undefined });
		}
	}
	for (const key of Object.keys(intended)) {
		if (!Object.prototype.hasOwnProperty.call(current, key)) {
			changes.push({ path: [...path, key], value: Reflect.get(intended, key) });
			continue;
		}
		collectChanges(Reflect.get(current, key), Reflect.get(intended, key), [...path, key], changes);
	}
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) => jsonValuesEqual(value, right[index]))
		);
	}
	if (!isJsonObject(left) || !isJsonObject(right)) {
		return false;
	}
	const leftKeys = Object.keys(left);
	const rightKeys = Object.keys(right);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			(key) =>
				Object.prototype.hasOwnProperty.call(right, key) &&
				jsonValuesEqual(Reflect.get(left, key), Reflect.get(right, key)),
		)
	);
}

function isJsonObject(value: unknown): value is object {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDuplicatePaths(root: Node | undefined): JSONPath[] {
	const duplicates: JSONPath[] = [];
	if (root !== undefined) {
		visitNode(root, [], duplicates);
	}
	return duplicates;
}

function visitNode(node: Node, path: JSONPath, duplicates: JSONPath[]): void {
	if (node.type === "object") {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const keyNode = property.children?.[0];
			const valueNode = property.children?.[1];
			if (keyNode === undefined || valueNode === undefined || typeof keyNode.value !== "string") {
				continue;
			}
			const propertyPath = [...path, keyNode.value];
			if (keys.has(keyNode.value)) {
				duplicates.push(propertyPath);
			} else {
				keys.add(keyNode.value);
			}
			visitNode(valueNode, propertyPath, duplicates);
		}
		return;
	}
	if (node.type === "array") {
		for (const [index, child] of (node.children ?? []).entries()) {
			visitNode(child, [...path, index], duplicates);
		}
	}
}

function pathsOverlap(left: JSONPath, right: JSONPath): boolean {
	const sharedLength = Math.min(left.length, right.length);
	for (let index = 0; index < sharedLength; index++) {
		if (left[index] !== right[index]) {
			return false;
		}
	}
	return true;
}

function formatPath(path: JSONPath): string {
	return path.length === 0 ? "<root>" : path.map(String).join(".");
}

function inferFormattingOptions(text: string, root: Node | undefined): FormattingOptions {
	const indentation = root === undefined ? [] : collectPropertyIndentation(text, root);
	const shallowest = indentation.reduce<string | undefined>((best, candidate) => {
		if (candidate.length === 0) return best;
		return best === undefined || candidate.length < best.length ? candidate : best;
	}, undefined);

	if (shallowest?.includes("\t")) {
		return { insertSpaces: false, tabSize: 1, eol: inferEol(text) };
	}

	const spaceCounts = indentation
		.filter((value) => value.length > 0 && !value.includes("\t"))
		.map((value) => value.length);
	const tabSize = spaceCounts.reduce(greatestCommonDivisor, 0) || 2;
	return { insertSpaces: true, tabSize, eol: inferEol(text) };
}

function collectPropertyIndentation(text: string, root: Node): string[] {
	const result: string[] = [];
	const visit = (node: Node): void => {
		if (node.type === "property") {
			const lineStart =
				Math.max(text.lastIndexOf("\n", node.offset - 1), text.lastIndexOf("\r", node.offset - 1)) +
				1;
			const prefix = text.slice(lineStart, node.offset);
			if (/^[\t ]*$/.test(prefix)) {
				result.push(prefix);
			}
		}
		for (const child of node.children ?? []) {
			visit(child);
		}
	};
	visit(root);
	return result;
}

function greatestCommonDivisor(left: number, right: number): number {
	let a = left;
	let b = right;
	while (b !== 0) {
		const remainder = a % b;
		a = b;
		b = remainder;
	}
	return a;
}

function inferEol(text: string): string {
	if (text.includes("\r\n")) return "\r\n";
	if (text.includes("\r")) return "\r";
	return "\n";
}
