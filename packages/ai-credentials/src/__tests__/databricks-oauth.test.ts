/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { normalizeDatabricksWorkspaceHost } from "../databricks-oauth";

describe("Databricks OAuth workspace validation", () => {
	it("normalizes secure workspace hosts", () => {
		expect(normalizeDatabricksWorkspaceHost("workspace.example.com/path?q=1")).toBe(
			"https://workspace.example.com",
		);
	});

	it.each(["http://workspace.example.com", "http://localhost:8080", "http://127.0.0.1:8080"])(
		"rejects insecure production workspace URL %s",
		(workspaceHost) => {
			expect(() => normalizeDatabricksWorkspaceHost(workspaceHost)).toThrow(
				"Databricks workspace URL must use HTTPS",
			);
		},
	);
});
