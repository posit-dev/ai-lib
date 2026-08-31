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
	createScanner,
	findNodeAtLocation,
	getNodeValue,
	modify,
	parseTree,
	printParseErrorCode,
	type FormattingOptions,
	type JSONPath,
	type Node,
	type ParseError,
	SyntaxKind,
} from "jsonc-parser";

import { isPlainObject } from "./is-plain-object.js";

interface JsoncChange {
	path: JSONPath;
	value: unknown;
}

interface NextSiblingLeadingTrivia {
	parentPath: JSONPath;
	siblingKey: string;
	text: string;
}

interface AppendedPropertyTrivia {
	parentPath: JSONPath;
	propertyKey: string;
	previousKey: string | undefined;
	text: string;
	propertyIndent: string;
	closingIndent: string;
	hadTrailingComma: boolean;
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
		const currentRoot = parseJsoncTree(editedText).root;
		const nextSiblingTrivia =
			change.value === undefined
				? captureNextSiblingLeadingTrivia(editedText, currentRoot, change.path)
				: undefined;
		const appendedPropertyTrivia =
			change.value !== undefined
				? captureAppendedPropertyTrivia(editedText, currentRoot, change.path, formattingOptions)
				: undefined;
		const edits = modify(editedText, change.path, change.value, { formattingOptions });
		editedText = applyEdits(editedText, edits);
		if (nextSiblingTrivia !== undefined) {
			editedText = restoreNextSiblingLeadingTrivia(editedText, nextSiblingTrivia);
		}
		if (appendedPropertyTrivia !== undefined) {
			editedText = restoreAppendedPropertyTrivia(
				editedText,
				appendedPropertyTrivia,
				formattingOptions,
			);
		}
	}

	const editedValue = parseJsoncTree(editedText).value;
	if (!jsonValuesEqual(editedValue, normalizedValue)) {
		throw new Error("JSONC edit did not produce the intended JSON value");
	}

	return editedText;
}

/**
 * jsonc-parser removes through the next property's offset when deleting the
 * first property in an object. Preserve the trivia after the separating comma,
 * plus any comment-bearing header before the removed property.
 */
function captureNextSiblingLeadingTrivia(
	text: string,
	root: Node | undefined,
	path: JSONPath,
): NextSiblingLeadingTrivia | undefined {
	const propertyKey = path[path.length - 1];
	if (root === undefined || typeof propertyKey !== "string") {
		return undefined;
	}

	const parentPath = path.slice(0, -1);
	const parent = findNodeAtLocation(root, parentPath);
	if (parent?.type !== "object" || parent.children === undefined) {
		return undefined;
	}

	const property = parent.children[0];
	const nextSibling = parent.children[1];
	if (
		property === undefined ||
		nextSibling === undefined ||
		property.children?.[0]?.value !== propertyKey ||
		typeof nextSibling.children?.[0]?.value !== "string"
	) {
		return undefined;
	}

	const scanner = createScanner(text, false);
	scanner.setPosition(property.offset + property.length);
	for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
		const tokenOffset = scanner.getTokenOffset();
		if (tokenOffset >= nextSibling.offset) {
			return undefined;
		}
		if (token === SyntaxKind.CommaToken) {
			const triviaStart = tokenOffset + scanner.getTokenLength();
			const leadingTrivia = text.slice(parent.offset + 1, property.offset);
			const siblingTrivia = text.slice(triviaStart, nextSibling.offset);
			return {
				parentPath,
				siblingKey: nextSibling.children[0].value,
				text: hasComment(leadingTrivia)
					? mergeLeadingTrivia(leadingTrivia, siblingTrivia, inferEol(text))
					: siblingTrivia,
			};
		}
	}

	return undefined;
}

function restoreNextSiblingLeadingTrivia(
	text: string,
	preserved: NextSiblingLeadingTrivia,
): string {
	const { root } = parseJsoncTree(text);
	const parent = root === undefined ? undefined : findNodeAtLocation(root, preserved.parentPath);
	if (parent?.type !== "object") {
		throw new Error("JSONC deletion did not retain the expected parent object");
	}
	const nextSibling = parent.children?.[0];
	if (nextSibling?.children?.[0]?.value !== preserved.siblingKey) {
		throw new Error("JSONC deletion did not retain the expected next sibling");
	}

	const triviaStart = parent.offset + 1;
	return applyEdits(text, [
		{
			offset: triviaStart,
			length: nextSibling.offset - triviaStart,
			content: preserved.text,
		},
	]);
}

function mergeLeadingTrivia(leading: string, sibling: string, eol: string): string {
	const leadingWithoutIndent = leading.replace(/[\t ]+$/, "");
	const separator =
		leadingWithoutIndent.endsWith("\n") || leadingWithoutIndent.endsWith("\r") ? "" : eol;
	const siblingIndent = sibling.match(/[\t ]*$/)?.[0] ?? "";
	const siblingComment = hasComment(sibling) ? sibling.trimStart() : "";
	return leadingWithoutIndent + separator + siblingIndent + siblingComment;
}

/**
 * jsonc-parser inserts an appended property at the previous property's AST
 * end, before any trailing comment. Capture comment-bearing trailing trivia so
 * it can remain with the existing object content instead of moving to the new
 * property. Empty objects need the same treatment for header comments.
 */
function captureAppendedPropertyTrivia(
	text: string,
	root: Node | undefined,
	path: JSONPath,
	formattingOptions: FormattingOptions,
): AppendedPropertyTrivia | undefined {
	const propertyKey = path[path.length - 1];
	if (root === undefined || typeof propertyKey !== "string") {
		return undefined;
	}

	const parentPath = path.slice(0, -1);
	const parent = findNodeAtLocation(root, parentPath);
	if (parent?.type !== "object" || findNodeAtLocation(parent, [propertyKey]) !== undefined) {
		return undefined;
	}

	const previous = parent.children?.at(-1);
	const triviaStart =
		previous === undefined ? parent.offset + 1 : previous.offset + previous.length;
	const closingOffset = parent.offset + parent.length - 1;
	const trivia = text.slice(triviaStart, closingOffset);
	if (!hasComment(trivia)) {
		return undefined;
	}

	const previousKey = previous?.children?.[0]?.value;
	if (previousKey !== undefined && typeof previousKey !== "string") {
		return undefined;
	}
	const { body, closingIndent } = splitClosingIndent(trivia, lineIndentAt(text, parent.offset));
	const propertyIndent =
		(previous === undefined ? undefined : lineIndentAt(text, previous.offset)) ||
		closingIndent + indentUnit(formattingOptions);

	return {
		parentPath,
		propertyKey,
		previousKey,
		text: body,
		propertyIndent,
		closingIndent,
		hadTrailingComma: containsToken(trivia, SyntaxKind.CommaToken),
	};
}

function restoreAppendedPropertyTrivia(
	text: string,
	preserved: AppendedPropertyTrivia,
	formattingOptions: FormattingOptions,
): string {
	const { root } = parseJsoncTree(text);
	const parent = root === undefined ? undefined : findNodeAtLocation(root, preserved.parentPath);
	const property =
		parent === undefined ? undefined : findNodeAtLocation(parent, [preserved.propertyKey]);
	if (parent?.type !== "object" || property?.parent?.type !== "property") {
		throw new Error("JSONC addition did not retain the expected object property");
	}

	const propertyText = text.slice(
		property.parent.offset,
		property.parent.offset + property.parent.length,
	);
	const eol = formattingOptions.eol ?? "\n";
	const triviaBeforeProperty =
		preserved.text.endsWith("\n") || preserved.text.endsWith("\r")
			? preserved.text
			: preserved.text + eol;
	const trailingComma = preserved.hadTrailingComma ? "," : "";
	const replacement = `${preserved.previousKey === undefined || preserved.hadTrailingComma ? "" : ","}${triviaBeforeProperty}${preserved.propertyIndent}${propertyText}${trailingComma}${eol}${preserved.closingIndent}`;

	const rangeStart =
		preserved.previousKey === undefined
			? parent.offset + 1
			: (() => {
					const previous = findNodeAtLocation(parent, [preserved.previousKey]);
					if (previous?.parent?.type !== "property") {
						throw new Error("JSONC addition did not retain the expected previous sibling");
					}
					return previous.parent.offset + previous.parent.length;
				})();
	const closingOffset = parent.offset + parent.length - 1;
	return applyEdits(text, [
		{
			offset: rangeStart,
			length: closingOffset - rangeStart,
			content: replacement,
		},
	]);
}

function splitClosingIndent(
	text: string,
	fallback: string,
): { body: string; closingIndent: string } {
	const lineBreak = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
	if (lineBreak === -1) {
		return { body: text, closingIndent: fallback };
	}
	const closingIndent = text.slice(lineBreak + 1);
	return /^[\t ]*$/.test(closingIndent)
		? { body: text.slice(0, lineBreak + 1), closingIndent }
		: { body: text, closingIndent: fallback };
}

function lineIndentAt(text: string, offset: number): string {
	const lineStart =
		Math.max(text.lastIndexOf("\n", offset - 1), text.lastIndexOf("\r", offset - 1)) + 1;
	const prefix = text.slice(lineStart, offset);
	return /^[\t ]*$/.test(prefix) ? prefix : "";
}

function indentUnit(options: FormattingOptions): string {
	return options.insertSpaces === false ? "\t" : " ".repeat(options.tabSize ?? 2);
}

function hasComment(text: string): boolean {
	return (
		containsToken(text, SyntaxKind.LineCommentTrivia) ||
		containsToken(text, SyntaxKind.BlockCommentTrivia)
	);
}

function containsToken(text: string, expected: SyntaxKind): boolean {
	const scanner = createScanner(text, false);
	for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
		if (token === expected) return true;
	}
	return false;
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

	if (!isPlainObject(current) || !isPlainObject(intended)) {
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
	if (!isPlainObject(left) || !isPlainObject(right)) {
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
