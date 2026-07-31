import { internalsOf } from '../core/internal.js';
import { matchesPath, pathHead } from '../core/path-pattern.js';
import type { Commit, Dispose, Port, PortContext, Store } from '../core/index.js';

const WATCH_ANY = '\u0000any';

interface WatchEntry {
	readonly pattern: readonly string[];
	readonly cb: (path: string) => void;
	readonly owner: PortRecord;
	live: boolean;
}

interface PortRecord {
	readonly port: Port;
	readonly hub: PortHub;
	readonly watches: Set<WatchEntry>;
	readonly commits: Set<(commit: Commit) => void>;
	cleanup: Dispose | null;
	live: boolean;
}

interface PortHub {
	readonly store: Store<unknown>;
	readonly ports: Set<PortRecord>;
	readonly watchIndex: Map<string, Set<WatchEntry>>;
	listeners: number;
	stop: Dispose | null;
}

const hubs = new WeakMap<object, PortHub>();

function fail(message: string): never {
	throw new Error(`[segment-state] ${message}`);
}

function hubFor<S>(store: Store<S>): PortHub {
	let hub = hubs.get(store);
	if (hub !== undefined) return hub;
	hub = {
		store: store as unknown as Store<unknown>,
		ports: new Set(),
		watchIndex: new Map(),
		listeners: 0,
		stop: null,
	};
	hubs.set(store, hub);
	return hub;
}

function ensureListening(hub: PortHub): void {
	if (hub.stop === null) hub.stop = hub.store.commits((commit) => dispatch(hub, commit));
}

function addListener(hub: PortHub): void {
	hub.listeners++;
	ensureListening(hub);
}

function removeListeners(hub: PortHub, count: number): void {
	if (count === 0) return;
	hub.listeners -= count;
	if (hub.listeners !== 0 || hub.stop === null) return;
	const stop = hub.stop;
	hub.stop = null;
	stop();
}

function indexWatch(hub: PortHub, entry: WatchEntry): void {
	const head = entry.pattern[0];
	const bucket = head === '*' || head === '**' ? WATCH_ANY : head;
	let entries = hub.watchIndex.get(bucket);
	if (entries === undefined) hub.watchIndex.set(bucket, (entries = new Set()));
	entries.add(entry);
}

function unindexWatch(hub: PortHub, entry: WatchEntry): void {
	const head = entry.pattern[0];
	const bucket = head === '*' || head === '**' ? WATCH_ANY : head;
	const entries = hub.watchIndex.get(bucket);
	if (entries === undefined) return;
	entries.delete(entry);
	if (entries.size === 0) hub.watchIndex.delete(bucket);
}

function removeWatch(entry: WatchEntry): void {
	if (!entry.live) return;
	entry.live = false;
	entry.owner.watches.delete(entry);
	unindexWatch(entry.owner.hub, entry);
	removeListeners(entry.owner.hub, 1);
}

function report(error: unknown, record: PortRecord): void {
	// eslint-disable-next-line no-console
	console.error(`[segment-state] port "${record.port.name}" threw and was isolated:`, error);
}

function isolate<A>(record: PortRecord, fn: (arg: A) => void, arg: A): void {
	try {
		fn(arg);
	} catch (error) {
		detachRecord(record);
		report(error, record);
	}
}

function dispatchBucket(entries: Set<WatchEntry> | undefined, path: string): void {
	if (entries === undefined) return;
	for (const entry of [...entries]) {
		if (!entry.live || !entry.owner.live || !matchesPath(entry.pattern, path)) continue;
		isolate(entry.owner, entry.cb, path);
	}
}

function dispatch(hub: PortHub, commit: Commit): void {
	for (const record of [...hub.ports]) {
		for (const cb of [...record.commits]) {
			if (!record.live) break;
			isolate(record, cb, commit);
		}
	}
	for (const write of commit.writes) {
		dispatchBucket(hub.watchIndex.get(pathHead(write.path)), write.path);
		dispatchBucket(hub.watchIndex.get(WATCH_ANY), write.path);
	}
}

function detachRecord(record: PortRecord): void {
	if (!record.live) return;
	record.live = false;
	const { hub } = record;
	hub.ports.delete(record);
	internalsOf(hub.store).changePortCount(-1);

	const listenerCount = record.watches.size + record.commits.size;
	for (const entry of record.watches) {
		entry.live = false;
		unindexWatch(hub, entry);
	}
	record.watches.clear();
	record.commits.clear();
	removeListeners(hub, listenerCount);

	const cleanup = record.cleanup;
	record.cleanup = null;
	if (cleanup !== null) {
		try {
			cleanup();
		} catch (error) {
			report(error, record);
		}
	}

	if (hub.ports.size === 0) {
		if (hub.stop !== null) {
			const stop = hub.stop;
			hub.stop = null;
			hub.listeners = 0;
			stop();
		}
		hubs.delete(hub.store);
	}
}

/** Attach an external path-based adapter without making ports part of every store. */
export function attachPort<S>(store: Store<S>, port: Port): Dispose {
	const hub = hubFor(store);
	for (const existing of hub.ports) {
		if (existing.port === port) fail(`port "${port.name}" is already attached`);
	}

	const record: PortRecord = {
		port,
		hub,
		watches: new Set(),
		commits: new Set(),
		cleanup: null,
		live: true,
	};
	hub.ports.add(record);
	internalsOf(store).changePortCount(1);

	const assertLive = (): void => {
		if (!record.live) fail(`port "${port.name}" is detached`);
	};
	const ctx: PortContext = {
		read: (path) => {
			assertLive();
			return hub.store.get(hub.store.ref(path));
		},
		write: (path, value) => {
			assertLive();
			hub.store.set(hub.store.ref(path), value, port.name);
		},
		watch: (pattern, cb) => {
			assertLive();
			const entry: WatchEntry = {
				pattern: pattern.split('/'),
				cb,
				owner: record,
				live: true,
			};
			record.watches.add(entry);
			indexWatch(hub, entry);
			addListener(hub);
			return () => removeWatch(entry);
		},
		commits: (cb) => {
			assertLive();
			if (!record.commits.has(cb)) {
				record.commits.add(cb);
				addListener(hub);
			}
			return () => {
				if (!record.commits.delete(cb)) return;
				removeListeners(hub, 1);
			};
		},
	};

	try {
		const cleanup = port.attach(ctx);
		if (typeof cleanup === 'function') {
			if (record.live) record.cleanup = cleanup;
			else {
				try {
					cleanup();
				} catch (error) {
					report(error, record);
				}
			}
		}
	} catch (error) {
		detachRecord(record);
		throw error;
	}
	return () => detachRecord(record);
}

export type { Commit, Port, PortContext } from '../core/index.js';
