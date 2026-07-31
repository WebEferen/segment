import type { Node, Observer } from './node.js';
import type { SchemaNode } from './schema.js';
import type { Commit } from './types.js';

/**
 * Private bridge for optional package entry points.
 *
 * The core exposes one lazy accessor instead of importing adapters or dispatching
 * feature hooks from reads and writes. `Symbol.for` lets an SSR or port entry point
 * diagnose a duplicated package cleanly instead of relying on `instanceof`.
 */
export const STORE_INTERNALS = /* @__PURE__ */ Symbol.for('segment-state.store-internals');

export interface StoreInternals {
	readonly v: 1;
	readonly schema: SchemaNode;
	findNode(segments: readonly string[]): Node | null;
	readValue(segments: readonly string[], schemaNode: SchemaNode): unknown;
	writeThrough(segments: readonly string[], value: unknown): void;
	wakeForWrite(segments: readonly string[], out: Set<Observer>): void;
	bumpSubtree(node: Node, stamp: number): void;
	pushDerived(woken: Set<Observer>): void;
	sweepResources(woken: Set<Observer>): void;
	markResourceStale(schemaNode: SchemaNode, segments: readonly string[], path: string): void;
	advanceVersion(): number;
	nextCommitId(): number;
	notify(woken: Set<Observer> | null, record: Commit): void;
	changePortCount(delta: 1 | -1): void;
}

interface InternalStore {
	readonly [STORE_INTERNALS]: () => StoreInternals;
}

export function internalsOf(store: object): StoreInternals {
	const read = (store as Partial<InternalStore>)[STORE_INTERNALS];
	if (typeof read !== 'function') {
		throw new Error(
			'[segment-state] this is not a Segment store, or it came from an incompatible package copy',
		);
	}
	const internals = read();
	if (internals.v !== 1) {
		throw new Error(
			`[segment-state] unsupported internal store version ${String(internals.v)}; this build reads version 1`,
		);
	}
	return internals;
}
