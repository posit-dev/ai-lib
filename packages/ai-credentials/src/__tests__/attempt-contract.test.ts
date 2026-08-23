/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import type { AuthenticationChallenge, AuthenticationStartResult } from "../CredentialProvider";

/**
 * Contract coverage for the attempt-start result variants that the
 * AcquisitionEngine itself does not produce: `unavailable` (no attempt
 * created; produced by host services when a provider cannot be authenticated
 * in the current environment) and the `external-browser` challenge (an
 * external process owns the browser flow).
 */
describe("authentication attempt contract", () => {
	it("distinguishes unavailable from started and already-in-progress", () => {
		const unavailable: AuthenticationStartResult = {
			status: "unavailable",
			reason: "aws_cli_missing",
		};
		const inProgress: AuthenticationStartResult = { status: "already-in-progress" };

		if (unavailable.status === "unavailable") {
			expect(unavailable.reason).toBe("aws_cli_missing");
		} else {
			expect.unreachable("unavailable result must narrow on status");
		}
		expect(inProgress.status).toBe("already-in-progress");
		expect("reason" in inProgress).toBe(false);
	});

	it("carries an external-browser challenge with optional url", () => {
		const withUrl: AuthenticationChallenge = {
			kind: "external-browser",
			attemptId: "attempt-1",
			url: "https://example.com/login",
			instructions: "Complete the login in your browser.",
			expiresIn: 600,
		};
		const withoutUrl: AuthenticationChallenge = {
			kind: "external-browser",
			attemptId: "attempt-2",
			instructions: "Complete the login in the browser opened by gcloud.",
			expiresIn: 600,
		};

		const started: AuthenticationStartResult = { status: "started", challenge: withUrl };
		if (started.status === "started" && started.challenge.kind === "external-browser") {
			expect(started.challenge.url).toBe("https://example.com/login");
			expect(started.challenge.instructions).toContain("browser");
		} else {
			expect.unreachable("started result must expose the external-browser challenge");
		}
		expect(withoutUrl.url).toBeUndefined();
		expect(withoutUrl.attemptId).toBe("attempt-2");
	});
});
