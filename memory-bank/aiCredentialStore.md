---
title: ai-credentials Architecture
description: Architecture of ai-credentials -- credential types, shaping, and a generic typed single-file KV store with atomic writes, cross-process locking, secure permissions, and file watching.
package: ai-credentials
---

# ai-credentials Architecture

## Overview

`ai-credentials` provides browser-safe credential types and shaping logic, a
provider-neutral OAuth acquisition controller, a generic typed key-value secret
store, and a credential-aware store backend. It is the single source of truth
for runtime credential interfaces and for the generation protocol that prevents
stale OAuth completions from resurrecting replaced credentials.

It imports nothing from `ai-config`, `ai-provider-bridge`, or any host
application. The pure root and `/types` entrypoints remain browser-safe;
platform dependencies are isolated to `/store`, `/store-backend`, and
`/positron`.

## Entrypoints

| Entrypoint                | Purpose                                                                           | Browser-safe? |
| ------------------------- | --------------------------------------------------------------------------------- | ------------- |
| `ai-credentials`          | CredentialProvider factory, unified acquisition controller, OAuth helpers         | Yes           |
| `ai-credentials/types`    | Credential interfaces, `shapeCredentials()`, `AuthProviderMapping`, `Logger`      | **Yes**       |
| `ai-credentials/store`    | `SingleFileStore` class, `createDefaultStore`, `getDefaultStorePath`, store types | No (Node FS)  |
| `ai-credentials/store-backend` | Credential-aware store/env resolver, disk schema, transactions              | No (Node FS)  |
| `ai-credentials/positron` | `vscode.authentication` backend                                                    | No (VS Code)  |

### `/types` — Browser-safe credential types and shaping

The types entrypoint is the canonical home for credential type definitions and
the pure `shapeCredentials()` function. It has **no imports** from `vscode`,
`@ai-sdk/*`, `@aws-sdk/*`, `ai`, Node builtins (`fs`, `path`, `os`),
`@assistant/*`, `ai-config`, or sibling entrypoints (`../store/`).

```ts
import type { ProviderCredentials, ApiKeyCredentials } from "ai-credentials/types";
import { shapeCredentials, CONFIG_KEY_OVERRIDES } from "ai-credentials/types";
import type { AuthProviderMapping, CredentialConfig, Logger } from "ai-credentials/types";
import { buildSnowflakeCortexUrl } from "ai-credentials/types";
```

`ai-provider-bridge` re-exports these types from its own entrypoints, so
existing consumers of `ai-provider-bridge` continue to work unchanged.

### `/store` — Generic secret store

The store entrypoint provides a typed key-value store backed by a single JSON
file on disk. It is built for small amounts of sensitive data (credentials,
OAuth tokens, API keys).

**The generic `/store` entrypoint owns where and how bytes hit disk; it does not
own credential meaning.** The separate `/store-backend` entrypoint owns tolerant
credential parsing, source normalization, environment precedence, status, and
compare-and-commit OAuth transactions. Values in `/store` remain fully generic.

```ts
import { createDefaultStore, getDefaultStorePath } from "ai-credentials/store";
import { SingleFileStore } from "ai-credentials/store";
import type { LoggerLike, Disposable, SingleFileStoreConfig } from "ai-credentials/store";
```

#### Default path convention

The package owns the canonical default credential store path:
`~/.posit/ai/auth/data.json`. Consumers that want the standard location use
the convenience helpers:

```ts
import { createDefaultStore, getDefaultStorePath } from "ai-credentials/store";

const store = createDefaultStore(logger); // ~/.posit/ai/auth/data.json
const path = getDefaultStorePath(); // inspect the path
```

#### Custom path

For non-default locations (tests, migration stores pointing at old paths), use
the `SingleFileStore` constructor directly:

```ts
constructor(config: SingleFileStoreConfig, logger?: LoggerLike)

interface SingleFileStoreConfig {
  /** Absolute path to the JSON store file. */
  filePath: string;
}
```

The store is **not** generic over a value type at the class level; generics live
on the methods, forcing callers to declare types at each call site:

| Method                                 | Purpose                                                                |
| -------------------------------------- | ---------------------------------------------------------------------- |
| `get<T>(key): Promise<T \| undefined>` | Read a value (parse errors → store treated as `{}`)                    |
| `set<T>(key, value): Promise<void>`    | Write a value (serialized via the in-process write mutex)              |
| `delete(key): Promise<void>`           | Remove a key                                                           |
| `clear(): Promise<void>`               | Remove all keys                                                        |
| `keys(): Promise<string[]>`            | List keys                                                              |
| `withLock<T>(fn): Promise<T>`          | Run `fn` inside a cross-process lock for a multi-step critical section |
| `watch(handler): Disposable`           | Subscribe to external file changes; dispose to stop                    |

Keys are **opaque strings**. A `namespace:key` convention (e.g.
`auth:positai:oauth`) is recommended so multiple products can share one file,
but the store does not parse or enforce it.

## Disk I/O Guarantees

### Atomic writes

`writeStore()` writes to a PID-suffixed temp file (`<filePath>.tmp.<pid>`) and
then `rename`s it over the target. The OS guarantees the rename is atomic, and
the PID suffix prevents concurrent writers from colliding on the temp path. A
`finally` block unlinks the temp file if the rename never happened.

### Secure permissions (Unix only)

Files are written `0o600` and directories created `0o700` (owner-only).
Permissions are applied on write and re-asserted on read if they drift. The
whole permission step is skipped on Windows.

### Concurrency: two layers

- **In-process**: a promise-chain write mutex (`withWriteLock`, private)
  serializes every `set` / `delete` / `clear` within a single process. This lock
  is **not re-entrant** — calling a mutating method from inside a `withWriteLock`
  callback deadlocks.
- **Cross-process**: `withLock(fn)` uses `proper-lockfile` (retries 5×,
  100–1000ms backoff, 10s stale timeout to survive crashes). **The caller chooses
  the scope** — wrap a whole read-modify-write auth operation, or just an
  individual write. The store supplies the primitive, not the policy.

### File watching

`watch(handler)` uses `chokidar` with a 200ms debounce to coalesce rapid edits,
and `awaitWriteFinish` (100ms stability, 50ms poll) plus listening to both
`change` and `add` events so the temp-file+rename atomic-write pattern is
detected reliably. It ensures the file exists before watching, logs (rather than
throws) on init failure, and returns a `Disposable` whose `dispose()` clears the
debounce timer and closes the watcher.

### Corruption tolerance

If the file exists but holds invalid JSON, `readStore()` logs a warning and
returns `{}`; the next write replaces it with valid JSON. No corruption state is
ever persisted.

## Storage Format & Location

JSON, 2-space indented, a flat object keyed by the opaque key strings:

```json
{
  "auth:positai:oauth": { "token": "..." },
  "auth:anthropic:apikey": { "key": "..." }
}
```

The canonical default location is `~/.posit/ai/auth/data.json`, owned by
`getDefaultStorePath()`. Custom paths are supported via `config.filePath` (an
absolute path). On first access `ensureFileExists()` creates the parent
directories (`0o700`) and an empty `{}` file (`0o600`).

## Code Layout

| Location                          | What it does                                                                                                                             |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types/credentials.ts`        | `ApiKeyCredentials`, `OAuthCredentials`, `LocalCredentials`, `AwsCredentials`, `GoogleCloudCredentials`, `ProviderCredentials` union     |
| `src/types/credential-shaping.ts` | `shapeCredentials()`, `CredentialConfig`, `CONFIG_KEY_OVERRIDES`, `AuthProviderMapping`                                                  |
| `src/types/logger.ts`             | `Logger` interface (5-method: info, warn, error, debug, trace)                                                                           |
| `src/types/utils.ts`              | `buildSnowflakeCortexUrl()`, `buildSnowflakeCortexUrlFromHost()` — pure URL helpers                                                      |
| `src/types/index.ts`              | `/types` entrypoint — re-exports everything from the above                                                                               |
| `src/store/types.ts`              | `SingleFileStoreConfig`, `LoggerLike` (minimal `debug`/`warn`), `Disposable`                                                             |
| `src/store/SingleFileStore.ts`    | The store: read/write/lock/watch + private helpers (`writeStore`, `readStore`, `withWriteLock`, `ensureFileExists`, `ensurePermissions`) |
| `src/store/defaults.ts`           | `getDefaultStorePath()` and `createDefaultStore()` — canonical default path convention                                                   |
| `src/store/index.ts`              | `/store` entrypoint exports                                                                                                              |
| `src/index.ts`                    | Root CredentialProvider/acquisition entrypoint                                                                                           |
| `src/acquisition.ts`              | Unified device-code, PKCE, M2M, refresh, cancellation, and awaited disposal controller                                                  |
| `src/store-backend/`              | Credential disk schema, store/env resolution, normalization, generation transactions, and status                                       |
| `src/positron/index.ts`           | `/positron` vscode.authentication backend                                                                                                |

## Invariants & Design Decisions

- **Leaf dependency** — no imports from sibling packages or host apps.
- **`/types` is browser-safe** — zero platform, Node, or SDK dependencies. Only
  local relative imports.
- **`/store` is Node-only** — uses `fs`, `path`, `os`, `chokidar`, `proper-lockfile`.
- **`/types` and `/store` do not cross-import** — they are independent entrypoints
  with no internal dependency edges.
- **Generic, not opinionated** — store types live on `get`/`set`, not the class;
  the store has no notion of credentials, providers, or schemas.
- **Keys are opaque** — namespacing is a convention, not enforced.
- **Atomic writes via temp + rename**, PID-suffixed to avoid cross-process
  collisions.
- **Two lock layers** — in-process write mutex (non-re-entrant) for ordering
  within a process; `withLock` for caller-scoped cross-process critical sections.
- **Secure-by-default permissions** on Unix; skipped on Windows.
- **Graceful degradation** — invalid JSON and watcher-init failures log and
  recover rather than throw.
- **Disposable watch lifecycle** — mirrors VS Code's resource pattern.
