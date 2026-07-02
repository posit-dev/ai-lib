# ai-lib

A small monorepo of platform-neutral packages that provide the LLM provider infrastructure for [Posit Assistant](https://github.com/posit-dev/assistant). It is an npm-workspaces repo (GitHub: `posit-dev/ai-provider-bridge`) consumed as a **git submodule** by the Posit Assistant monorepo, where each package is built from source as a workspace rather than installed from a registry.

## Packages

| Package                                             | Description                                                                                                              |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [`ai-provider-bridge`](packages/ai-provider-bridge) | LLM provider infra: plugin registry, model clients (14 providers), credential abstractions, and a Positron VS Code layer |
| [`ai-config`](packages/ai-config)                   | `~/.posit/genai/providers.json` schema, validation, defaults, and the load → enforce → build → watch resolution pipeline |
| [`ai-credentials`](packages/ai-credentials)         | Credential types, shaping, and generic typed single-file KV store (atomic writes, cross-process locking, file watching)  |

## Dependency graph

```
ai-config ──► ai-provider-bridge ◄── ai-credentials
                    ▲
        (host applications depend on these packages, never the reverse)
```

- `ai-provider-bridge` depends on `ai-config` and `ai-credentials` (`"ai-config": "*"`, `"ai-credentials": "*"`), so both build first.
- `ai-config` and `ai-credentials` are standalone leaves — neither depends on a sibling.
- `ai-config` and `ai-provider-bridge` share a vocabulary (provider IDs, protocols, client kinds) **without importing each other** — a compile-time [shape guard](typechecks) keeps them compatible.

## Repository layout

```
ai-lib/
├── packages/
│   ├── ai-provider-bridge/   # LLM provider infra (esbuild-bundled; vscode peer dep)
│   ├── ai-config/            # providers.json schema + resolution pipeline (zod)
│   └── ai-credentials/       # credential types + shaping + generic KV store
├── typechecks/               # cross-package compile-time shape guards
├── memory-bank/              # repo-wide architectural documentation
├── .github/workflows/        # ci.yml, release.yml
└── tsconfig.base.json        # shared compiler options
```

## Getting started

```bash
npm install            # install all workspaces
npm run build          # build all packages (ai-config builds before ai-provider-bridge)
npm run check-types    # per-package tsc --noEmit + the cross-package shape guard
npm run test           # vitest across all packages
npm run lint           # lint across packages
npm run format         # oxfmt (format:check to verify)
```

Target a single workspace with `-w`, e.g. `npm run build -w ai-provider-bridge`, `npm test -w ai-config`.

## Shape guard

`typechecks/shape-guard.typecheck.ts` holds compile-time-only assertions (type-checked, never emitted) that keep `ai-config`'s vocabulary compatible with `ai-provider-bridge` without an import edge: matching provider IDs, model-override fields ⊆ `ModelInfo`, and compatible protocol/client-kind enums. It runs as part of the root `npm run check-types`. See [`typechecks/README.md`](typechecks/README.md).

## Releasing

`ai-provider-bridge` is published as a tag-driven GitHub Release tarball: pushing a `v*` tag triggers `.github/workflows/release.yml`, which builds and `npm pack`s the bridge and attaches the `.tgz`. `ai-config` and `ai-credentials` are consumed via the submodule/workspace, not released as tarballs. See [`CLAUDE.md`](CLAUDE.md) for the full release procedure.

## Documentation

Per-package architecture docs live in [`memory-bank/`](memory-bank); each file's `package` frontmatter field names which package it covers. Agent-facing guidance is in [`CLAUDE.md`](CLAUDE.md) (symlinked as `AGENTS.md`).
