import { rmSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { build } from 'esbuild';

rmSync('dist', { recursive: true, force: true });
rmSync('tsconfig.tsbuildinfo', { force: true });

const entrypoints = [
	'src/index.ts',
	'src/local-providers.ts',
	'src/local-providers-external.ts',
	'src/types.ts',
	'src/types-external.ts',
	'src/providers.ts',
	'src/providers-external.ts',
	'src/positron/index.ts',
];

const peerDeps = [
	'@ai-sdk/amazon-bedrock',
	'@ai-sdk/anthropic',
	'@ai-sdk/deepseek',
	'@ai-sdk/google',
	'@ai-sdk/google-vertex',
	'@ai-sdk/openai',
	'@ai-sdk/openai-compatible',
	'@aws-sdk/client-bedrock',
	'@aws-sdk/credential-providers',
	'@github/copilot-sdk',
	'@openrouter/ai-sdk-provider',
	'ai',
	'ai-sdk-ollama',
	'google-auth-library',
	'vscode',
];

const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

await build({
	entryPoints: entrypoints,
	bundle: true,
	format: 'esm',
	outdir: 'dist',
	external: [...peerDeps, ...nodeBuiltins],
	platform: 'node',
	target: 'es2022',
	sourcemap: true,
	splitting: true,
});
