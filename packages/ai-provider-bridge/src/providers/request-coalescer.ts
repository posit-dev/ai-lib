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
 * Clear/join contract (monotonic invalidation barriers):
 * - Each flight is stamped with a creation sequence; each provider clear or
 *   re-registration records the current sequence as that provider's barrier
 *   (clear-all records a shared barrier). A provider joins only flights
 *   newer than its barrier, so a call made after a provider clear NEVER
 *   joins or consumes a flight started before that clear — even when the
 *   cleared provider had no caller on the flight (a clear-spanning request
 *   may answer its own callers but must not repopulate — see the fetcher's
 *   generation guard).
 * - Joiners attached before the clear may finish and answer their callers.
 * - Clearing one provider does not cancel another provider's caller on a
 *   shared flight; barriers only bar new joins.
 * - Failure/timeout is never retained; settlement removes the entry
 *   identity-safely (a barred flight's cleanup never removes a newer flight).
 *
 * Cancellation: the executor receives only a coalescer-owned AbortSignal. No
 * individual joiner owns flight cancellation — a caller's own deadline still
 * releases it via the fetcher's race — and the flight's entry is removed and
 * its signal aborted once EVERY attached caller has detached, which bounds a
 * shared request to roughly the last caller's discovery deadline. Removal
 * happens before aborting so an abort-insensitive executor that never
 * settles cannot leave the aborted flight joinable, dooming later calls to
 * join it and time out. There is no disposal API: per-registry isolation
 * (each ProviderRegistry owns its own coalescer) and identity-safe
 * settlement cleanup replace it.
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
 * implements it so `clearModelCache(providerId)` can bar that provider from
 * joining flights started before its clear.
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
	/** Map key, retained so detachment can remove the entry identity-safely. */
	readonly key: string;
	readonly controller: AbortController;
	readonly promise: Promise<unknown>;
	/** Creation order; a provider joins only flights newer than its barrier. */
	readonly sequence: number;
	/** Callers whose own signal aborted; the flight aborts when all detach. */
	detached: number;
	total: number;
}

export class InFlightRequestCoalescer implements ModelRequestCoalescer {
	private readonly flights = new Map<string, Flight>();
	/** Monotonic clock: flights take the next value; barriers record it. */
	private clock = 0;
	/** Latest clear/re-registration sequence per provider. */
	private readonly providerBarriers = new Map<string, number>();
	/** Latest clear-all sequence; applies to every provider. */
	private allBarrier = 0;

	coalesceModelRequest(
		providerId: string,
		identity: ModelRequestIdentity,
		caller: AbortSignal,
		execute: ModelRequestExecutor,
	): Promise<unknown> {
		const key = identityKey(identity);
		const existing = this.flights.get(key);
		if (
			existing &&
			!existing.controller.signal.aborted &&
			existing.sequence > this.barrierFor(providerId)
		) {
			this.attach(existing, caller);
			return existing.promise;
		}

		const controller = new AbortController();
		const promise = Promise.resolve()
			.then(() => execute(controller.signal))
			.then((payload) => freezePayload(payload));
		const flight: Flight = {
			key,
			controller,
			promise,
			sequence: ++this.clock,
			detached: 0,
			total: 0,
		};
		// A barred flight may still occupy the map while its callers finish;
		// a fresh call starts a new flight and replaces the entry.
		this.flights.set(key, flight);
		this.attach(flight, caller);
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

	/** The clear/re-registration sequence a provider's joins must postdate. */
	private barrierFor(providerId: string): number {
		return Math.max(this.allBarrier, this.providerBarriers.get(providerId) ?? 0);
	}

	private attach(flight: Flight, caller: AbortSignal): void {
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
		// so a hung server cannot pin the flight. Remove the entry BEFORE
		// aborting: an abort-insensitive executor may never settle, and
		// settlement-only cleanup would leave the aborted flight joinable
		// forever, so every later call would join it and time out without
		// issuing a fresh request.
		if (flight.detached >= flight.total) {
			if (this.flights.get(flight.key) === flight) {
				this.flights.delete(flight.key);
			}
			flight.controller.abort();
		}
	}

	/**
	 * Bar the provider from joining any flight started before now: post-clear
	 * calls start fresh flights instead of joining pre-clear ones, even when
	 * the provider had no caller on those flights. Attached callers are not
	 * cancelled.
	 */
	retireProvider(providerId: string): void {
		this.providerBarriers.set(providerId, this.clock);
	}

	/**
	 * Bar every provider from joining any flight started before now
	 * (clear-all). Attached callers are not cancelled.
	 */
	retireAll(): void {
		this.allBarrier = this.clock;
	}
}
