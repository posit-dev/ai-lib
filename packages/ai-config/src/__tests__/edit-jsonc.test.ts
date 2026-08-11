/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { parse } from "jsonc-parser";
import { describe, expect, it } from "vitest";

import { editJsonc, normalizeJsonValue } from "../edit-jsonc.js";

describe("editJsonc", () => {
	it("preserves comments and formatting outside multiple sibling edits", () => {
		const original = `{
  // keep this root comment
  "keep": {
    /* keep this nested comment */
    "value": 1,
  },
  "removeOne": true,
  "removeTwo": false,
}`;

		const edited = editJsonc(original, {
			keep: { value: 2, nested: { enabled: true } },
			addOne: "one",
			addTwo: "two",
		});

		expect(parse(edited)).toEqual({
			keep: { value: 2, nested: { enabled: true } },
			addOne: "one",
			addTwo: "two",
		});
		expect(edited).toContain("// keep this root comment");
		expect(edited).toContain("/* keep this nested comment */");
		expect(edited).not.toContain("removeOne");
		expect(edited).not.toContain("removeTwo");
	});

	it("preserves the next sibling's leading comment when deleting the first property", () => {
		const original = `{
  "remove": true, // explain keep
  "keep": true
}`;

		const edited = editJsonc(original, { keep: true });

		expect(parse(edited)).toEqual({ keep: true });
		expect(edited).toContain("// explain keep");
	});

	it("preserves an object header comment when deleting the first property", () => {
		const original = `{
  // provider settings
  "remove": true,
  "keep": true
}`;

		const edited = editJsonc(original, { keep: true });

		expect(parse(edited)).toEqual({ keep: true });
		expect(edited).toContain("// provider settings");
		expect(edited.indexOf("// provider settings")).toBeLessThan(edited.indexOf('"keep"'));
	});

	it("keeps a trailing sibling comment before an appended property", () => {
		const original = '{\r\n   "existing": true // explains existing\r\n}\r\n';

		const edited = editJsonc(original, { existing: true, added: { nested: 1 } });

		expect(parse(edited)).toEqual({ existing: true, added: { nested: 1 } });
		expect(edited.indexOf("// explains existing")).toBeLessThan(edited.indexOf('"added"'));
		expect(edited).toContain('"existing": true, // explains existing');
		expect(edited).toContain('\r\n   "added": {\r\n      "nested": 1\r\n   }');
		expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
	});

	it("preserves a trailing comma while keeping its comment before an appended property", () => {
		const original = `{
  "existing": true, // explains existing
}`;

		const edited = editJsonc(original, { existing: true, added: 1 });

		expect(parse(edited)).toEqual({ existing: true, added: 1 });
		expect(edited).toContain('"existing": true, // explains existing');
		expect(edited).toContain('"added": 1,');
	});

	it("keeps an empty object's header comment before its first property", () => {
		const original = `{
  // settings added below
}`;

		const edited = editJsonc(original, { added: true });

		expect(parse(edited)).toEqual({ added: true });
		expect(edited.indexOf("// settings added below")).toBeLessThan(edited.indexOf('"added"'));
	});

	it("replaces arrays as one changed subtree", () => {
		const original = `{
  "models": [
    // this belongs to the replaced array
    "old"
  ],
  // this comment is outside the replacement
  "keep": true
}`;
		const edited = editJsonc(original, { models: ["new", "newer"], keep: true });

		expect(parse(edited)).toEqual({ models: ["new", "newer"], keep: true });
		expect(edited).toContain("// this comment is outside the replacement");
	});

	it("returns the original bytes for a value-identical result", () => {
		const original = '{\r\n\t// untouched\r\n\t"value": 1,\r\n}\r\n';
		expect(editJsonc(original, { value: 1 })).toBe(original);
	});

	it("infers CRLF and unusual space indentation for inserted values", () => {
		const original = '{\r\n   "existing": true\r\n}\r\n';
		const edited = editJsonc(original, { existing: true, added: { nested: 1 } });

		expect(edited).toContain('\r\n   "added": {\r\n      "nested": 1\r\n   }');
		expect(edited.replaceAll("\r\n", "")).not.toContain("\n");
	});

	it("infers tab indentation", () => {
		const original = '{\n\t"existing": true\n}\n';
		const edited = editJsonc(original, { existing: true, added: { nested: 1 } });

		expect(edited).toContain('\n\t"added": {\n\t\t"nested": 1\n\t}');
	});

	it("edits the round-trip-normalized intended value", () => {
		const edited = editJsonc("{}", {
			keep: true,
			omit: undefined,
			array: [undefined, Number.NaN, Infinity],
			wrapped: {
				toJSON() {
					return { persisted: true };
				},
			},
		});

		expect(parse(edited)).toEqual({
			keep: true,
			array: [null, null, null],
			wrapped: { persisted: true },
		});
	});

	it("rejects a change through an ambiguously duplicated path", () => {
		const original = `{
  "provider": { "enabled": true },
  "provider": { "enabled": false }
}`;

		expect(() => editJsonc(original, { provider: { enabled: true } })).toThrow(
			/duplicate key path provider is ambiguous/,
		);
	});

	it("allows changes unrelated to a duplicated path", () => {
		const original = `{
  "duplicate": 1,
  "duplicate": 2,
  "safe": false
}`;
		const edited = editJsonc(original, { duplicate: 2, safe: true });

		expect(edited.match(/"duplicate"/g)).toHaveLength(2);
		expect(edited).toContain('"safe": true');
	});

	it("rejects replacing an ancestor containing a duplicate path", () => {
		const original = `{
  "outer": {
    "duplicate": 1,
    "duplicate": 2
  }
}`;

		expect(() => editJsonc(original, { outer: null })).toThrow(
			/duplicate key path outer\.duplicate is ambiguous/,
		);
	});
});

describe("normalizeJsonValue", () => {
	it("matches JSON.stringify omission and null substitution semantics", () => {
		const value = {
			keep: true,
			omitUndefined: undefined,
			omitFunction: () => true,
			omitSymbol: Symbol("omit"),
			array: [undefined, () => true, Symbol("null"), Number.NaN, Infinity, -Infinity],
		};

		expect(normalizeJsonValue(value)).toEqual({
			keep: true,
			array: [null, null, null, null, null, null],
		});
	});

	it("honors toJSON", () => {
		const value = {
			wrapped: {
				ignored: true,
				toJSON() {
					return { persisted: "yes" };
				},
			},
		};

		expect(normalizeJsonValue(value)).toEqual({ wrapped: { persisted: "yes" } });
	});

	it("throws for BigInt and cyclic values", () => {
		expect(() => normalizeJsonValue({ value: 1n })).toThrow(TypeError);

		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => normalizeJsonValue(cyclic)).toThrow(TypeError);
	});
});
