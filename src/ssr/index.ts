import { internalsOf } from '../core/internal.js';
import { collectDeep, collectSubtree, bumpToRoot, type Observer } from '../core/node.js';
import { matchesPath } from '../core/path-pattern.js';
import {
	ACTION,
	BULK,
	CELL,
	DERIVED,
	RESOURCE,
	TASK,
	resolveSchema,
	type SchemaNode,
} from '../core/schema.js';
import type {
	DehydrateOptions,
	HydrateOptions,
	HydrateResult,
	Payload,
	Store,
	Write,
} from '../core/index.js';

function fail(message: string): never {
	throw new Error(`[segment-state] ${message}`);
}

/** Serialize addressable data without pulling SSR code into an ordinary store bundle. */
export function dehydrate<S>(store: Store<S>, options?: DehydrateOptions): Payload {
	const { schema, readValue } = internalsOf(store);
	const include = options?.include?.map((pattern) => pattern.split('/'));
	const exclude = options?.exclude?.map((pattern) => pattern.split('/'));
	const data: Record<string, unknown> = {};

	const wanted = (path: string): boolean => {
		if (include !== undefined && !include.some((pattern) => matchesPath(pattern, path))) {
			return false;
		}
		if (exclude !== undefined && exclude.some((pattern) => matchesPath(pattern, path)))
			return false;
		return true;
	};

	const walk = (schemaNode: SchemaNode, segments: readonly string[], path: string): void => {
		switch (schemaNode.kind) {
			case CELL:
			case RESOURCE: {
				// Task run state describes this process's attempt and is never portable.
				if (schemaNode.transient) return;
				const value = readValue(segments, schemaNode);
				if (value !== undefined && wanted(path)) data[path] = value;
				return;
			}
			case BULK: {
				const value = readValue(segments, schemaNode);
				if (value !== undefined && wanted(path)) data[path] = value;
				return;
			}
			case DERIVED:
			case ACTION:
			case TASK:
				return;
			default:
				if (schemaNode.children === null) return;
				for (const [key, child] of schemaNode.children) {
					walk(child, [...segments, key], path === '' ? key : `${path}/${key}`);
				}
		}
	};
	walk(schema, [], '');

	return options?.at === undefined ? { v: 1, data } : { v: 1, at: options.at, data };
}

interface StagedHydration {
	readonly path: string;
	readonly segments: readonly string[];
	readonly value: unknown;
}

function markStaleUnder(
	store: ReturnType<typeof internalsOf>,
	schemaNode: SchemaNode,
	segments: readonly string[],
	path: string,
): void {
	if (schemaNode.kind === RESOURCE) {
		store.markResourceStale(schemaNode, segments, path);
		return;
	}
	if (schemaNode.kind === BULK) {
		const bulk = store.readValue(segments, schemaNode);
		if (bulk === null || typeof bulk !== 'object') return;
		for (const key of Object.keys(bulk)) {
			markStaleUnder(store, schemaNode.dynamic!, [...segments, key], `${path}/${key}`);
		}
		return;
	}
	if (schemaNode.children === null) return;
	for (const [key, child] of schemaNode.children) {
		markStaleUnder(store, child, [...segments, key], path === '' ? key : `${path}/${key}`);
	}
}

/** Adopt a payload as one commit while keeping the policy and traversal code opt-in. */
export function hydrate<S>(
	store: Store<S>,
	payload: Payload,
	options?: HydrateOptions,
): HydrateResult {
	if (payload.v !== 1) {
		fail(`unsupported payload version ${String(payload.v)}; this build reads version 1`);
	}

	const internals = internalsOf(store);
	const { schema } = internals;
	const allow = options?.allow?.map((pattern) => pattern.split('/'));
	const writes = new Map<string, StagedHydration>();
	const bulkPaths: string[] = [];
	const rejected: string[] = [];
	const unknown: string[] = [];

	for (const [path, value] of Object.entries(payload.data)) {
		if (allow !== undefined && !allow.some((pattern) => matchesPath(pattern, path))) {
			rejected.push(path);
			continue;
		}
		const segments = path.split('/');
		const schemaNode = resolveSchema(schema, segments);
		if (schemaNode === null) {
			unknown.push(path);
			continue;
		}
		if (schemaNode.kind === DERIVED || schemaNode.kind === ACTION || schemaNode.kind === TASK) {
			rejected.push(path);
			continue;
		}
		if (schemaNode.kind === BULK) {
			const node = internals.findNode(segments);
			if (node === null) {
				unknown.push(path);
				continue;
			}
			node.value = value;
			bulkPaths.push(path);
			continue;
		}
		writes.set(path, { path, segments, value });
	}

	const stale =
		options?.maxAge !== undefined && payload.at !== undefined
			? Date.now() - payload.at > options.maxAge
			: false;
	const version = internals.advanceVersion();
	const woken = new Set<Observer>();

	for (const path of bulkPaths) {
		const node = internals.findNode(path.split('/'))!;
		bumpToRoot(node, version);
		internals.bumpSubtree(node, version);
		collectSubtree(node, woken);
		collectDeep(node, woken);
	}

	const applied: Write[] = [];
	for (const staged of writes.values()) {
		const schemaNode = resolveSchema(schema, staged.segments)!;
		const prev = internals.readValue(staged.segments, schemaNode);
		if (Object.is(prev, staged.value)) continue;
		internals.writeThrough(staged.segments, staged.value);
		applied.push({ path: staged.path, prev, next: staged.value });
		internals.wakeForWrite(staged.segments, woken);
	}

	internals.pushDerived(woken);
	internals.sweepResources(woken);

	if (stale) {
		for (const path of [...bulkPaths, ...writes.keys()]) {
			const segments = path.split('/');
			const schemaNode = resolveSchema(schema, segments);
			if (schemaNode !== null) markStaleUnder(internals, schemaNode, segments, path);
		}
	}

	internals.notify(woken, {
		id: internals.nextCommitId(),
		source: options?.source ?? 'hydrate',
		writes: applied,
	});
	return {
		applied: [...bulkPaths, ...applied.map((write) => write.path)],
		rejected,
		unknown,
	};
}

export type { DehydrateOptions, HydrateOptions, HydrateResult, Payload } from '../core/index.js';
