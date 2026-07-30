import type { SchemaNode } from './schema.js';

/** What a derived node remembered from its last evaluation. */
export interface DerivedCache {
	/** The addresses read during the evaluation, and the values they held. */
	deps: readonly (readonly string[])[];
	depValues: readonly unknown[];
	/**
	 * Per-dep subtree stamp for CONTAINER deps, -1 for leaves. A branch or bulk
	 * value is mutated in place by write-through, so its identity is stable
	 * across every write under it and `Object.is` on the value would never see
	 * a change; the subtree revision does.
	 */
	depVers: readonly number[];
	/** Global version at the last check; an unchanged counter means clean. */
	checkedAt: number;
}

/**
 * Observer storage for one key of a FLAT bulk holder (see `SchemaNode.flat`).
 *
 * The whole point is what is absent: a leaf under a cell-shaped holder can have
 * no children, no derived cache, and no interior walks, so the 12-field trie
 * node it used to get carried mostly nulls. The record doubles as its first
 * observer, the holder's `leaves` map replaces the child map entry, and
 * detaching is one map delete instead of a prune walk. `ver` keeps `revision()`
 * exact for observed keys, which the trie node used to guarantee.
 */
export interface LeafRec extends Observer {
	/** Mutable only so detaching the inline observer can release its closure. */
	cb: () => void;
	/** The key, so a disposer can delete the entry without carrying the map. */
	readonly key: string;
	ver: number;
	/** The interned `.at(key)` descriptor, exactly as `Node.view`. */
	view: unknown;
	/** Observers beyond the first one represented by this record itself. */
	obs: Set<Observer> | null;
}

export interface Observer {
	readonly cb: () => void;
	readonly deep: boolean;
	/** Cleared on dispose so a notification already in flight cannot call it. */
	live: boolean;
	/**
	 * Non-null for an observer of a FLAT holder's key: the record it lives in.
	 * `node` then points at the HOLDER, which is what detach needs to reach the
	 * `leaves` map, and what the deep-ancestor walks start from.
	 */
	leaf: LeafRec | null;
	/**
	 * The node this is registered at.
	 *
	 * Carried HERE rather than captured by the dispose function, so that function closes
	 * over one variable instead of five and needs no context object of its own. One
	 * mounted row allocates a node, an observer, and a disposer, so an allocation saved
	 * per row is 200 saved for a 200-row list.
	 *
	 * The ADDRESS is deliberately not carried: only the resource bookkeeping needs it,
	 * holding the ref kept a second descriptor alive per row (+250 bytes), and holding
	 * its path made `get path` 13.9% of a mount-and-unmount cycle because every
	 * subscription then paid a `segments.join('/')`. A store with resources rebuilds the
	 * path from the node instead, on the one path that needs it.
	 */
	node: Node;
}

const NOOP_OBSERVER = () => {};

/**
 * One materialized point in the store. Nodes exist ONLY where something is
 * observed (or where the schema is bounded and they are pinned) — everything
 * else is read straight out of the enclosing bulk value. The S0 spike measured
 * the difference: 402 nodes instead of 11,000,002 for a million records.
 */
export interface Node {
	seg: string;
	parent: Node | null;
	children: Map<string, Node> | null;
	value: unknown;
	schema: SchemaNode;
	/**
	 * Bumped when anything at or under this node is written. Read back through
	 * `store.revision()`, which is how a subtree consumer decides staleness with
	 * one integer compare instead of diffing a value it never wanted to hold.
	 */
	ver: number;
	/**
	 * The FIRST observer registered here, held directly.
	 *
	 * Almost every observed address has exactly one observer: one component watching
	 * one value. An empty V8 Set costs about 128 bytes, which was the single largest
	 * item in the 987 bytes a mounted row cost, so the Set below is allocated only
	 * when a second observer actually arrives.
	 */
	obs1: Observer | null;
	/**
	 * Observers beyond the first. A Set, not an array: detaching is O(1) instead of an
	 * `indexOf` plus a `splice`, which turns tearing down a widely-observed address
	 * from quadratic into linear. Iteration order is still insertion order.
	 */
	obs: Set<Observer> | null;
	/** How many observers here are deep, so ancestor walks can skip early. */
	deepCount: number;
	/** Eagerly materialized (schema-bounded) nodes are never pruned. */
	pinned: boolean;
	/**
	 * Derived cache, in ONE lazily-created record rather than four inline fields.
	 *
	 * Only a derived node ever has one, and derived nodes are a small minority of
	 * what gets materialized: a mounted list row is a leaf. Three slots saved per
	 * node is ~24 bytes and three fewer stores on the mount path's `createNode`,
	 * for one extra dereference on the derived read path.
	 */
	dcache: DerivedCache | null;
	/**
	 * The accessor descriptor `.at(key)` handed out for this address, interned so a
	 * component re-reading its own address does not rebuild it every render. For a
	 * record that means not rebuilding the whole subtree of accessors per call.
	 * Pruning drops it with the node, so the O(observed) memory property holds, and
	 * ref identity is unspecified by contract, so sharing one is legal.
	 */
	view: unknown;
	/**
	 * Per-key observer records, only ever non-null on a FLAT holder's pinned
	 * node. An entry is deleted with its last observer, so the map stays
	 * O(observed) exactly as pruned trie nodes did.
	 */
	leaves: Map<string, LeafRec> | null;
}

export function createNode(seg: string, parent: Node | null, schema: SchemaNode): Node {
	return {
		seg,
		parent,
		children: null,
		value: undefined,
		schema,
		ver: 0,
		obs1: null,
		obs: null,
		deepCount: 0,
		pinned: false,
		dcache: null,
		view: undefined,
		leaves: null,
	};
}

export function lookupChild(node: Node, seg: string): Node | undefined {
	return node.children === null ? undefined : node.children.get(seg);
}

export function childOf(node: Node, seg: string, schema: SchemaNode): Node {
	let kids = node.children;
	if (kids === null) node.children = kids = new Map();
	let child = kids.get(seg);
	if (child === undefined) kids.set(seg, (child = createNode(seg, node, schema)));
	return child;
}

/**
 * Stamp the write on this node and every ancestor, so a subtree consumer decides
 * whether anything under its address moved with ONE integer compare instead of a
 * set intersection. Depth is bounded by the schema, so this stays O(depth).
 */
export function bumpToRoot(node: Node, version: number): void {
	for (let n: Node | null = node; n !== null; n = n.parent) n.ver = version;
}

/**
 * Wake the observers a write at `node` concerns: everyone registered exactly
 * here, plus the DEEP observers on each ancestor. Observers on unrelated
 * subtrees are never even visited, so cost is O(depth + woken).
 *
 * Writes into the caller's dedup Set directly — an intermediate array here would
 * be one allocation per write in every commit.
 */
export function collectObservers(node: Node, out: Set<Observer>): void {
	if (node.obs1 !== null) {
		if (node.obs1.live) out.add(node.obs1);
		if (node.obs !== null) for (const observer of node.obs) if (observer.live) out.add(observer);
	}
	for (let n = node.parent; n !== null; n = n.parent) {
		if (n.deepCount === 0 || n.obs1 === null) continue;
		if (n.obs1.deep && n.obs1.live) out.add(n.obs1);
		if (n.obs !== null) {
			for (const observer of n.obs) if (observer.deep && observer.live) out.add(observer);
		}
	}
}

/**
 * The one observer a single write would wake, or `null` for none, or `undefined` for
 * "more than one".
 *
 * A one-write commit needs no dedup Set: an observer is registered at exactly one
 * node and each node on the walk is visited once, so a duplicate is unrepresentable.
 * The Set exists for multi-write commits, where two writes really can collect the
 * same ancestor observer. Skipping it here is what makes writing an address nobody
 * observes, and the one-component-one-address case, allocation-free.
 *
 * Collect-then-invoke order is preserved: the caller invokes after this returns, so a
 * callback that unsubscribes another one still cannot corrupt an iteration.
 */
export function soleObserver(node: Node): Observer | null | undefined {
	let found: Observer | null = null;
	if (node.obs1 !== null) {
		if (node.obs1.live) found = node.obs1;
		if (node.obs !== null) {
			for (const observer of node.obs) {
				if (!observer.live) continue;
				if (found !== null) return undefined;
				found = observer;
			}
		}
	}
	for (let n = node.parent; n !== null; n = n.parent) {
		if (n.deepCount === 0 || n.obs1 === null) continue;
		if (n.obs1.deep && n.obs1.live) {
			if (found !== null) return undefined;
			found = n.obs1;
		}
		if (n.obs !== null) {
			for (const observer of n.obs) {
				if (!observer.deep || !observer.live) continue;
				if (found !== null) return undefined;
				found = observer;
			}
		}
	}
	return found;
}

/** `soleObserver` for a write below every materialized node: deep observers only. */
export function soleDeep(node: Node): Observer | null | undefined {
	let found: Observer | null = null;
	for (let n: Node | null = node; n !== null; n = n.parent) {
		if (n.deepCount === 0 || n.obs1 === null) continue;
		if (n.obs1.deep && n.obs1.live) found = n.obs1;
		if (n.obs !== null) {
			for (const observer of n.obs) {
				if (!observer.deep || !observer.live) continue;
				if (found !== null) return undefined;
				found = observer;
			}
		}
	}
	return found;
}

/** Deep observers at this node and above, for a write with no node of its own. */
export function collectDeep(node: Node, out: Set<Observer>): void {
	for (let n: Node | null = node; n !== null; n = n.parent) {
		if (n.deepCount === 0 || n.obs1 === null) continue;
		if (n.obs1.deep && n.obs1.live) out.add(n.obs1);
		if (n.obs !== null) {
			for (const observer of n.obs) if (observer.deep && observer.live) out.add(observer);
		}
	}
}

/** Every observer at or under this node, for a bulk replacement. */
export function collectSubtree(node: Node, out: Set<Observer>): void {
	if (node.obs1 !== null) {
		if (node.obs1.live) out.add(node.obs1);
		if (node.obs !== null) for (const observer of node.obs) if (observer.live) out.add(observer);
	}
	if (node.leaves !== null) for (const rec of node.leaves.values()) collectLeaf(rec, out);
	if (node.children === null) return;
	for (const child of node.children.values()) collectSubtree(child, out);
}

/** Every live observer in one flat-leaf record. */
export function collectLeaf(rec: LeafRec, out: Set<Observer>): void {
	if (rec.live) out.add(rec);
	if (rec.obs !== null) for (const observer of rec.obs) if (observer.live) out.add(observer);
}

/**
 * The one observer a single write to a flat leaf would wake: the record's own
 * observers plus the deep observers on the holder and its ancestors, with the
 * same `null`/`undefined` contract as `soleObserver`.
 */
export function soleLeaf(rec: LeafRec, holder: Node): Observer | null | undefined {
	let found: Observer | null = rec.live ? rec : null;
	if (rec.obs !== null) {
		for (const observer of rec.obs) {
			if (!observer.live) continue;
			if (found !== null) return undefined;
			found = observer;
		}
	}
	for (let n: Node | null = holder; n !== null; n = n.parent) {
		if (n.deepCount === 0 || n.obs1 === null) continue;
		if (n.obs1.deep && n.obs1.live) {
			if (found !== null) return undefined;
			found = n.obs1;
		}
		if (n.obs !== null) {
			for (const observer of n.obs) {
				if (!observer.deep || !observer.live) continue;
				if (found !== null) return undefined;
				found = observer;
			}
		}
	}
	return found;
}

export function addLeafObserver(rec: LeafRec, observer: Observer): void {
	if (rec.obs === null) rec.obs = new Set();
	rec.obs.add(observer);
}

/** Detach the record's inline first observer or one of its overflow observers. */
export function removeLeafObserver(rec: LeafRec, observer: Observer): void {
	if (rec === observer) {
		// `detach` already cleared `live`. If overflow observers keep the record
		// alive, do not let their lifetime retain the first callback's closure.
		if (rec.obs !== null) rec.cb = NOOP_OBSERVER;
	} else if (rec.obs !== null) {
		rec.obs.delete(observer);
		if (rec.obs.size === 0) rec.obs = null;
	}
}

/**
 * Reverse materialization once the last observer leaves, then keep going up
 * through whatever that emptied.
 *
 * Without this, "observed" quietly means "ever observed": the S0 churn
 * measurement showed a scrolling list reaching 40,402 nodes for 200 live
 * observers. This is only sound because writes go THROUGH to the bulk value, so
 * a materialized node is never the sole authority for anything.
 */
export function pruneUp(node: Node): number {
	let removed = 0;
	let n: Node | null = node;
	while (n !== null && n.parent !== null && !n.pinned) {
		if (n.obs1 !== null) break;
		if (n.children !== null && n.children.size > 0) break;
		const parent: Node = n.parent;
		parent.children!.delete(n.seg);
		n.parent = null;
		removed++;
		n = parent;
	}
	return removed;
}

export function addObserver(node: Node, observer: Observer): void {
	if (node.obs1 === null) node.obs1 = observer;
	else {
		if (node.obs === null) node.obs = new Set();
		node.obs.add(observer);
	}
	if (observer.deep) node.deepCount++;
}

export function removeObserver(node: Node, observer: Observer): void {
	if (node.obs1 === observer) {
		// Promote one of the rest into the direct slot, so a node that drops back to a
		// single observer stops paying for the Set as well.
		node.obs1 = null;
		if (node.obs !== null) {
			for (const next of node.obs) {
				node.obs1 = next;
				node.obs.delete(next);
				break;
			}
			if (node.obs.size === 0) node.obs = null;
		}
	} else if (node.obs === null || !node.obs.delete(observer)) return;
	else if (node.obs.size === 0) node.obs = null;
	if (observer.deep) node.deepCount--;
}

export function hasObservers(node: Node): boolean {
	return node.obs1 !== null;
}

/** Count every live node, for tests and diagnostics. A flat-leaf record counts
 * as a node: it is the same "materialized point per observed address", stored
 * flatter. */
export function countNodes(root: Node): number {
	let total = 1;
	if (root.leaves !== null) total += root.leaves.size;
	if (root.children !== null)
		for (const child of root.children.values()) total += countNodes(child);
	return total;
}
