/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Launches the user's globally-installed `copilot` CLI in headless mode and
 * returns the listening port plus a dispose handle. Callers then connect via
 * `new CopilotClient({ cliUrl: "localhost:<port>" })`.
 *
 * We deliberately rely on the `copilot` binary on PATH rather than bundling
 * @github/copilot ourselves. Rationale:
 *
 * 1. The upstream CLI pulls in `node:sqlite`, which requires Node ≥ 22.5 (as
 *    an --experimental-sqlite flag) and ≥ 24 (stable). Shipping our own copy
 *    would force every Positron user onto a specific Node toolchain.
 * 2. A user-installed `copilot` ran successfully on their machine at install
 *    time — the Node compatibility problem is theirs to resolve once, not
 *    ours to police on every spawn.
 * 3. Letting @github/copilot-sdk do its own spawn isn't viable: inside a
 *    VS Code / Positron extension host, `process.execPath` is the Electron
 *    helper binary, and the CLI's commander parser errors with "too many
 *    arguments. Expected 0 arguments but got 1." under that helper even with
 *    ELECTRON_RUN_AS_NODE=1. An external `copilot` binary sidesteps this.
 *
 * The argv mirrors the SDK's own `startCLIServer()` (client.js) so the server
 * authenticates the same way: a caller-supplied token is passed via a named
 * env var (`--auth-token-env`), never as a CLI argument.
 */

import { spawn } from "node:child_process";

export interface CopilotCliServer {
	/** Port the CLI is listening on */
	port: number;
	/** Stop the child process. Resolves when it exits or a short grace window expires. */
	dispose: () => Promise<void>;
}

const PORT_LINE = /listening on port (\d+)/i;
const DISPOSE_GRACE_MS = 3000;
const AUTH_TOKEN_ENV = "COPILOT_SDK_AUTH_TOKEN";

// Windows needs the .cmd shim for npm-global bin entries; spawn() otherwise
// fails with ENOENT. macOS/Linux resolve "copilot" directly.
const COPILOT_BIN = process.platform === "win32" ? "copilot.cmd" : "copilot";

export async function startCopilotCliServer(
	githubToken: string | undefined,
): Promise<CopilotCliServer> {
	// NODE_DEBUG can break child bootstrapping; strip it as the SDK does.
	const env: NodeJS.ProcessEnv = { ...process.env };
	delete env.NODE_DEBUG;

	const args = ["--headless", "--no-auto-update", "--log-level", "warning", "--port", "0"];
	if (githubToken) {
		// The CLI reads the token from the env var whose name is given here,
		// rather than from the argv (so it never appears in ps output).
		// Pair with --no-auto-login so the CLI never prompts interactively.
		args.push("--auth-token-env", AUTH_TOKEN_ENV, "--no-auto-login");
		env[AUTH_TOKEN_ENV] = githubToken;
	}
	// No token → omit --no-auto-login so the CLI picks up the stored
	// `gh`-authenticated user (mirrors the SDK's useLoggedInUser default).

	const child = spawn(COPILOT_BIN, args, {
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});

	const dispose = (): Promise<void> =>
		new Promise((resolve) => {
			if (child.exitCode !== null || child.signalCode !== null) {
				resolve();
				return;
			}
			const onExit = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(() => {
				child.off("exit", onExit);
				resolve();
			}, DISPOSE_GRACE_MS);
			child.once("exit", onExit);
			try {
				child.kill();
			} catch {
				/* already exiting */
			}
		});

	return new Promise<CopilotCliServer>((resolve, reject) => {
		let stdoutBuf = "";
		let stderrBuf = "";
		let settled = false;

		child.stdout?.on("data", (data) => {
			stdoutBuf += data.toString();
			const match = stdoutBuf.match(PORT_LINE);
			if (match && !settled) {
				settled = true;
				resolve({ port: parseInt(match[1], 10), dispose });
			}
		});
		child.stderr?.on("data", (data) => {
			stderrBuf += data.toString();
		});
		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			const hint =
				(err as NodeJS.ErrnoException).code === "ENOENT"
					? ` — is the 'copilot' CLI installed and on PATH? See https://docs.github.com/copilot/concepts/agents/about-copilot-cli`
					: "";
			reject(new Error(`Failed to launch copilot CLI: ${err.message}${hint}`));
		});
		child.on("exit", (code) => {
			if (settled) return;
			settled = true;
			const detail = stderrBuf.trim() ? `\nstderr: ${stderrBuf.trim()}` : "";
			reject(new Error(`Copilot CLI exited with code ${code} before reporting port${detail}`));
		});
	});
}
