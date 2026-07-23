/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

// Child fixture for the death-pipe tests: arms the real death-pipe against this
// process's real stdin, then simulates a fixed amount of the coordinator's
// ref'd "work" so the process stays alive long enough to observe a launcher
// death. After that work completes, the only remaining handle is the armed
// stdin listener — which is unref'd — so the process must exit on its own
// (the inertness property the tests assert).

import { writeFileSync } from "node:fs";

import { armLauncherDeathPipe } from "../../scripts/build-coordinator";

// Path passed by the launcher-death regression only. The child writes it from
// its asynchronous cleanup so the parent can prove cleanup ran to completion
// even though it has torn down the child's stdout.
const cleanupMarkerPath = process.argv[2];

armLauncherDeathPipe(() => {
	// Simulate in-flight coordinator output during the launcher-loss shutdown.
	// After a launcher death the pipe's reader is gone, so these writes hit a
	// broken pipe; the coordinator's EPIPE guard must swallow them so the
	// asynchronous cleanup below still runs to completion.
	for (let index = 0; index < 50; index += 1) {
		process.stdout.write(`launcher-gone ${index}\n`);
	}
	if (cleanupMarkerPath) {
		setTimeout(() => {
			writeFileSync(cleanupMarkerPath, "cleanup-done");
			process.exit(0);
		}, 200);
	} else {
		process.exit(0);
	}
});

// Finite ref'd work standing in for the coordinator's build loop.
setTimeout(() => {}, 1500);

process.stdout.write("ready\n");
