# ai-provider-bridge

Platform-neutral provider infrastructure for AI model access: registry, model clients, credential abstractions, and provider registration functions, with no dependency on VS Code or Node platform services.

This package is one of three in the [`ai-lib`](../../README.md) monorepo. It depends on its sibling [`ai-config`](../ai-config) for shared vocabulary types (`ResolvedProviderId`, `ClientKind`); the two are kept in sync by a compile-time [shape guard](../../typechecks) rather than a runtime import. It does not depend on `ai-credential-store`.

## Package Boundaries

These rules keep the dependency graph clean:

- **Root entrypoint must not import `vscode`** -- only the `/positron` entrypoint may.
- **Must not import from consumer packages** -- host applications depend on this package, not the reverse.

## Entrypoints

| Entrypoint                              | What it provides                                                                                                                                     | Heavy deps?           |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `ai-provider-bridge`                    | `ProviderRegistry`, interfaces (`ModelClient`, `CredentialProvider`, `StepLogger`), `createCachedModelFetcher`, provider map, `LocalProviderManager` | No                    |
| `ai-provider-bridge/providers`          | `register*Provider()` functions, client classes, helpers                                                                                             | Yes (AI SDK packages) |
| `ai-provider-bridge/providers-external` | Minimal provider set (external/OSS builds -- Posit AI only)                                                                                          | Minimal               |
| `ai-provider-bridge/positron`           | `PositronCredentialProvider`, `VscodeLmClient`, `listVscodeLmModels()`, `fromAiMessages2()`, LM helpers                                              | Yes (`vscode`)        |
| `ai-provider-bridge/credential-shaping` | Pure `shapeCredentials()` + `CredentialConfig` + `CONFIG_KEY_OVERRIDES` -- browser-safe (no `vscode`, AI SDK, or node builtins)                      | No                    |

`./types` and `./local-providers` are also exposed as granular subpath exports (for consumers that want just those modules without pulling the root entrypoint).

## Supported Providers

| Provider          | Client             | Model Discovery |
| ----------------- | ------------------ | --------------- |
| Anthropic         | AnthropicClient    | Cached via API  |
| OpenAI            | OpenAIClient       | Cached via API  |
| AWS Bedrock       | BedrockClient      | Cached via API  |
| Google Gemini     | GeminiClient       | Cached via API  |
| Google Vertex AI  | GoogleVertexClient | Cached via API  |
| GitHub Copilot    | CopilotSdkClient   | Via Copilot SDK |
| DeepSeek          | DeepSeekClient     | Cached via API  |
| OpenRouter        | OpenRouterClient   | Cached via API  |
| Ollama (local)    | OllamaClient       | Cached via API  |
| LM Studio (local) | LMStudioClient     | Cached via API  |
| Snowflake Cortex  | SnowflakeClient    | Static          |
| Posit AI          | PositAiClient      | Cached via API  |
| OpenAI-Compatible | OpenAIClient       | User-configured |
| Foundry           | OpenAIClient       | User-configured |

## API Reference

### ProviderRegistry

Plugin system for registering model fetchers and client factories per provider. Created once at startup and passed to `NodeModelService` (or used directly).

```ts
import { ProviderRegistry } from "ai-provider-bridge";

const registry = new ProviderRegistry(logger);
```

#### Methods

| Method                  | Signature                                                                                   | Description                                                           |
| ----------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `registerModelFetcher`  | `(providerId: string, fetcher: ModelFetcher) => void`                                       | Register a function that returns available models for a provider      |
| `registerClientFactory` | `(providerId: string, factory: ClientFactory) => void`                                      | Register a function that creates a `ModelClient` for a provider       |
| `getModelsForProvider`  | `(providerId: string, credentials: ProviderCredentials, metadata?) => Promise<ModelInfo[]>` | Fetch models (returns `[]` if provider not registered or fetch fails) |
| `getClientForProvider`  | `(providerId: string, credentials: ProviderCredentials) => ModelClient \| null`             | Create a client (returns `null` if provider not registered)           |
| `clearAllModelCaches`   | `() => void`                                                                                | Clear all provider-level model caches (call on credential change)     |
| `clearModelCache`       | `(providerId: string) => void`                                                              | Clear a single provider's model cache                                 |

#### Types

```ts
// Function that fetches available models for a provider
type ModelFetcher = (
  credentials: ProviderCredentials,
  metadata?: Record<string, unknown>,
) => Promise<ModelInfo[]>;

// Function that creates an API client for a provider
type ClientFactory = (credentials: ProviderCredentials) => ModelClient;
```

### ModelClient

Interface that all LLM clients implement. Returns an async iterable of `LMStreamPart` (AI SDK `TextStreamPart`).

```ts
interface ModelClient {
  chat(params: {
    model: string;
    messages: ModelMessage[];
    systemPrompt?: string;
    maxOutputTokens?: number;
    tools?: Record<string, AiToolWithJsonSchema>;
    cancellationToken: CancellationToken;
    thinkingEffort?: string;
    contextLength?: number;
    webSearchEnabled?: boolean;

    // Posit Assistant-specific parameters
    metadata?: { sessionId?: string; conversationId?: string };
    stepLoggers?: StepLogger[];
  }): Promise<AsyncIterable<LMStreamPart>>;
}
```

### CredentialProvider

Platform-agnostic credential access. The `/positron` entrypoint provides a VS Code implementation; other platforms use `NodeModelService`'s credential resolution directly.

```ts
interface CredentialProvider {
  getCredentials(providerId: ProviderId): Promise<ProviderCredentials | null>;
  onDidChangeCredentials(callback: (providerIds: ProviderId[]) => void): Disposable;
}
```

### StepLogger

Interface for logging LLM API call steps (request/response data, token usage). Multiple loggers can be used simultaneously (e.g., JSON files + CSV).

```ts
interface StepLogger {
  logStep(data: StepLogData): Promise<void>;
  reportCreditsDepleted?(): void; // optional: 402 from gateway
  reportAgreementRequired?(): void; // optional: 403 from gateway
}

interface StepLogData {
  callId: string;
  stepIndex: number;
  provider: string;
  model: string;
  request: unknown;
  response: unknown;
  usage: LanguageModelUsage;
  providerMetadata?: Record<string, unknown>;
  headers: Record<string, string>;
}
```

### createCachedModelFetcher

Factory for building model fetchers with TTL caching and a three-level fallback strategy (fresh fetch > stale cache > static fallback models).

```ts
import { createCachedModelFetcher } from "ai-provider-bridge";

const fetcher = createCachedModelFetcher<ApiKeyCredentials>({
  providerId: "my-provider",
  apiUrl: "https://api.example.com/v1/models",   // or resolveUrl for dynamic endpoints
  hasCredentials: (creds) => Boolean(creds.apiKey),
  createHeaders: (creds) => ({ Authorization: `Bearer ${creds.apiKey}` }),
  parseResponse: (data) => /* transform API response to ModelInfo[] */,
  fallbackModels: [{ id: "default-model", name: "Default", ... }],
  ttl: 60 * 60 * 1000,  // default: 60 minutes
  logger,
});

// Register it
registry.registerModelFetcher("my-provider", fetcher);

// Invalidate cache when credentials change
fetcher.clearCache?.();
```

### LocalProviderManager

Manages endpoint configuration for local LLM providers (Ollama, LM Studio). Uses dependency injection for all I/O -- no platform-specific or `vscode` dependencies. The manager owns no file path: the consumer supplies `readSettings` / `mutateSettings` / `watchSettings` callbacks (endpoints live under a `providers.{providerId}.endpoint` key in whatever store the consumer injects), and the manager caches them in-memory for synchronous reads.

```ts
import { LocalProviderManager, LOCAL_PROVIDER_IDS, isLocalProviderId } from "ai-provider-bridge";

// LOCAL_PROVIDER_IDS: readonly ["ollama", "lmstudio"]

const manager = new LocalProviderManager({
  readSettings: async () => {
    /* read and parse settings.json, return object or undefined */
  },
  mutateSettings: async (mutator) => {
    /* read-mutate-write settings.json atomically */
  },
  watchSettings: (onChange) => {
    /* watch settings file, return { dispose() } */
  },
  isEnabled: () => true,
  watchEnabled: (onChange) => ({ dispose: () => {} }),
  logger: { warn: console.warn, info: console.info },
});

await manager.initialize(); // read disk + start watchers

manager.getEndpoint("ollama"); // synchronous, from cache
await manager.setEndpoint("ollama", "http://localhost:11434");
await manager.clearEndpoint("ollama");

manager.onDidChange((providerIds) => {
  // React to endpoint or feature-gate changes
});

manager.dispose(); // stop watchers
```

### Provider Map

Static mapping of provider IDs to Positron auth provider configuration. Exported from the root entrypoint (no `vscode` dependency).

```ts
import { PROVIDER_MAP, MAPPED_PROVIDER_IDS } from "ai-provider-bridge";

// MAPPED_PROVIDER_IDS: readonly ProviderId[] (derived from PROVIDER_MAP)
// e.g. ["anthropic", "positai", "openai", "gemini", "google-vertex",
//        "openai-compatible", "bedrock", "ms-foundry", "snowflake-cortex",
//        "copilot", "deepseek"]

// PROVIDER_MAP: Partial<Record<ProviderId, AuthProviderMapping>>
// Each entry has: { authProviderId, scopes, credentialType }
```

### Credential Types

```ts
type ProviderCredentials =
  | ApiKeyCredentials // { type: "apikey"; apiKey: string; baseUrl?: string }
  | OAuthCredentials // { type: "oauth"; accessToken: string; baseUrl?: string }
  | AwsCredentials // { type: "aws-credentials"; region: string; accessKeyId: string; ... }
  | GoogleCloudCredentials // { type: "google-cloud"; projectId?: string; location?: string }
  | LocalCredentials; // { type: "local"; endpoint: string }
```

## Caching

The package provides built-in caching at multiple levels:

### Model Listing Cache (Automatic)

`createCachedModelFetcher` is used internally by most `register*Provider` functions. It provides:

- **60-minute TTL** by default (configurable)
- **Three-level fallback**: fresh API fetch > stale cache > static fallback models
- **Cache invalidation** via `registry.clearModelCache(providerId)` or `registry.clearAllModelCaches()`

```ts
// Models are cached automatically -- repeated calls use the cache
const models = await registry.getModelsForProvider("anthropic", credentials);

// Force cache invalidation (e.g., when credentials change)
registry.clearModelCache("anthropic");

// Or clear all provider caches at once
registry.clearAllModelCaches();
```

### Registry Instance (Consumer Responsibility)

The `ProviderRegistry` should be created once at application startup and reused for the lifetime of the process. Provider registrations are stored in in-memory maps -- creating multiple registries wastes memory and loses cache state.

```ts
// app startup -- create once
const registry = new ProviderRegistry(logger);
registerAnthropicProvider(registry, logger);
registerOpenAIProvider(registry, logger);
registerBedrockProvider(registry, logger);

// Export for use across the application
export { registry };
```

### Client Instances

`getClientForProvider()` creates a new `ModelClient` on each call. For API-key providers (Anthropic, OpenAI, etc.), this is lightweight and stateless -- no caching needed. For expensive providers (e.g., Copilot, which spawns a subprocess), the provider's factory function handles internal caching with auth-state transition detection.

## Dependencies

This package uses types from the [Vercel AI SDK](https://sdk.vercel.ai/) (`ai` package) in its public API:

- **`ModelMessage`** (from `ai`) -- the message type for `ModelClient.chat()` input. Consumers must import this from `ai` directly.
- **`LMStreamPart`** (from `ai-provider-bridge`) -- the stream output type, an alias for `ai.TextStreamPart<Record<string, ai.Tool>>`. Consumers import this from ai-provider-bridge.

The `ai` package is a regular dependency (bundled), so consumers don't need to install it separately unless they reference `ai` types directly in their own code.

### Consumer `package.json`

The provider SDKs are regular **dependencies** of this package, so they install transitively -- a consumer only declares `ai-provider-bridge` and gets every provider's SDK without listing them:

```jsonc
{
  "dependencies": {
    "ai-provider-bridge": "*",
    "ai": "^6.0.68", // Only if you reference ModelMessage or other `ai` types directly
  },
}
```

`vscode` is the package's only (optional) peer dependency -- host-provided, and needed only if you import the `/positron` entrypoint.

### Provider SDK Matrix

Informational -- which SDK backs each provider's client. These are bundled (regular dependencies); you do **not** need to install them yourself.

| Provider             | Backing SDK(s)                                                                       |
| -------------------- | ------------------------------------------------------------------------------------ |
| Anthropic            | `@ai-sdk/anthropic`                                                                  |
| OpenAI               | `@ai-sdk/openai`                                                                     |
| Bedrock              | `@ai-sdk/amazon-bedrock`, `@aws-sdk/client-bedrock`, `@aws-sdk/credential-providers` |
| Gemini               | `@ai-sdk/google`                                                                     |
| Google Vertex        | `@ai-sdk/google-vertex`, `google-auth-library`                                       |
| Copilot              | `@github/copilot-sdk`                                                                |
| DeepSeek             | `@ai-sdk/deepseek`                                                                   |
| OpenRouter           | `@openrouter/ai-sdk-provider`                                                        |
| Ollama               | `ai-sdk-ollama`                                                                      |
| OpenAI-Compatible    | `@ai-sdk/openai-compatible`                                                          |
| Positron entry point | `vscode` (peer)                                                                      |

## Usage Examples

### Sending a request and streaming the response

```ts
import type { ModelMessage } from "ai";
import { ProviderRegistry } from "ai-provider-bridge";
import type { LMStreamPart } from "ai-provider-bridge";
import { registerAnthropicProvider } from "ai-provider-bridge/providers";

// 1. Set up registry and register a provider
const registry = new ProviderRegistry(logger);
registerAnthropicProvider(registry, logger);

const credentials = { type: "apikey" as const, apiKey: "sk-..." };

// 2. Create a client
const client = registry.getClientForProvider("anthropic", credentials);

// 3. Build messages using the AI SDK's ModelMessage type
const messages: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "What is 2 + 2?" }] },
];

// 4. Stream the response
const stream = await client!.chat({
  model: "claude-sonnet-4-5-20250929",
  messages,
  cancellationToken: { onCancellationRequested: () => ({ dispose() {} }) },
});

for await (const part of stream) {
  switch (part.type) {
    case "text-delta":
      process.stdout.write(part.textDelta);
      break;
    case "reasoning":
      // Extended thinking content (when thinkingEffort is set)
      break;
    case "tool-call":
      console.log(`Tool call: ${part.toolName}(${JSON.stringify(part.args)})`);
      break;
    case "finish":
      console.log(`\nDone. Usage: ${JSON.stringify(part.usage)}`);
      break;
  }
}
```

### Multi-turn conversation

```ts
import type { ModelMessage } from "ai";
import { ProviderRegistry } from "ai-provider-bridge";
import { registerAnthropicProvider } from "ai-provider-bridge/providers";

const registry = new ProviderRegistry(logger);
registerAnthropicProvider(registry, logger);

const credentials = { type: "apikey" as const, apiKey: "sk-..." };
const client = registry.getClientForProvider("anthropic", credentials)!;
const cancellationToken = { onCancellationRequested: () => ({ dispose() {} }) };

// Build up a conversation history
const messages: ModelMessage[] = [
  { role: "user", content: [{ type: "text", text: "Remember the number 42." }] },
];

// First turn
let response = "";
for await (const part of await client.chat({
  model: "claude-sonnet-4-5-20250929",
  messages,
  cancellationToken,
})) {
  if (part.type === "text-delta") response += part.textDelta;
}

// Append assistant response and next user message
messages.push(
  { role: "assistant", content: [{ type: "text", text: response }] },
  { role: "user", content: [{ type: "text", text: "What number did I ask you to remember?" }] },
);

// Second turn
for await (const part of await client.chat({
  model: "claude-sonnet-4-5-20250929",
  messages,
  cancellationToken,
})) {
  if (part.type === "text-delta") process.stdout.write(part.textDelta);
}
```

### Fetching available models

```ts
import { ProviderRegistry } from "ai-provider-bridge";
import { registerAnthropicProvider } from "ai-provider-bridge/providers";

const registry = new ProviderRegistry(logger);
registerAnthropicProvider(registry, logger);

const models = await registry.getModelsForProvider("anthropic", {
  type: "apikey",
  apiKey: "sk-...",
});

for (const model of models) {
  console.log(`${model.id} -- ${model.name}`);
}
```

### Node platforms (Standalone, RStudio, TUI, Desktop)

Create a `ProviderRegistry`, register providers, and pass it to your platform's model service:

```ts
import { ProviderRegistry } from "ai-provider-bridge";
import { registerAnthropicProvider, registerOpenAIProvider } from "ai-provider-bridge/providers";

// 1. Create registry
const registry = new ProviderRegistry(logger);

// 2. Register providers
registerAnthropicProvider(registry, logger);
registerOpenAIProvider(registry, logger);

// 3. Pass to your platform's model service layer
const modelService = createModelService({
  defaultModel: "claude-sonnet-4-5-20250929",
  pluginRegistry: registry,
  logger,
});
```

### Positron extension (VS Code auth bridge)

```ts
import { ProviderRegistry, MAPPED_PROVIDER_IDS } from "ai-provider-bridge";
import { registerAnthropicProvider } from "ai-provider-bridge/providers";
import { PositronCredentialProvider } from "ai-provider-bridge/positron";

const registry = new ProviderRegistry(logger);
registerAnthropicProvider(registry, logger);

const credentialProvider = new PositronCredentialProvider();

// Fetch models for each mapped provider that has credentials
for (const providerId of MAPPED_PROVIDER_IDS) {
  const credentials = await credentialProvider.getCredentials(providerId);
  if (credentials) {
    const models = await registry.getModelsForProvider(providerId, credentials);
    // ...
  }
}

// React to credential changes
credentialProvider.onDidChangeCredentials((providerIds) => {
  for (const id of providerIds) {
    registry.clearModelCache(id);
  }
});
```

### VS Code Language Model client (vscode.lm)

The `/positron` entrypoint also provides `VscodeLmClient` -- a `ModelClient` implementation that wraps VS Code's Language Model API. This lets any VS Code extension send requests to `vscode.lm` models (e.g., Copilot) through the standard `ModelClient.chat()` interface.

```ts
import type { ModelMessage } from "ai";
import { VscodeLmClient, listVscodeLmModels } from "ai-provider-bridge/positron";

// 1. List available vscode.lm models (optionally filter by provider)
const models = await listVscodeLmModels({ providerIds: ["copilot"] });

// 2. Select a model from VS Code
const vscodeLmModels = await vscode.lm.selectChatModels({ id: models[0].id });

// 3. Create a client wrapping that model
const client = new VscodeLmClient(vscodeLmModels[0], logger);

// 4. Use the standard ModelClient interface
const messages: ModelMessage[] = [{ role: "user", content: [{ type: "text", text: "Hello" }] }];
const stream = await client.chat({
  model: models[0].id,
  messages,
  cancellationToken: { onCancellationRequested: () => ({ dispose() {} }) },
});

for await (const part of stream) {
  if (part.type === "text-delta") process.stdout.write(part.textDelta);
}
```

`listVscodeLmModels()` enriches models with capability information (token limits, tool/image support, thinking effort levels) using the same provider-specific helpers as the direct API path.

The `/positron` entrypoint also exports message conversion utilities:

- **`fromAiMessages2()`** -- converts AI SDK `ModelMessage[]` to `LanguageModelChatMessage2[]`
- **`hasAnthropicCacheControl()` / `setAnthropicCacheControl()`** -- cache marker helpers
- **LM part helpers** -- `isCacheBreakpointPart()`, `cacheBreakpointPart()`, type guards

## Internal / External Build Variants

External builds alias provider files to their `-external` variants via the consuming monorepo's build configuration:

- `providers.ts` -> `providers-external.ts` -- only Posit AI provider (keeps non-positai provider code and SDK dependencies out of the bundle)
- `types.ts` -> `types-external.ts` -- only positai provider ID and notification actions
- `local-providers.ts` -> `local-providers-external.ts` -- empty `LOCAL_PROVIDER_IDS` and no-op `LocalProviderManager` (excludes Ollama/LM Studio)

## Adding a New Provider

1. Create a client class in `src/model-clients/`
2. Create a provider module in `src/providers/` with a `register*Provider()` function
3. Export both from `src/providers.ts`
4. If it needs Positron auth mapping, add to `PROVIDER_MAP` in `src/provider-map.ts`
5. Register it in your host application's provider setup

## Development

```bash
npm install
npm run build          # Bundled build (esbuild + declaration emit)
npm run build:unbundled # tsc only (for debugging)
npm run check-types    # Type check without emit
npm run test           # Run tests (vitest)
npm run test:watch     # Watch mode
npm run clean          # Remove dist/ and build artifacts
```

## License

MIT
