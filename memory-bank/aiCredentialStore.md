---
title: ai-credential-store Architecture
description: Architecture of ai-credential-store -- a generic typed single-file KV store with atomic writes, cross-process locking, secure permissions, and file watching.
package: ai-credential-store
---

# ai-credential-store Architecture

## Overview

`ai-credential-store` is a generic, typed key-value store backed by a single
JSON file on disk. It is built for small amounts of sensitive data (credentials,
OAuth tokens, API keys), and its value proposition is the disk-I/O hard parts:
atomic writes, cross-process locking, secure file permissions, and file
watching.

It is a **leaf** package: it imports nothing from `ai-config`,
`ai-provider-bridge`, or any host application, and the two sibling packages do
not import it. Its only runtime dependencies are `chokidar` (watching) and
`proper-lockfile` (cross-process locking). Host applications (e.g. the main
monorepo's Node auth service) are the consumers.

**The store owns where and how bytes hit disk; it does not own credential
meaning.** OAuth semantics, provider grouping, and auth status stay with the
caller. Values are fully generic — callers supply their own types via method
type parameters, so the store has zero knowledge of what it holds.

## Public API

Single entrypoint (`ai-credential-store`), exporting one class, two factory
helpers, and three types:

```ts
export { SingleFileStore } from "./SingleFileStore";
export { createDefaultStore, getDefaultStorePath } from "./defaults";
export type { Disposable, LoggerLike, SingleFileStoreConfig } from "./types";
```

### Default path convention

The package owns the canonical default credential store path:
`~/.posit/genai/auth/data.json`. Consumers that want the standard location use
the convenience helpers:

```ts
import { createDefaultStore, getDefaultStorePath } from "ai-credential-store";

const store = createDefaultStore(logger); // ~/.posit/genai/auth/data.json
const path = getDefaultStorePath(); // inspect the path
```

### Custom path

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

The canonical default location is `~/.posit/genai/auth/data.json`, owned by
`getDefaultStorePath()`. Custom paths are supported via `config.filePath` (an
absolute path). On first access `ensureFileExists()` creates the parent
directories (`0o700`) and an empty `{}` file (`0o600`).

## Code Layout

| Location                 | What it does                                                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`           | `SingleFileStoreConfig`, `LoggerLike` (minimal `debug`/`warn`), `Disposable`                                                             |
| `src/SingleFileStore.ts` | The store: read/write/lock/watch + private helpers (`writeStore`, `readStore`, `withWriteLock`, `ensureFileExists`, `ensurePermissions`) |
| `src/defaults.ts`        | `getDefaultStorePath()` and `createDefaultStore()` — canonical default path convention                                                   |
| `src/index.ts`           | Root entrypoint exports                                                                                                                  |

## Invariants & Design Decisions

- **Leaf dependency** — no imports from sibling packages or host apps; runtime
  deps limited to `chokidar` + `proper-lockfile`.
- **Generic, not opinionated** — types live on `get`/`set`, not the class; the
  store has no notion of credentials, providers, or schemas.
- **Keys are opaque** — namespacing is a convention, not enforced.
- **Atomic writes via temp + rename**, PID-suffixed to avoid cross-process
  collisions.
- **Two lock layers** — in-process write mutex (non-re-entrant) for ordering
  within a process; `withLock` for caller-scoped cross-process critical sections.
- **Secure-by-default permissions** on Unix; skipped on Windows.
- **Graceful degradation** — invalid JSON and watcher-init failures log and
  recover rather than throw.
- **Disposable watch lifecycle** — mirrors VS Code's resource pattern.
