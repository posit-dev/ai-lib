/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * In-Flight Request Coalescer
 *
 * Registry-owned single-flight coalescer for model-discovery HTTP requests.
 * When the same backend is configured under two provider ids (e.g. the
 * built-in `litellm` provider plus a custom `type: "litellm"` entry pointing
 * at the same gateway), a discovery pass launches both providers' fetches
 * concurrently; without coalescing, the gateway receives two identical
 * requests. Opted-in fetchers share ONE decoded immutable payload; each
 * provider then runs its own parse/stamp pass over it.
 *
 * The coalescer is in-flight-ONLY by design: completed results already live
 * in each provider's own `createCachedModelFetcher()` TTL, so retaining
 * responses here would duplicate cache state and complicate clear/expiry
 * semantics.
 *
 * Clear/join contract:
 * - A call made after a provider clear NEVER joins or consumes a flight
 *   started before that clear (a clear-spanning request may answer its own
 *   callers but must not repopulate — see the fetcher's generation guard).
 *   Retirement at clear time is what bars the join.
 * - Joiners attached before the clear may finish and answer their callers.
 * - Clearing one provider does not cancel another provider's caller on a
 *   shared flight; retirement only bars new joins.
 * - Failure/timeout is never retained; settlement removes the entry
 *   identity-safely (a retired flight's cleanup never removes a newer flight).
 *
 * Cancellation: the executor receives only a coalescer-owned AbortSignal. No
 * individual joiner owns flight cancellation — a caller's own deadline still
 * releases it via the fetcher's race — and the flight's signal aborts only
 * once EVERY participant has detached (aborted), which bounds a shared
 * request to roughly the last participant's discovery deadline. There is no
 * disposal API: per-registry isolation (each ProviderRegistry owns its own
 * coalescer) and identity-safe settlement cleanup replace it.
 */

import { sha256Hex } from "./sha256";

/**
 * Identity of a coalescible request. Two calls join the same flight only when
 * every field matches: the operation namespace and method prevent joining
 * requests that share a URL but expect different response contracts, and the
 * header fingerprint separates requests whose effective auth or
 * response-affecting headers differ.
 */
export interface ModelRequestIdentity {
	/** Operation namespace, e.g. "model-discovery". */
	readonly namespace: string;
	/** HTTP method, uppercased (model discovery is always "GET" today). */
	readonly method: string;
	/** Normalized URL (see {@link normalizeRequestUrl}). */
	readonly url: string;
	/** Non-secret fingerprint of the effective headers (see {@link fingerprintHeaders}). */
	readonly headersFingerprint: string;
}

/** Executes the shared request. The signal is coalescer-owned. */
export type ModelRequestExecutor = (signal: AbortSignal) => Promise<unknown>;

/**
 * The narrow coalescer surface a model fetcher needs. `ProviderRegistry`
 * implements it so `clearModelCache(providerId)` can retire exactly the
 * identities that provider used.
 */
export interface ModelRequestCoalescer {
	coalesceModelRequest(
		providerId: string,
		identity: ModelRequestIdentity,
		caller: AbortSignal,
		execute: ModelRequestExecutor,
	): Promise<unknown>;
}

/**
 * Normalize a request URL for identity comparison: parsing lowercases the
 * scheme/host and drops default ports, so trivially-different spellings of
 * the same endpoint still join. Unparseable URLs compare raw.
 */
export function normalizeRequestUrl(url: string): string {
	try {
		return new URL(url).toString();
	} catch {
		return url;
	}
}

/**
 * Non-secret fingerprint of a request's effective headers: a SHA-256 over the
 * canonical (lowercased-name, sorted) header list. Raw header values — which
 * carry API keys for gateway providers — are never retained as map keys and
 * never logged.
 */
export function fingerprintHeaders(headers: Record<string, string>): string {
	const canonical = Object.entries(headers)
		.map(([name, value]) => [name.toLowerCase(), value] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => `${name}: ${value}`)
		.join("\n");
	return sha256Hex(canonical);
}

function identityKey(identity: ModelRequestIdentity): string {
	return [identity.namespace, identity.method, identity.url, identity.headersFingerprint].join(
		"\n",
	);
}

/** Deep-freeze the decoded payload: joiners share ONE immutable value. */
function freezePayload<T>(value: T): T {
	if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const nested of Object.values(value)) {
			freezePayload(nested);
		}
	}
	return value;
}

interface Flight {
	readonly controller: AbortController;
	readonly promise: Promise<unknown>;
	/** Providers whose callers are attached (drives provider-scoped retirement). */
	readonly participants: Set<string>;
	/** Callers whose own signal aborted; the flight aborts when all detach. */
	detached: number;
	total: number;
	/** Retired flights answer their attached callers but accept no new joins. */
	retired: boolean;
}

export class InFlightRequestCoalescer implements ModelRequestCoalescer {
	private readonly flights = new Map<string, Flight>();

	coalesceModelRequest(
		providerId: string,
		identity: ModelRequestIdentity,
		caller: AbortSignal,
		execute: ModelRequestExecutor,
	): Promise<unknown> {
		const key = identityKey(identity);
		const existing = this.flights.get(key);
		if (existing && !existing.retired) {
			this.attach(existing, providerId, caller);
			return existing.promise;
		}

		const controller = new AbortController();
		const promise = Promise.resolve()
			.then(() => execute(controller.signal))
			.then((payload) => freezePayload(payload));
		const flight: Flight = {
			controller,
			promise,
			participants: new Set(),
			detached: 0,
			total: 0,
			retired: false,
		};
		// A retired flight may still occupy the map while its callers finish;
		// a fresh call starts a new flight and replaces the entry.
		this.flights.set(key, flight);
		this.attach(flight, providerId, caller);
		// Identity-safe settlement cleanup: success and failure alike are
		// removed, and an earlier flight's cleanup never removes a newer one.
		const cleanup = () => {
			if (this.flights.get(key) === flight) {
				this.flights.delete(key);
			}
		};
		flight.promise.then(cleanup, cleanup);
		return flight.promise;
	}

	private attach(flight: Flight, providerId: string, caller: AbortSignal): void {
		flight.participants.add(providerId);
		flight.total++;
		if (caller.aborted) {
			this.detach(flight);
			return;
		}
		caller.addEventListener("abort", () => this.detach(flight), { once: true });
	}

	private detach(flight: Flight): void {
		flight.detached++;
		// No caller remains that can consume the result — cancel cooperatively
		// so a hung server cannot pin the flight (and its map entry) forever.
		if (flight.detached >= flight.total) {
			flight.controller.abort();
		}
	}

	/**
	 * Retire every flight the provider participates in: post-clear calls start
	 * fresh flights instead of joining pre-clear ones. Attached callers are
	 * not cancelled.
	 */
	retireProvider(providerId: string): void {
		for (const flight of this.flights.values()) {
			if (flight.participants.has(providerId)) {
				flight.retired = true;
			}
		}
	}

	/** Retire all flights (clear-all). Attached callers are not cancelled. */
	retireAll(): void {
		for (const flight of this.flights.values()) {
			flight.retired = true;
		}
	}
}
