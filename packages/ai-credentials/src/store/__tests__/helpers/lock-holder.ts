#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Helper script for cross-process lock contention tests.
 *
 * Acquires a lock on the store file, signals readiness via IPC, waits for a
 * release signal, then exits. Used by the parent test to verify that
 * `withLock` retries and eventually acquires after the child releases.
 */

import { SingleFileStore } from "../../SingleFileStore";

const filePath = process.argv[2];
if (!filePath) {
	console.error("Usage: lock-holder.ts <filePath>");
	process.exit(1);
}

const store = new SingleFileStore({ filePath });

async function main() {
	await store.withLock(async () => {
		// Signal the parent that we hold the lock
		process.send?.("lock-acquired");

		// Wait for the parent to tell us to release
		await new Promise<void>((resolve) => {
			process.on("message", (msg) => {
				if (msg === "release") {
					resolve();
				}
			});
		});
	});

	// Signal that we've released the lock
	process.send?.("lock-released");
}

main().catch((error) => {
	console.error("lock-holder error:", error);
	process.exit(1);
});
