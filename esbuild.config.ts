import { rmSync } from 'node:fs';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
rmSync('tsconfig.tsbuildinfo', { force: true });

const entrypoints = [
	'src/index.ts',
	'src/providers.ts',
	'src/providers-external.ts',
	'src/positron/index.ts',
];

await build({
	entryPoints: entrypoints,
	bundle: true,
	format: 'esm',
	outdir: 'dist',
	// Runs in Electron (Node available at runtime). Keep Node builtins and vscode external.
	external: ['vscode'],
	platform: 'node',
	target: 'es2022',
	sourcemap: true,
	splitting: true,
});
