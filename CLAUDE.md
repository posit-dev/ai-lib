# ai-provider-bridge

Platform-neutral provider infrastructure for AI model access in Posit Assistant. Provides a plugin registry, model clients for 14 LLM providers, credential abstractions, and a Positron VS Code integration layer.

## Project Structure

```
ai-provider-bridge/
├── src/
│   ├── model-clients/       # ModelClient implementations (one per provider)
│   ├── model-capabilities/  # Per-provider capability inference helpers
│   ├── providers/           # register*Provider() modules + ProviderRegistry class
│   ├── positron/            # VS Code integration (/positron entrypoint)
│   ├── types.ts             # PROVIDER_IDS, credential types, ProviderId
│   ├── provider-map.ts      # PROVIDER_MAP (provider ID -> Positron auth config)
│   ├── local-providers.ts   # LocalProviderManager (Ollama, LM Studio)
│   ├── custom-headers.ts    # Header merging/filtering for customHeaders
│   └── index.ts             # Root entrypoint exports
├── memory-bank/             # Architectural documentation
├── docs/                    # HTML explainer
└── dist/                    # Build output (gitignored)
```

## Key Constraints

- Root entrypoint must NOT import `vscode` -- only `/positron` may
- This package must NOT depend on any consumer package -- the dependency arrow is one-way inward
- External builds alias `providers.ts`, `types.ts`, and `local-providers.ts` to `-external` variants (positai only)

## Development

```bash
npm install
npm run build           # esbuild + declaration emit
npm run check-types     # tsc --noEmit
npm run test            # vitest
npm run test:watch      # vitest watch mode
```

## Memory Bank

The `memory-bank/` directory contains architectural documentation. Read relevant documents before making significant changes:

- `./memory-bank/architecture.md` -- Package architecture, entrypoints, invariants, code layout, credential system
- `./memory-bank/providerGuide.md` -- Step-by-step guide for adding new providers
