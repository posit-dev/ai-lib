/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { sha256Hex } from "../sha256";

// Reference vectors from NIST / RFC 6234; the hash must stay exact because it
// keys the request-coalescer's identity map.
describe("sha256Hex", () => {
	it("hashes the empty string", () => {
		expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
	});

	it("hashes a short message", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
	});

	it("hashes a two-block message", () => {
		expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
			"248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
		);
	});

	it("encodes non-ASCII input as UTF-8", () => {
		// Cross-checked against `node:crypto` createHash("sha256").
		expect(sha256Hex("authorization: Bearer sk-üñïçødé-🔑")).toBe(
			"45c9ad8bf57a2f7588019d3e69d3f8054b9faadc2543a9aa282bf3a8fd8dd8a6",
		);
	});
});
