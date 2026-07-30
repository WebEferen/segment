import {
	ACTION,
	BRANCH,
	BULK,
	BULK_LIST,
	BULK_SEGMENT,
	CELL,
	DERIVED,
	RESOURCE,
	TASK,
	DERIVE_PREFIX,
	FETCH_PREFIX,
	normalizeResource,
	compileSchema,
	installImpls,
	missingImpls,
	resolveSchema,
	type SchemaNode,
} from './schema.js';
import {
	addObserver,
	bumpToRoot,
	childOf,
	collectDeep,
	collectObservers,
	soleDeep,
	soleObserver,
	collectSubtree,
	countNodes,
	createNode,
	hasObservers,
	lookupChild,
	pruneUp,
	removeObserver,
	type Node,
	type Observer,
} from './node.js';
import type {
	Act,
	AddressKind,
	Commit,
	DehydrateOptions,
	Dispose,
	Get,
	HydrateOptions,
	HydrateResult,
	Impl,
	Payload,
	LiveContext,
	LoadContext,
	ObserveOptions,
	Port,
	PortContext,
	Ref,
	ResourceImpl,
	ResourceSnapshot,
	SaveContext,
	TaskContext,
	Tx,
	View,
	Write,
} from './types.js';

function fail(message: string): never {
	throw new Error(`[@octanejs/segment] ${message}`);
}

// ── Refs ────────────────────────────────────────────────────────────────────
//
// A ref is a value object, not an identity. Refs built through a dynamic
// segment are NOT interned: an unbounded key space would make an intern table
// grow without bound, which is exactly the `atomFamily` leak this design exists
// to avoid. Equality is `path` equality, and that is the documented contract.

/**
 * Holds the store a ref belongs to. Indirect because the accessor tree is built
 * before the store object exists, and direct because a renderer binding should
 * be able to write `useValue(ref)` with no provider and no context lookup — the
 * ref already knows where it lives.
 */
interface StoreHolder {
	store: unknown;
}

/** A resolved bulk holder: the node that owns the opaque value, and where its keys start. */
interface BulkAt {
	node: Node;
	start: number;
}

interface RefInternals {
	segments: readonly string[];
	holder: StoreHolder;
	/** The joined path, once something asked for it. */
	joined?: string;
	/**
	 * Resolution memoized on first use.
	 *
	 * Both are invariant for a path: `installImpls` mutates a schema node in place
	 * rather than replacing it, `derive`/`resourceOf` only ADD siblings, and a bulk
	 * holder is pinned for the store's lifetime. So a ref held across writes pays
	 * the schema walk and the bulk walk exactly once, and a fresh ref pays them
	 * once, which is what it would have paid anyway.
	 */
	schema: unknown;
	bulk: unknown;
	bulkResolved: boolean;
}

/**
 * Registry symbol, NOT `instanceof`. Two copies of this module — a duplicated
 * package in `node_modules`, a bundler that resolves `./store.js` and
 * `./index.js → ./store.js` to different ids — would be two distinct classes, and
 * an `instanceof` contract would silently report every ref as ownerless. A
 * `Symbol.for` key is shared across every copy, so the contract survives.
 */
const REF_INTERNALS = /* @__PURE__ */ Symbol.for('@octanejs/segment.ref');

/** Placeholder for a reused staged record between transactions. */
const EMPTY_SEGMENTS: readonly string[] = [];

/** Stand-in for a commit's write list when nobody is subscribed to read it. */
const NO_WRITES: Write[] = [];

/**
 * A ref carries its own internals rather than pointing at a second object, and
 * declares every field in the constructor.
 *
 * Both details are measured, not stylistic. `.at()` on a segment allocates a ref per
 * call, so one object instead of two is a third of that path's garbage; and assigning
 * the memo fields later would transition the hidden class on first use, which showed
 * up as the fresh-`.at()` case getting SLOWER when memoization was added.
 *
 * `path` is a getter: a write that nobody is listening to never needs the string, and
 * joining it eagerly was pure cost on the hot path.
 */
class RefImpl {
	readonly [REF_INTERNALS]: RefInternals;
	segments: readonly string[];
	holder: StoreHolder;
	schema: unknown = undefined;
	bulk: unknown = undefined;
	bulkResolved = false;
	joined: string | undefined = undefined;

	constructor(path: string | undefined, segments: readonly string[], holder: StoreHolder) {
		this.segments = segments;
		this.holder = holder;
		this.joined = path;
		this[REF_INTERNALS] = this;
	}

	get path(): string {
		return this.joined ?? (this.joined = this.segments.join('/'));
	}
}

function internalsOf(ref: object): RefInternals | undefined {
	return (ref as Record<symbol, RefInternals | undefined>)[REF_INTERNALS];
}

/**
 * The store a ref addresses, for a renderer binding. Returns null for a ref the
 * caller hand-built from a path string, which is legal but carries no owner.
 */
export function storeOf(ref: { path: string }): unknown {
	const internals = internalsOf(ref as object);
	return internals === undefined ? null : internals.holder.store;
}

/**
 * Internal view of a ref. `Ref<T>`'s phantom field is deliberately INVARIANT so
 * that a `Ref<number>` cannot be passed where a `Ref<string>` is wanted; that
 * also means `Ref<T>` is not assignable to `Ref<unknown>`, so the core's own
 * plumbing addresses refs structurally instead of widening the value type.
 */
interface AnyRef {
	readonly path: string;
}

function refSegments(ref: AnyRef): readonly string[] {
	// A parameterized resource's address is a FUNCTION that is also a ref, so the
	// internals lookup comes before any typeof check.
	if (ref !== null && (typeof ref === 'object' || typeof ref === 'function')) {
		const internals = internalsOf(ref as object);
		if (internals !== undefined) return internals.segments;
		if (typeof (ref as { path?: unknown }).path === 'string') return ref.path.split('/');
	}
	return fail(`expected a ref; received ${JSON.stringify(ref)}`);
}

// ── Store ───────────────────────────────────────────────────────────────────

interface StagedWrite {
	readonly path: string;
	readonly segments: readonly string[];
	value: unknown;
	/**
	 * The ref this was staged through, when there was one. A commit resolves the
	 * schema node and the bulk holder for every staged write, and both answers are
	 * memoized ON the ref, so carrying it turns two walks per write into two reads.
	 * Absent for `patch`, which stages leaves the caller never named individually.
	 */
	readonly ref?: AnyRef;
}

interface WatchEntry {
	readonly pattern: readonly string[];
	readonly cb: (path: string) => void;
	readonly owner: PortRecord | null;
}

interface PortRecord {
	readonly port: Port;
	detach: (() => void) | null;
	live: boolean;
}

export interface StoreStats {
	/** Live trie nodes. Bounded by what is observed, not by how much data exists. */
	readonly nodes: number;
	readonly observedDerived: number;
	readonly ports: number;
	/** Transient resource entries: in flight, failed, stale, observed, or pushed to. */
	readonly resources: number;
}

export interface Store<S> {
	/** The typed accessor tree. Kept off the store object so a schema key named `get` cannot shadow the API. */
	readonly state: View<S>;
	/**
	 * Supply the implementations for everything the shape declared as computed:
	 * derivations, resources, and actions.
	 *
	 * It is a separate call for a measured reason. A callback written INSIDE the
	 * shape literal cannot see the type being inferred from that literal —
	 * TypeScript collapses it to `never`. Here the shape is already resolved, so
	 * `s` is simply in scope and no callback needs a `root` parameter.
	 *
	 * Optional: a store of plain data never calls it. The returned object is this
	 * same store, so the whole definition stays one expression.
	 */
	with(fn: (s: View<S>, act: Act) => Impl<S>): Store<S>;
	get<T>(ref: Ref<T>): T;
	/**
	 * One write, as its own commit. Sugar for `act((tx) => tx.set(ref, value))`,
	 * which is what the vast majority of writes are. Reach for `act` when several
	 * writes have to land together.
	 */
	set<T>(ref: Ref<T>, value: T, source?: string): void;
	/** One read-modify-write, as its own commit. */
	update<T>(ref: Ref<T>, fn: (prev: T) => T, source?: string): void;
	/**
	 * Write several values under one address, as ONE commit. The keys you provide
	 * are written and the rest are left alone, so adding a field and overwriting a
	 * whole record are the same call. See `Tx.patch`.
	 */
	patch<V>(ref: { readonly path: string }, values: V, source?: string): void;
	act(fn: (tx: Tx) => void, source?: string): void;
	observe<T>(ref: Ref<T>, cb: () => void, options?: ObserveOptions): Dispose;
	/** Resolve a path string, as an external service would. Throws on a path the schema does not describe. */
	ref(path: string): Ref<unknown>;
	/**
	 * A number that changes whenever anything AT OR UNDER this address is written.
	 * Comparing it against a previously held one is an O(1) staleness check for a
	 * whole subtree, which is what a renderer binding wants when it reads a branch
	 * rather than a single value.
	 *
	 * Conservative for an address nothing observes: with no node there, the nearest
	 * materialized ancestor's stamp is reported, so the answer can move when a
	 * SIBLING changed. Never the other way round, so a consumer may see a spurious
	 * change but never miss a real one.
	 */
	revision<T>(ref: Ref<T>): number;
	/**
	 * What kind of thing an address names. A renderer binding needs this to pick
	 * its subscription strategy: a leaf can be gated on its VALUE, while a branch
	 * has to be gated on `revision` — writes go through to the bulk value in
	 * place, so a branch's object identity does not change when its contents do.
	 */
	kindOf<T>(ref: Ref<T>): AddressKind;
	/**
	 * An anonymous derivation, for a computed value you do not want to name in the
	 * schema. Create it ONCE, outside render, and read it like any other address:
	 *
	 * ```ts
	 * export const itemCount = store.derive((get) => get(s.cart.items).length);
	 * // in a component: useValue(itemCount)
	 * ```
	 *
	 * Deliberately not a hook. A selector evaluated during render re-runs per
	 * component on every commit that touches its inputs, and one returning a fresh
	 * object re-renders every time. Created here instead, it is cached once,
	 * shared by every reader, and gated by the same equality check a declared
	 * derivation gets.
	 */
	derive<T>(fn: (get: Get) => T): Ref<T, 'derived'>;
	/**
	 * A fetched value with no slot in the schema, so a standalone exported function
	 * can be the loader:
	 *
	 * ```ts
	 * export const search = store.resourceOf(async ({ args: [q, page] }) => …);
	 * // in a component: useResource(search('ada', 2))
	 * ```
	 *
	 * Same rules as a declared `resource()`: the arguments become path segments, so
	 * the cache is per argument set and staleness, dehydrate, and ports need no
	 * special case. Create it ONCE, outside render, and `release` it if it is per
	 * component instance.
	 */
	resourceOf<T, A extends readonly unknown[] = []>(
		impl: ResourceImpl<T, A>,
	): A extends readonly [] ? Ref<T, 'resource'> : (...args: A) => Ref<T, 'resource'>;
	/**
	 * Drop an anonymous derivation created by `derive`. A module-level one lives for
	 * the process and never needs this; one created PER COMPONENT INSTANCE does, or
	 * a thousand-row list would leave a thousand dead derivations behind.
	 */
	release<T>(ref: Ref<T>): void;

	/**
	 * Read a resource, starting its load on first touch. Everything a consumer
	 * needs is on the snapshot, including the promise to suspend on, so there is
	 * no `isLoading` boolean to get wrong.
	 */
	resource<T>(ref: Ref<T>): ResourceSnapshot<T>;
	/** Force a reload, superseding any in-flight one. */
	refresh<T>(ref: Ref<T>): Promise<T>;
	/**
	 * Write a resource back through its `save`. The value is applied immediately
	 * and restored if `save` rejects: an optimistic update is just a transaction
	 * that has not confirmed remotely yet.
	 */
	save<T>(ref: Ref<T>, value: T): Promise<void>;
	/** Drop a resource's cached value and transient state, aborting any load. */
	forget<T>(ref: Ref<T>): void;

	/**
	 * Snapshot the store as a flat path-to-value map, for a server render.
	 * Derivations and actions are omitted: one is recomputed on arrival, the other
	 * is code. Use `include` to ship only a static slice, which is what partial
	 * prerendering needs.
	 */
	dehydrate(options?: DehydrateOptions): Payload;
	/**
	 * Adopt a payload as ONE commit, so observers and ports see a single
	 * transition rather than a storm. A resource value that arrives this way is
	 * `ready` without fetching; past `maxAge` it is `ready` and `stale`, so the
	 * first paint uses it and the refresh happens behind it.
	 *
	 * Also the apply half of a server round trip: a server function returns a
	 * payload and the client adopts it. **Pass `allow` for anything that came off
	 * the wire** — without it a response can write any address in the store.
	 */
	hydrate(payload: Payload, options?: HydrateOptions): HydrateResult;

	attach(port: Port): Dispose;
	commits(cb: (commit: Commit) => void): Dispose;
	stats(): StoreStats;
}

/** A commit that re-enters more than this many times is not converging. */
const REENTRANCY_LIMIT = 50;

/**
 * Read ONCE at module load. `process.env` is not a plain object in Node: every
 * property access reads the real environment, and doing that per write cost 12x on
 * the write benchmark before this was hoisted.
 */
const DEV = process.env.NODE_ENV !== 'production';

/**
 * Name a commit after the function that caused it, for devtools and a port's commit
 * stream.
 *
 * Guarded twice, because deriving this is not free: capturing a stack is one of the
 * most expensive things V8 does and a write is the hottest path there is. So it
 * happens only in development, and only when something is actually subscribed to
 * commits — if nobody is watching, nobody needs the name. Production always reports
 * the fallback, and a function name would be minified away there anyway.
 *
 * An explicitly passed source always wins over this.
 */
function callerName(fallback: string): string {
	const stack = new Error().stack;
	if (stack === undefined) return fallback;
	const lines = stack.split('\n');
	for (let i = 1; i < lines.length; i++) {
		const line = lines[i];
		// Skip our own frames: the first one outside this module is the caller.
		if (line.includes('segment/src/core/') || line.includes('segment\\src\\core\\')) continue;
		const match = /at (?:async )?([\w$.]+)/.exec(line);
		const name = match?.[1];
		if (name === undefined || name === 'Object' || name === 'Module') return fallback;
		return name;
	}
	return fallback;
}

export function createStore<S>(shape: S): Store<S> {
	const schema = compileSchema(shape);
	const root = createNode('', null, schema);
	root.pinned = true;

	const holder: StoreHolder = { store: null };
	let version = 0;
	let commitId = 0;
	let notifying = false;
	let reentrancy = 0;
	let deferred: Map<string, StagedWrite> | null = null;
	let deferredSource = 'reentrant';
	const evaluating = new Set<string>();
	const observedDerived = new Set<Node>();
	const commitSubs = new Set<(commit: Commit) => void>();
	const watches = new Set<WatchEntry>();
	/**
	 * Watch patterns bucketed by their first LITERAL segment, plus one bucket for
	 * patterns that start with a wildcard and therefore always apply. Without this,
	 * a commit costs O(patterns x writes); with it, each write consults only the
	 * handful of patterns that could possibly match its root.
	 */
	const watchIndex = new Map<string, Set<WatchEntry>>();
	const WATCH_ANY = '\u0000any';

	function indexWatch(entry: WatchEntry): void {
		const head = entry.pattern[0];
		const bucket = head === '*' || head === '**' ? WATCH_ANY : head;
		let set = watchIndex.get(bucket);
		if (set === undefined) watchIndex.set(bucket, (set = new Set()));
		set.add(entry);
	}

	function unindexWatch(entry: WatchEntry): void {
		const head = entry.pattern[0];
		const bucket = head === '*' || head === '**' ? WATCH_ANY : head;
		const set = watchIndex.get(bucket);
		if (set === undefined) return;
		set.delete(entry);
		if (set.size === 0) watchIndex.delete(bucket);
	}
	const ports = new Set<PortRecord>();

	// ── Eager materialization of the schema-bounded part ────────────────────
	// Nodes above every bulk holder are bounded by the schema, so materializing
	// them once costs a fixed, tiny amount and removes a whole class of
	// special-casing from the read path.
	function materializeFixed(schemaNode: SchemaNode, node: Node): void {
		node.pinned = true;
		if (schemaNode.kind === CELL) {
			node.value = schemaNode.init;
			return;
		}
		if (schemaNode.kind === BULK) {
			node.value = schemaNode.bulk === BULK_LIST ? [] : Object.create(null);
			return; // contents are lazy by construction
		}
		if (schemaNode.children === null) return;
		for (const [key, child] of schemaNode.children) {
			materializeFixed(child, childOf(node, key, child));
		}
	}
	materializeFixed(schema, root);

	// ── Resolution ──────────────────────────────────────────────────────────

	/**
	 * The outermost bulk holder on this path, plus the index at which its plain
	 * value takes over addressing. Everything below a bulk holder lives in that
	 * holder's opaque value, including nested bulk holders.
	 */
	function bulkRoot(segments: readonly string[]): { node: Node; start: number } | null {
		let schemaNode = schema;
		let node = root;
		for (let i = 0; i < segments.length; i++) {
			// A parameterized resource stores one value per argument set, which is the
			// same shape as a segment: one opaque container, keyed, materializing only
			// what is observed.
			if (schemaNode.kind === BULK || (schemaNode.kind === RESOURCE && schemaNode.arity > 0)) {
				return { node, start: i };
			}
			const childSchema = schemaNode.children?.get(segments[i]);
			if (childSchema === undefined) return null;
			const childNode = lookupChild(node, segments[i]);
			if (childNode === undefined) return null;
			schemaNode = childSchema;
			node = childNode;
		}
		return schemaNode.kind === BULK || (schemaNode.kind === RESOURCE && schemaNode.arity > 0)
			? { node, start: segments.length }
			: null;
	}

	function findNode(segments: readonly string[]): Node | null {
		let node = root;
		for (let i = 0; i < segments.length; i++) {
			const child = lookupChild(node, segments[i]);
			if (child === undefined) return null;
			node = child;
		}
		return node;
	}

	/** The schema node for a ref, memoized on the ref itself. */
	function schemaOf(ref: AnyRef, segments: readonly string[]): SchemaNode | null {
		const internals = internalsOf(ref as object);
		if (internals === undefined) return resolveSchema(schema, segments);
		if (internals.schema === undefined) internals.schema = resolveSchema(schema, segments) ?? null;
		return internals.schema as SchemaNode | null;
	}

	/** The bulk holder for a ref, memoized on the ref itself. */
	function bulkOf(ref: AnyRef, segments: readonly string[]): { node: Node; start: number } | null {
		const internals = internalsOf(ref as object);
		if (internals === undefined) return bulkRoot(segments);
		if (internals.bulkResolved !== true) {
			internals.bulk = bulkRoot(segments);
			internals.bulkResolved = true;
		}
		return internals.bulk as { node: Node; start: number } | null;
	}

	function readSegments(segments: readonly string[]): unknown {
		const schemaNode = resolveSchema(schema, segments);
		if (schemaNode === null) return undefined;
		if (schemaNode.kind === DERIVED) return evaluateDerived(segments, schemaNode);
		return readValue(segments, schemaNode);
	}

	/**
	 * Reads always resolve through the bulk value, never through a materialized
	 * node's cached copy. That is sound precisely because writes go through to
	 * the bulk, and it removes any possibility of a stale materialized read.
	 */
	function readValue(segments: readonly string[], schemaNode: SchemaNode): unknown {
		return readAt(bulkRoot(segments), segments, schemaNode);
	}

	/** The read, with the bulk holder already resolved, so a caller can resolve once. */
	function readAt(
		bulk: { node: Node; start: number } | null,
		segments: readonly string[],
		schemaNode: SchemaNode,
	): unknown {
		if (bulk === null) {
			const node = findNode(segments);
			return node === null ? fallback(schemaNode) : node.value;
		}
		let value = bulk.node.value;
		for (let i = bulk.start; i < segments.length; i++) {
			if (value === null || typeof value !== 'object') return fallback(schemaNode);
			value = (value as Record<string, unknown>)[segments[i]];
		}
		return value === undefined ? fallback(schemaNode) : value;
	}

	function fallback(schemaNode: SchemaNode): unknown {
		return schemaNode.kind === CELL ? schemaNode.init : undefined;
	}

	// ── Derivations ─────────────────────────────────────────────────────────
	//
	// Push marks nothing; evaluation pulls. A cached value is trusted outright
	// while the global version has not moved (nothing was written at all), and
	// only after a commit are its dependencies re-read.

	function evaluateDerived(segments: readonly string[], schemaNode: SchemaNode): unknown {
		const node = findNode(segments);
		if (node !== null && node.hasCache) {
			if (node.checkedAt === version) return node.value;
			if (depsUnchanged(node)) {
				node.checkedAt = version;
				return node.value;
			}
		}
		// Joined below the cache check: the path is only needed to name an error and to
		// key the cycle guard, and reading a clean derivation is a hot path.
		const path = segments.join('/');
		if (schemaNode.derive === null) {
			fail(`derived "${path}" has no implementation; supply it in .with()`);
		}
		if (evaluating.has(path)) fail(`derived "${path}" depends on itself`);
		evaluating.add(path);
		const deps: (readonly string[])[] = [];
		const depValues: unknown[] = [];
		const get: Get = (<T>(ref: Ref<T>): T => {
			const depSegments = refSegments(ref);
			const value = readSegments(depSegments);
			deps.push(depSegments);
			depValues.push(value);
			return value as T;
		}) as Get;
		let value: unknown;
		try {
			value = schemaNode.derive!(get);
		} finally {
			evaluating.delete(path);
		}
		if (node !== null) {
			node.value = value;
			node.deps = deps;
			node.depValues = depValues;
			node.checkedAt = version;
			node.hasCache = true;
		}
		return value;
	}

	function depsUnchanged(node: Node): boolean {
		const deps = node.deps;
		const values = node.depValues;
		if (deps === null || values === null) return false;
		for (let i = 0; i < deps.length; i++) {
			if (!Object.is(readSegments(deps[i]), values[i])) return false;
		}
		return true;
	}

	function nodeSegments(node: Node): string[] {
		const out: string[] = [];
		for (let n: Node | null = node; n !== null && n.parent !== null; n = n.parent)
			out.unshift(n.seg);
		return out;
	}

	// ── Writes ──────────────────────────────────────────────────────────────

	function writeThrough(segments: readonly string[], value: unknown): void {
		writeAt(bulkRoot(segments), segments, value);
	}

	/** The write, with the bulk holder already resolved. */
	function writeAt(
		bulk: { node: Node; start: number } | null,
		segments: readonly string[],
		value: unknown,
	): void {
		if (bulk === null) {
			const node = findNode(segments);
			if (node === null) fail(`no such path "${segments.join('/')}"`);
			node.value = value;
			return;
		}
		// A parameterized resource's container appears on its first write; a plain
		// resource never reaches here with one.
		if (bulk.node.value === null || typeof bulk.node.value !== 'object') {
			bulk.node.value = Object.create(null);
		}
		let container = bulk.node.value as Record<string, unknown>;
		for (let i = bulk.start; i < segments.length - 1; i++) {
			let next = container[segments[i]];
			if (next === null || typeof next !== 'object') {
				next = Object.create(null) as Record<string, unknown>;
				container[segments[i]] = next;
			}
			container = next as Record<string, unknown>;
		}
		if (bulk.start < segments.length) container[segments[segments.length - 1]] = value;
		else bulk.node.value = value;
	}

	function wakeForWrite(segments: readonly string[], out: Set<Observer>): void {
		let node = root;
		let i = 0;
		for (; i < segments.length; i++) {
			const child = lookupChild(node, segments[i]);
			if (child === undefined) break;
			node = child;
		}
		bumpToRoot(node, version);
		if (i === segments.length) {
			collectObservers(node, out);
		} else {
			// Nothing is materialized at the written path, so only subtree
			// observers can care. Reaching here allocates nothing.
			collectDeep(node, out);
		}
	}

	/**
	 * One reusable frame per nesting depth. `createTx` allocates a Map and seven
	 * closures, and an action that sets a single field used to pay all of it per call.
	 * Depth rather than one slot because an action may call another action, and the
	 * inner one must not stage into the outer one's write set.
	 */
	interface TxFrame {
		/** Used from the SECOND write on; a one-write transaction never touches it. */
		readonly writes: Map<string, StagedWrite>;
		/**
		 * The first staged write, in a record reused across transactions.
		 *
		 * An action that writes one address is the common case, and routing it through
		 * the Map cost 26 ns and 152 bytes per act: V8's ordered hash table churns its
		 * backing store on an insert-then-clear cycle whether you clear it or delete the
		 * entry. Measured against a small array instead, the Map won at one write and
		 * lost from three, so the answer was neither container but no container.
		 */
		readonly only: {
			path: string;
			segments: readonly string[];
			value: unknown;
			ref: AnyRef | undefined;
		};
		/** 0 or 1 while `only` holds everything; irrelevant once spilled. */
		count: number;
		/** True once a second distinct address arrived and the Map took over. */
		spilled: boolean;
		tx: Tx;
		/** False once the frame's act has returned, so a retained `tx` is loud. */
		active: boolean;
	}

	const txFrames: TxFrame[] = [];
	let txDepth = 0;

	function createTx(frame: TxFrame): Tx {
		// Neither container is ever replaced, only reset, so capturing them once is safe.
		const writes = frame.writes;
		const only = frame.only;

		/** Stage one already-validated write, spilling to the Map on the second address. */
		const put = (
			path: string,
			segments: readonly string[],
			value: unknown,
			ref: AnyRef | undefined,
		): void => {
			if (!frame.spilled) {
				if (frame.count === 0) {
					only.path = path;
					only.segments = segments;
					only.value = value;
					only.ref = ref;
					frame.count = 1;
					return;
				}
				if (only.path === path) {
					only.value = value;
					return;
				}
				// A copy, not the reused record: this one outlives the frame's next act if a
				// re-entrant commit defers it.
				writes.set(only.path, {
					path: only.path,
					segments: only.segments,
					value: only.value,
					ref: only.ref,
				});
				frame.spilled = true;
			}
			const existing = writes.get(path);
			if (existing !== undefined) existing.value = value;
			else writes.set(path, { path, segments, value, ref });
		};

		/** The staged value for an address, or `undefined` when nothing staged it. */
		const staged = (path: string): { value: unknown } | undefined => {
			if (!frame.spilled) return frame.count === 1 && only.path === path ? only : undefined;
			return writes.get(path);
		};
		// A `tx` that outlives its act (the classic case is using one after an `await`)
		// would otherwise stage into whatever transaction is running NOW. Reusing the
		// frame is what makes that reachable, so it is refused rather than silent.
		const live = (): void => {
			if (!frame.active) {
				fail(
					'this transaction has already finished; a tx is only usable inside the act() ' +
						'or action that received it (using one after an await is the common cause)',
				);
			}
		};
		const stage = (ref: AnyRef, value: unknown): void => {
			live();
			const segments = refSegments(ref);
			const schemaNode = resolveSchema(schema, segments);
			if (schemaNode === null) fail(`no such path "${ref.path}"`);
			if (schemaNode.kind === DERIVED) fail(`"${ref.path}" is derived and cannot be written`);
			if (schemaNode.kind === ACTION || schemaNode.kind === TASK) {
				fail(`"${ref.path}" is an action and cannot be written`);
			}
			// A resource's value is owned by its loader. Writing it directly would
			// leave the status machine claiming a value the store no longer holds,
			// so the write-back path is `save()`, which keeps the two in step.
			if (schemaNode.kind === RESOURCE) {
				fail(`"${ref.path}" is a resource; use save() to write it back`);
			}
			// Replacing a whole bulk value through an ordinary write would reach only
			// the observers registered ON the holder, silently leaving every
			// materialized descendant's observer stale. `replaceAll` is the operation
			// that re-seeds and wakes them, so route the caller there instead of
			// offering a second path that is quietly wrong.
			if (schemaNode.kind === BULK) {
				fail(
					`"${ref.path}" is a bulk holder; use replaceAll() to swap its contents ` +
						'so materialized observers are re-seeded',
				);
			}
			// A group holds no value of its own — its children do. Writing one directly
			// would store a value nothing ever reads, so route the caller to `patch`,
			// which writes the children and therefore wakes their observers.
			if (schemaNode.kind === BRANCH) {
				fail(`"${ref.path}" groups other values; use patch() to write them`);
			}
			put(ref.path, segments, value, ref);
		};
		/**
		 * Walk a partial value against the schema and stage one write per leaf, so
		 * every observer that cares is woken exactly as if the writes were made one
		 * by one. Keys absent from `values` are not touched.
		 */
		const patch = (ref: AnyRef, values: unknown): void => {
			live();
			const segments = refSegments(ref);
			const schemaNode = resolveSchema(schema, segments);
			if (schemaNode === null) fail(`no such path "${ref.path}"`);
			const walk = (node: SchemaNode, path: string, segs: readonly string[], value: unknown) => {
				if (node.kind === CELL) {
					put(path, segs, value, undefined);
					return;
				}
				if (node.kind === DERIVED || node.kind === RESOURCE) {
					fail(`"${path}" is computed by the store, so patch() cannot write it`);
				}
				if (node.kind === ACTION || node.kind === TASK) {
					fail(`"${path}" is something you call, so patch() cannot write it`);
				}
				if (value === null || typeof value !== 'object') {
					fail(`"${path}" groups other values, so patch() needs an object here`);
				}
				for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
					const childSchema =
						node.kind === BULK ? node.dynamic! : (node.children?.get(key) ?? null);
					if (childSchema === null) fail(`no such path "${path === '' ? key : `${path}/${key}`}"`);
					walk(childSchema, path === '' ? key : `${path}/${key}`, [...segs, key], child);
				}
			};
			walk(schemaNode, ref.path, segments, values);
		};

		return {
			set: (ref, value) => stage(ref, value),
			patch: (ref, values) => patch(ref as AnyRef, values),
			update: (ref, fn) => {
				live();
				const pending = staged(ref.path);
				const previous = pending !== undefined ? pending.value : readSegments(refSegments(ref));
				stage(ref, (fn as (p: unknown) => unknown)(previous));
			},
			get: <T>(ref: Ref<T>): T => {
				live();
				const pending = staged(ref.path);
				return (pending !== undefined ? pending.value : readSegments(refSegments(ref))) as T;
			},
		};
	}

	/** The schema node for a staged write, through the ref's memo when there is one. */
	function stagedSchema(staged: StagedWrite): SchemaNode {
		return staged.ref === undefined
			? resolveSchema(schema, staged.segments)!
			: schemaOf(staged.ref, staged.segments)!;
	}

	function stagedBulk(staged: StagedWrite): { node: Node; start: number } | null {
		return staged.ref === undefined
			? bulkRoot(staged.segments)
			: bulkOf(staged.ref, staged.segments);
	}

	/**
	 * Commit ONE staged write. It needs neither the dedup Set nor the record array a
	 * multi-write commit does, and an ordinary action is exactly this.
	 */
	function commitOne(staged: StagedWrite, source: string): void {
		const bulk = stagedBulk(staged);
		const prev = readAt(bulk, staged.segments, stagedSchema(staged));
		if (Object.is(prev, staged.value)) return;
		applyWrite(staged, staged.segments, bulk, prev, staged.value, source);
	}

	function commit(writes: Map<string, StagedWrite>, source: string): void {
		if (writes.size === 0) return;
		if (writes.size === 1) {
			for (const staged of writes.values()) commitOne(staged, source);
			return;
		}
		version++;
		// The per-write records are only ever read by a commit subscriber or a watch
		// pattern. With neither attached, building them is allocation nobody reads, so
		// only the count is kept.
		const listening = commitSubs.size > 0 || watchIndex.size > 0;
		const applied: Write[] = listening ? [] : NO_WRITES;
		let changed = 0;
		const woken = new Set<Observer>();

		for (const staged of writes.values()) {
			const prev = readAt(stagedBulk(staged), staged.segments, stagedSchema(staged));
			if (Object.is(prev, staged.value)) continue;
			writeThrough(staged.segments, staged.value);
			changed++;
			if (listening) applied.push({ path: staged.path, prev, next: staged.value });
			wakeForWrite(staged.segments, woken);
		}

		if (changed === 0) return;

		pushDerived(woken);
		if (resourceStates.size > 0) sweepResources(woken);

		const record: Commit = { id: ++commitId, source, writes: applied };
		notify(woken, record);
	}

	/**
	 * An observed derivation is the only thing that has to be PUSHED: its readers
	 * subscribed to a value nobody wrote directly, so nothing else would wake them.
	 */
	function pushDerived(woken: Set<Observer>): void {
		for (const node of observedDerived) {
			const previous = node.hasCache ? node.value : undefined;
			const had = node.hasCache;
			const next = evaluateDerived(nodeSegments(node), node.schema);
			if (had && Object.is(previous, next)) continue;
			bumpToRoot(node, version);
			collectObservers(node, woken);
		}
	}

	function notify(woken: Set<Observer> | null, record: Commit): void {
		notifying = true;
		try {
			if (woken !== null) for (const observer of woken) if (observer.live) observer.cb();
			// The spread exists so a subscriber that unsubscribes mid-pass cannot skip
			// the next one. Paying for it with nobody subscribed is pure waste.
			if (commitSubs.size > 0) for (const sub of [...commitSubs]) isolate(sub, record, null);
			if (watchIndex.size > 0) {
				for (const write of record.writes) {
					const head = write.path.slice(0, indexOfSlash(write.path));
					const exact = watchIndex.get(head);
					const any = watchIndex.get(WATCH_ANY);
					if (exact !== undefined) {
						for (const entry of [...exact]) {
							if (matches(entry.pattern, write.path)) isolate(entry.cb, write.path, entry.owner);
						}
					}
					if (any !== undefined) {
						for (const entry of [...any]) {
							if (matches(entry.pattern, write.path)) isolate(entry.cb, write.path, entry.owner);
						}
					}
				}
			}
		} finally {
			notifying = false;
		}
		flushDeferred();
	}

	/**
	 * Wake observers WITHOUT a commit record. A resource moving between pending,
	 * ready, and error changes what a reader sees while writing no state, and
	 * emitting an empty commit for it would put noise in every port's stream.
	 */
	function wakeOnly(woken: Set<Observer>): void {
		if (woken.size === 0) return;
		notifying = true;
		try {
			for (const observer of woken) if (observer.live) observer.cb();
		} finally {
			notifying = false;
		}
		flushDeferred();
	}

	function flushDeferred(): void {
		const pending = deferred;
		if (pending !== null) {
			deferred = null;
			if (++reentrancy > REENTRANCY_LIMIT) {
				reentrancy = 0;
				fail(
					`a commit re-entered ${REENTRANCY_LIMIT} times without settling; ` +
						'an observer or port is writing state that re-triggers it',
				);
			}
			try {
				commit(pending, deferredSource);
			} finally {
				reentrancy = 0;
			}
		}
	}

	/**
	 * A callback handed to us by a consumer must not be able to break the store.
	 * A throwing port is detached, because leaving a broken port subscribed means
	 * every future commit throws in the same place.
	 */
	function isolate<A>(fn: (arg: A) => void, arg: A, owner: PortRecord | null): void {
		try {
			fn(arg);
		} catch (error) {
			if (owner !== null) detachPort(owner);
			reportError(error, owner);
		}
	}

	function reportError(error: unknown, owner: PortRecord | null): void {
		const where = owner === null ? 'a commit subscriber' : `port "${owner.port.name}"`;
		// eslint-disable-next-line no-console
		console.error(`[@octanejs/segment] ${where} threw and was isolated:`, error);
	}

	function indexOfSlash(path: string): number {
		const at = path.indexOf('/');
		return at < 0 ? path.length : at;
	}

	function matches(pattern: readonly string[], path: string): boolean {
		const segments = path.split('/');
		let p = 0;
		let s = 0;
		while (p < pattern.length) {
			const token = pattern[p];
			if (token === '**') return s < segments.length;
			if (s >= segments.length) return false;
			if (token !== '*' && token !== segments[s]) return false;
			p++;
			s++;
		}
		return s === segments.length;
	}

	// ── Resources ───────────────────────────────────────────────────────────
	//
	// A resource's settled VALUE travels the ordinary commit path, so observers,
	// ports, and `revision` treat it exactly like a cell. Only the transient part
	// (in flight, failed, stale) lives here, which is why the map is bounded by
	// activity rather than by how much has ever been fetched.

	interface ResourceState {
		status: 'pending' | 'ready' | 'error';
		promise: Promise<unknown> | null;
		error: unknown;
		controller: AbortController | null;
		segments: readonly string[];
		deps: (readonly string[])[];
		depValues: unknown[];
		/** Bumped per load so a superseded response cannot publish over a newer one. */
		generation: number;
		teardownLive: (() => void) | null;
		stale: boolean;
		/**
		 * Write-backs in flight. An optimistic save commits immediately, and that
		 * commit runs the sweep — without this the entry would be collected out from
		 * under its own round trip and the rejection would have nowhere to land.
		 */
		saving: number;
	}

	const resourceStates = new Map<string, ResourceState>();

	/** The innermost dynamic segment above a path, which is the resource's key. */
	function keyFor(segments: readonly string[]): string {
		let schemaNode = schema;
		let key = '';
		for (let i = 0; i < segments.length; i++) {
			if (schemaNode.kind === BULK) {
				key = segments[i];
				schemaNode = schemaNode.dynamic!;
				continue;
			}
			const child = schemaNode.children?.get(segments[i]);
			if (child === undefined) return key;
			schemaNode = child;
		}
		return key;
	}

	function resourceAt(target: AnyRef): { segments: readonly string[]; schemaNode: SchemaNode } {
		const segments = refSegments(target);
		const schemaNode = resolveSchema(schema, segments);
		if (schemaNode === null) fail(`no such path "${target.path}"`);
		if (schemaNode.kind !== RESOURCE) fail(`"${target.path}" is not a resource`);
		return { segments, schemaNode };
	}

	function applyOne(
		segments: readonly string[],
		path: string,
		value: unknown,
		source: string,
	): void {
		const writes = new Map<string, StagedWrite>([[path, { path, segments, value }]]);
		if (notifying) {
			const pending = deferred ?? (deferred = new Map());
			deferredSource = source;
			pending.set(path, { path, segments, value });
			return;
		}
		commit(writes, source);
	}

	function wakeAt(segments: readonly string[]): void {
		const woken = new Set<Observer>();
		wakeForWrite(segments, woken);
		wakeOnly(woken);
	}

	function beginLoad(state: ResourceState, path: string, schemaNode: SchemaNode): Promise<unknown> {
		if (schemaNode.resource === null) {
			fail(`resource "${path}" has no implementation; supply it in .with()`);
		}
		const generation = ++state.generation;
		state.controller?.abort();
		const controller = new AbortController();
		state.controller = controller;
		state.status = 'pending';
		state.error = undefined;
		state.stale = false;
		const segments = state.segments;
		const deps: (readonly string[])[] = [];
		const depValues: unknown[] = [];
		const get: Get = (<T>(dep: Ref<T>): T => {
			const depSegments = refSegments(dep);
			const value = readSegments(depSegments);
			deps.push(depSegments);
			depValues.push(value);
			return value as T;
		}) as Get;
		const ctx: LoadContext<never> = {
			get,
			// The trailing segments ARE the arguments; the address is the cache key.
			args: (schemaNode.arity > 0
				? segments.slice(segments.length - schemaNode.arity)
				: []) as never,
			key: keyFor(segments),
			path,
			signal: controller.signal,
		};
		const promise = (async () => {
			const value = await schemaNode.resource!.load(ctx as never);
			// A refresh or a forget that happened while this was in flight wins.
			if (state.generation !== generation) return value;
			state.status = 'ready';
			state.promise = null;
			state.controller = null;
			state.deps = deps;
			state.depValues = depValues;
			state.stale = false;
			applyOne(segments, path, value, 'resource:load');
			// A load that changed nothing still moved the status.
			wakeAt(segments);
			return value;
		})();
		const exposed = promise.then(
			(value) => value,
			(error) => {
				if (state.generation === generation) {
					state.status = 'error';
					state.error = error;
					state.promise = null;
					state.controller = null;
					state.deps = deps;
					state.depValues = depValues;
					wakeAt(segments);
				}
				throw error;
			},
		);
		// The snapshot hands `exposed` to whoever suspends on it, but nothing
		// guarantees somebody will. Keep a terminal handler so a failed load is a
		// reported `status: 'error'` rather than an unhandled rejection crash.
		void exposed.catch(() => {});
		state.promise = exposed;
		return exposed;
	}

	function startLive(state: ResourceState, path: string, schemaNode: SchemaNode): void {
		const live = schemaNode.resource!.live;
		if (live === undefined) return;
		const segments = state.segments;
		const ctx: LiveContext<unknown> = {
			key: keyFor(segments),
			path,
			emit: (value) => {
				state.status = 'ready';
				state.error = undefined;
				state.stale = false;
				applyOne(segments, path, value, 'resource:live');
			},
			fail: (error) => {
				state.status = 'error';
				state.error = error;
				wakeAt(segments);
			},
		};
		try {
			const teardown = live(ctx as never);
			if (typeof teardown === 'function') state.teardownLive = teardown;
		} catch (error) {
			state.status = 'error';
			state.error = error;
		}
	}

	function ensureResource(
		path: string,
		segments: readonly string[],
		schemaNode: SchemaNode,
	): ResourceState {
		const existing = resourceStates.get(path);
		if (existing !== undefined) return existing;
		const state: ResourceState = {
			status: 'ready',
			promise: null,
			error: undefined,
			controller: null,
			segments,
			deps: [],
			depValues: [],
			generation: 0,
			teardownLive: null,
			stale: false,
			saving: 0,
		};
		resourceStates.set(path, state);
		startLive(state, path, schemaNode);
		// A value already present was seeded — by a server payload through
		// `replaceAll`, or by a live channel — so there is nothing to fetch.
		if (readValue(segments, schemaNode) === undefined) beginLoad(state, path, schemaNode);
		return state;
	}

	function snapshotOf<T>(state: ResourceState, value: unknown): ResourceSnapshot<T> {
		return {
			status: state.status,
			value: value as T | undefined,
			error: state.error,
			promise: state.status === 'pending' ? (state.promise as Promise<T> | null) : null,
			stale: state.stale,
		};
	}

	function resource<T>(target: Ref<T>): ResourceSnapshot<T> {
		const { segments, schemaNode } = resourceAt(target);
		const state = ensureResource(target.path, segments, schemaNode);
		return snapshotOf<T>(state, readValue(segments, schemaNode));
	}

	function refresh<T>(target: Ref<T>): Promise<T> {
		const { segments, schemaNode } = resourceAt(target);
		const state = ensureResource(target.path, segments, schemaNode);
		const promise = beginLoad(state, target.path, schemaNode) as Promise<T>;
		wakeAt(segments);
		return promise;
	}

	async function save<T>(target: Ref<T>, value: T): Promise<void> {
		const { segments, schemaNode } = resourceAt(target);
		const impl = schemaNode.resource!;
		if (impl.save === undefined) {
			fail(`resource "${target.path}" declares no save(); it is read-only`);
		}
		const state = ensureResource(target.path, segments, schemaNode);
		const previous = readValue(segments, schemaNode);
		// An optimistic update is a transaction that has not confirmed remotely yet,
		// so the failure path is the same restore a thrown action gets.
		state.saving++;
		state.status = 'ready';
		state.error = undefined;
		applyOne(segments, target.path, value, 'resource:save');
		const controller = new AbortController();
		const ctx: SaveContext<T> = {
			value,
			key: keyFor(segments),
			path: target.path,
			signal: controller.signal,
		};
		try {
			await impl.save(ctx as never);
			state.saving--;
		} catch (error) {
			// Mark the failure BEFORE the restoring commit, and only release the
			// in-flight count after: the commit runs the sweep, and a state still
			// reading `ready` with no work outstanding would be collected mid-rollback.
			state.status = 'error';
			state.error = error;
			applyOne(segments, target.path, previous, 'resource:save:rollback');
			state.saving--;
			wakeAt(segments);
			throw error;
		}
	}

	function forget(target: AnyRef): void {
		const { segments, schemaNode } = resourceAt(target);
		const state = resourceStates.get(target.path);
		if (state !== undefined) {
			state.generation++;
			state.controller?.abort();
			state.teardownLive?.();
			resourceStates.delete(target.path);
		}
		if (readValue(segments, schemaNode) !== undefined) {
			applyOne(segments, target.path, undefined, 'resource:forget');
		}
	}

	/**
	 * Swept at the end of every commit rather than per read, so reads stay
	 * allocation-free. A settled resource nobody observes and nothing pushes to
	 * keeps only its value (in the bulk, where the caller asked for it) — the
	 * transient entry goes, which is what keeps this map O(activity).
	 */
	function dropResourceIfIdle(path: string, state: ResourceState): void {
		if (state.status !== 'ready' || state.stale) return;
		if (state.teardownLive !== null || state.saving > 0) return;
		const node = findNode(state.segments);
		if (node !== null && hasObservers(node)) return;
		resourceStates.delete(path);
	}

	function sweepResources(woken: Set<Observer>): void {
		for (const [path, state] of resourceStates) {
			if (state.status !== 'ready') continue;
			if (!state.stale && state.deps.length > 0) {
				for (let i = 0; i < state.deps.length; i++) {
					if (Object.is(readSegments(state.deps[i]), state.depValues[i])) continue;
					state.stale = true;
					wakeForWrite(state.segments, woken);
					break;
				}
			}
			dropResourceIfIdle(path, state);
		}
	}

	// ── Server rendering ────────────────────────────────────────────────────
	//
	// Path addressing is what makes SSR, partial prerendering, and incremental
	// regeneration one mechanism: the payload is a flat map, so slicing it by
	// pattern and merging two of them are both trivial.

	function dehydrate(options?: DehydrateOptions): Payload {
		const include = options?.include?.map((p) => p.split('/'));
		const exclude = options?.exclude?.map((p) => p.split('/'));
		const data: Record<string, unknown> = {};

		const wanted = (path: string): boolean => {
			if (include !== undefined && !include.some((p) => matches(p, path))) return false;
			if (exclude !== undefined && exclude.some((p) => matches(p, path))) return false;
			return true;
		};

		const walk = (schemaNode: SchemaNode, segments: readonly string[], path: string): void => {
			switch (schemaNode.kind) {
				case CELL:
				case RESOURCE: {
					// Transient run state describes THIS session's attempt, so it never ships.
					if (schemaNode.transient) return;
					// A resource's settled value is data; an unfetched one has nothing to ship.
					const value = readValue(segments, schemaNode);
					if (value === undefined) return;
					if (wanted(path)) data[path] = value;
					return;
				}
				case BULK: {
					// The whole partition travels as one opaque value, which is also how
					// it is stored, so this costs nothing to produce.
					const value = readValue(segments, schemaNode);
					if (value === undefined) return;
					if (wanted(path)) data[path] = value;
					return;
				}
				case DERIVED:
				case ACTION:
					return;
				case TASK:
					// Its children are the transient run state, skipped above.
					return;
				default: {
					if (schemaNode.children === null) return;
					for (const [key, child] of schemaNode.children) {
						walk(child, [...segments, key], path === '' ? key : `${path}/${key}`);
					}
				}
			}
		};
		walk(schema, [], '');

		return options?.at === undefined ? { v: 1, data } : { v: 1, at: options.at, data };
	}

	function markStaleUnder(schemaNode: SchemaNode, segments: readonly string[], path: string): void {
		if (schemaNode.kind === RESOURCE) {
			if (readValue(segments, schemaNode) === undefined) return;
			ensureResource(path, segments, schemaNode).stale = true;
			return;
		}
		if (schemaNode.kind === BULK) {
			const bulk = readValue(segments, schemaNode);
			if (bulk === null || typeof bulk !== 'object') return;
			for (const key of Object.keys(bulk)) {
				markStaleUnder(schemaNode.dynamic!, [...segments, key], `${path}/${key}`);
			}
			return;
		}
		if (schemaNode.children === null) return;
		for (const [key, child] of schemaNode.children) {
			markStaleUnder(child, [...segments, key], path === '' ? key : `${path}/${key}`);
		}
	}

	function hydrate(payload: Payload, options?: HydrateOptions): HydrateResult {
		if (payload.v !== 1) {
			fail(`unsupported payload version ${String(payload.v)}; this build reads version 1`);
		}
		const allow = options?.allow?.map((p) => p.split('/'));
		const writes = new Map<string, StagedWrite>();
		const bulkPaths: string[] = [];
		const rejected: string[] = [];
		const unknown: string[] = [];
		for (const [path, value] of Object.entries(payload.data)) {
			// Scope check first: a payload from the wire must not be able to write an
			// address the call site did not ask for.
			if (allow !== undefined && !allow.some((p) => matches(p, path))) {
				rejected.push(path);
				continue;
			}
			const segments = path.split('/');
			const schemaNode = resolveSchema(schema, segments);
			// A payload can outlive the schema that produced it. Skipping an unknown
			// path lets a deploy roll forward instead of failing the whole render.
			if (schemaNode === null) {
				unknown.push(path);
				continue;
			}
			if (schemaNode.kind === DERIVED || schemaNode.kind === ACTION || schemaNode.kind === TASK) {
				rejected.push(path);
				continue;
			}
			if (schemaNode.kind === BULK) {
				const node = findNode(segments);
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

		version++;
		const woken = new Set<Observer>();
		for (const path of bulkPaths) {
			const node = findNode(path.split('/'))!;
			bumpToRoot(node, version);
			collectSubtree(node, woken);
			collectDeep(node, woken);
		}
		const applied: Write[] = [];
		for (const staged of writes.values()) {
			const schemaNode = resolveSchema(schema, staged.segments)!;
			const prev = readValue(staged.segments, schemaNode);
			if (Object.is(prev, staged.value)) continue;
			writeThrough(staged.segments, staged.value);
			applied.push({ path: staged.path, prev, next: staged.value });
			wakeForWrite(staged.segments, woken);
		}

		// Mark adopted resources so a reader can refresh behind the first paint.
		//
		// This has to DESCEND: a segment dehydrates as one opaque value, so its
		// resource values travel inside it rather than as their own entries. The
		// walk is proportional to the payload, which was already parsed, and it only
		// runs when the revalidation window has actually elapsed.
		if (stale) {
			for (const path of [...bulkPaths, ...writes.keys()]) {
				const segments = path.split('/');
				const schemaNode = resolveSchema(schema, segments);
				if (schemaNode !== null) markStaleUnder(schemaNode, segments, path);
			}
		}

		notify(woken, { id: ++commitId, source: options?.source ?? 'hydrate', writes: applied });
		return {
			applied: [...bulkPaths, ...applied.map((w) => w.path)],
			rejected,
			unknown,
		};
	}

	// ── Public surface ──────────────────────────────────────────────────────

	/**
	 * ONE write, without the transaction machinery.
	 *
	 * The general path allocates a Map for the write set, a `Tx` carrying four
	 * closures, a staged-write record, a `woken` Set, an `applied` array, a `Write`
	 * and a `Commit` — then resolves the schema twice and walks to the bulk holder
	 * twice. A single write needs none of that, and single writes are the
	 * overwhelming majority, so this path exists and is measured.
	 */
	/** A read that reuses whatever the ref has already resolved. */
	/**
	 * ONE internals lookup, not three.
	 *
	 * `refSegments`, `schemaOf`, and `bulkOf` each read the same symbol-keyed slot off
	 * the same object, so the read path was doing that three times and three calls to
	 * do it. Reading it once also gives this call site its own inline cache, which sees
	 * almost only `RefImpl`, instead of sharing a megamorphic one with every other
	 * caller in the file.
	 */
	function readRef(target: AnyRef): unknown {
		// The typeof guard comes first: `internalsOf` reads a property, and the public
		// entry point has to name a non-ref rather than fail on one. Functions and
		// hand-built path refs take the general path, which has the diagnostics.
		if (target === null || typeof target !== 'object') return readSegments(refSegments(target));
		const internals = internalsOf(target as object);
		if (internals === undefined) return readSegments(refSegments(target));
		const segments = internals.segments;
		let schemaNode = internals.schema as SchemaNode | null | undefined;
		if (schemaNode === undefined) {
			schemaNode = resolveSchema(schema, segments) ?? null;
			internals.schema = schemaNode;
		}
		if (schemaNode === null) return undefined;
		if (schemaNode.kind === DERIVED) return evaluateDerived(segments, schemaNode);
		if (internals.bulkResolved !== true) {
			internals.bulk = bulkRoot(segments);
			internals.bulkResolved = true;
		}
		return readAt(internals.bulk as BulkAt | null, segments, schemaNode);
	}

	function writeOne(
		target: AnyRef,
		next: unknown,
		source: string | undefined,
		update: ((prev: unknown) => unknown) | null,
	): void {
		const segments = refSegments(target);
		const schemaNode = schemaOf(target, segments);
		if (schemaNode === null) fail(`no such path "${target.path}"`);
		if (schemaNode.kind !== CELL) {
			// Anything other than a plain cell has its own rule and its own error, so
			// hand it to the general path rather than duplicating the diagnostics.
			act((tx) => {
				if (update === null) tx.set(target as Ref<unknown>, next);
				else tx.update(target as Ref<unknown>, update);
			}, source);
			return;
		}

		// Resolved once and reused for both the read and the write, and memoized on the
		// ref so a held ref never walks again.
		const bulk = bulkOf(target, segments);
		const prev = readAt(bulk, segments, schemaNode);
		const value = update === null ? next : update(prev);
		if (Object.is(prev, value)) return;

		if (notifying) {
			// Re-entrant: joining the next commit is the only way an observer cannot
			// see a state nobody committed.
			const pending = deferred ?? (deferred = new Map());
			deferredSource = source ?? 'reentrant';
			pending.set(target.path, { path: target.path, segments, value });
			return;
		}

		applyWrite(target, segments, bulk, prev, value, source);
	}

	/**
	 * Apply ONE already-validated write and wake exactly what it concerns.
	 *
	 * Shared by the direct `set`/`update` path and by a transaction that turned out to
	 * hold a single write, which is what an ordinary action does. A one-write commit
	 * needs neither the dedup Set nor the write-record array a multi-write commit
	 * does, and this is the only place that knows it.
	 */
	function applyWrite(
		addr: { path: string },
		segments: readonly string[],
		bulk: { node: Node; start: number } | null,
		prev: unknown,
		value: unknown,
		source: string | undefined,
	): void {
		version++;
		writeAt(bulk, segments, value);

		let woken: Set<Observer> | null = null;
		let single: Observer | null = null;
		const node = findNode(segments);
		if (node !== null) {
			bumpToRoot(node, version);
			const sole = soleObserver(node);
			if (sole === undefined) {
				woken = new Set();
				collectObservers(node, woken);
				if (woken.size === 0) woken = null;
			} else single = sole;
		} else {
			const found = wakeFallback(segments);
			if (found === undefined) woken = fallbackSet(segments);
			else single = found;
		}

		const pushes = observedDerived.size > 0 || resourceStates.size > 0;
		const listening = commitSubs.size > 0 || watchIndex.size > 0;
		if (pushes || listening) {
			// Something needs the full shape, so build it. Otherwise none of it is
			// allocated at all.
			const set = woken ?? new Set<Observer>();
			if (single !== null) set.add(single);
			if (observedDerived.size > 0) pushDerived(set);
			if (resourceStates.size > 0) sweepResources(set);
			const named = source ?? commitName();
			notify(set.size > 0 ? set : null, {
				id: ++commitId,
				source: named,
				// `addr.path` and not a string parameter: on a ref this is a lazy join, and
				// forcing it per write allocated a string only a listener ever reads.
				writes: [{ path: addr.path, prev, next: value }],
			});
			return;
		}
		if (woken !== null) {
			notifyOnly(woken);
			return;
		}
		if (single !== null) {
			notifyOne(single);
			return;
		}
		flushDeferred();
	}

	/** The deepest materialized ancestor of a path that has no node of its own. */
	function deepestNode(segments: readonly string[]): Node {
		let node = root;
		for (let i = 0; i < segments.length; i++) {
			const child = lookupChild(node, segments[i]);
			if (child === undefined) break;
			node = child;
		}
		return node;
	}

	/** Wake observers when nothing is materialized at the written path. */
	function wakeFallback(segments: readonly string[]): Observer | null | undefined {
		const node = deepestNode(segments);
		bumpToRoot(node, version);
		return soleDeep(node);
	}

	/** The multi-observer form of `wakeFallback`, once the sole-observer case is out. */
	function fallbackSet(segments: readonly string[]): Set<Observer> | null {
		const woken = new Set<Observer>();
		collectDeep(deepestNode(segments), woken);
		return woken.size > 0 ? woken : null;
	}

	/** One observer, with no Set and no commit record: the single-write UI path. */
	function notifyOne(observer: Observer): void {
		notifying = true;
		try {
			if (observer.live) observer.cb();
		} finally {
			notifying = false;
		}
		flushDeferred();
	}

	/** Observers only, with no commit record for anyone to read. */
	function notifyOnly(woken: Set<Observer>): void {
		notifying = true;
		try {
			for (const observer of woken) if (observer.live) observer.cb();
		} finally {
			notifying = false;
		}
		flushDeferred();
	}

	function commitName(): string {
		return DEV && (commitSubs.size > 0 || watchIndex.size > 0) ? callerName('action') : 'action';
	}

	function act(fn: (tx: Tx) => void, source?: string): void {
		return actNamed(fn, source ?? commitName());
	}

	function actNamed(fn: (tx: Tx) => void, source: string): void {
		let frame = txFrames[txDepth];
		if (frame === undefined) {
			frame = {
				writes: new Map<string, StagedWrite>(),
				only: { path: '', segments: EMPTY_SEGMENTS, value: undefined, ref: undefined },
				count: 0,
				spilled: false,
				tx: null as unknown as Tx,
				active: false,
			};
			frame.tx = createTx(frame);
			txFrames[txDepth] = frame;
		}
		const writes = frame.writes;
		txDepth++;
		frame.active = true;
		frame.count = 0;
		frame.spilled = false;
		try {
			// A throw escapes with the trie untouched: nothing was applied, so the
			// rollback is the absence of work rather than an undo log.
			fn(frame.tx);
			if (notifying) {
				// Re-entrant write. Applying it inside the notification pass would let
				// an observer see a state nobody committed, so it joins the next commit.
				const target = deferred ?? (deferred = new Map());
				deferredSource = source;
				if (frame.spilled) for (const [path, entry] of writes) target.set(path, entry);
				else if (frame.count === 1) {
					// A copy: `only` is reused by the next act, and this has to outlive it.
					target.set(frame.only.path, {
						path: frame.only.path,
						segments: frame.only.segments,
						value: frame.only.value,
						ref: frame.only.ref,
					});
				}
				return;
			}
			if (frame.spilled) commit(writes, source);
			else if (frame.count === 1) commitOne(frame.only, source);
		} finally {
			// The staged records may now be referenced by `deferred`; clearing the Map only
			// drops this frame's references to them, never mutates them.
			frame.active = false;
			if (frame.spilled) writes.clear();
			// Released because each can retain something large: the ref holds a
			// descriptor, the segments an array, the value whatever the caller wrote.
			// `path` is left alone deliberately: it is one small string, `count` already
			// makes it unreachable, and clearing it would be a store on every commit.
			frame.only.ref = undefined;
			frame.only.segments = EMPTY_SEGMENTS;
			frame.only.value = undefined;
			txDepth--;
		}
	}

	function observe<T>(ref: Ref<T>, cb: () => void, options?: ObserveOptions): Dispose {
		const segments = refSegments(ref);
		// Through the ref's memo, not a fresh walk: mounting is the load path, and a
		// remount of the same address reuses the interned descriptor, so the schema
		// answer is already on it.
		const schemaNode = schemaOf(ref as AnyRef, segments);
		if (schemaNode === null) fail(`no such path "${ref.path}"`);
		if (schemaNode.kind === ACTION || schemaNode.kind === TASK) {
			fail(`"${ref.path}" is an action and cannot be observed`);
		}

		// A LEAF is observed exactly; a CONTAINER is always observed deeply.
		// Observing a branch or a segment means observing its contents — there is no
		// separate "the container object itself changed" event, because a write goes
		// through to the bulk value in place and never replaces the object.
		const deep = options?.deep === true || schemaNode.kind === BULK || schemaNode.kind === BRANCH;

		let node = root;
		let schemaCursor = schema;
		for (let i = 0; i < segments.length; i++) {
			schemaCursor =
				schemaCursor.kind === BULK
					? schemaCursor.dynamic!
					: // A parameterized resource's argument segments stay AT the resource:
						// they identify which fetch, not a deeper address.
						schemaCursor.kind === RESOURCE && schemaCursor.arity > 0
						? schemaCursor
						: schemaCursor.children!.get(segments[i])!;
			node = childOf(node, segments[i], schemaCursor);
		}
		const target = node;
		if (schemaNode.kind === DERIVED) {
			observedDerived.add(target);
			// Seed the cache so the first commit has a previous value to compare.
			evaluateDerived(segments, schemaNode);
		}
		// Observing a resource is what makes its load start and its staleness
		// tracked, so the two lifecycles are tied together deliberately.
		if (schemaNode.kind === RESOURCE) ensureResource(ref.path, segments, schemaNode);

		// The node lives ON the observer, so the disposer closes over one variable instead
		// of five and V8 allocates no context object for it. `live` doubles as the
		// already-disposed flag it used to capture separately.
		const observer: Observer = { cb, deep, live: true, node: target };
		addObserver(target, observer);
		return () => detach(observer);
	}

	/** Shared teardown, so every subscription's disposer is the same compiled code. */
	function detach(observer: Observer): void {
		if (!observer.live) return;
		observer.live = false;
		const target = observer.node;
		removeObserver(target, observer);
		if (!hasObservers(target)) {
			observedDerived.delete(target);
			target.hasCache = false;
			target.deps = null;
			target.depValues = null;
			// A store with no resources never builds the path at all. One that has them
			// rebuilds it from the node, which is why the observer need not hold it.
			if (resourceStates.size > 0) {
				const path = nodeSegments(target).join('/');
				const state = resourceStates.get(path);
				// Drop here as well as in the commit sweep, so releasing the last observer
				// frees the entry immediately instead of at the next write.
				if (state !== undefined) dropResourceIfIdle(path, state);
			}
		}
		pruneUp(target);
	}

	function kindOf(target: AnyRef): AddressKind {
		const segments = refSegments(target);
		const schemaNode = resolveSchema(schema, segments);
		if (schemaNode === null) fail(`no such path "${target.path}"`);
		switch (schemaNode.kind) {
			case CELL:
				return 'cell';
			case DERIVED:
				return 'derived';
			case RESOURCE:
				return 'resource';
			case ACTION:
			case TASK:
				return 'action';
			case BULK:
				return 'bulk';
			default:
				return 'branch';
		}
	}

	// Reserved namespace for anonymous derivations. `compileSchema` rejects a shape
	// key with this prefix, so it cannot collide with an author's own address.
	let nextDerived = 0;

	function derive<T>(fn: (get: Get) => T): Ref<T, 'derived'> {
		const seg = `${DERIVE_PREFIX}${nextDerived++}`;
		const schemaNode: SchemaNode = {
			kind: DERIVED,
			bulk: 0,
			children: null,
			dynamic: null,
			proto: null,
			init: undefined,
			derive: fn as SchemaNode['derive'],
			action: null,
			task: null,
			resource: null,
			fixed: true,
			path: seg,
			arity: 0,
			transient: false,
		};
		if (schema.children === null) schema.children = new Map();
		schema.children.set(seg, schemaNode);
		// Pinned like every other schema-bounded node, so it always has somewhere to
		// cache and is never pruned out from under a reader.
		childOf(root, seg, schemaNode).pinned = true;
		return new RefImpl(seg, [seg], holder) as unknown as Ref<T, 'derived'>;
	}

	function release(target: AnyRef): void {
		const seg = target.path;
		if (!seg.startsWith(DERIVE_PREFIX) && !seg.startsWith(FETCH_PREFIX)) {
			fail(
				`"${seg}" was declared in the schema, so it lives as long as the store. ` +
					'Only a derive() or resourceOf() result can be released.',
			);
		}
		schema.children?.delete(seg);
		const node = lookupChild(root, seg);
		if (node === undefined) return;
		observedDerived.delete(node);
		node.pinned = false;
		root.children!.delete(seg);
	}

	let nextFetch = 0;

	function resourceOf(impl: unknown): unknown {
		const seg = `${FETCH_PREFIX}${nextFetch++}`;
		const schemaNode: SchemaNode = {
			kind: RESOURCE,
			bulk: 0,
			children: null,
			dynamic: null,
			proto: null,
			init: undefined,
			derive: null,
			action: null,
			task: null,
			resource: normalizeResource(impl, seg),
			fixed: true,
			path: seg,
			// Unknown until the first call, exactly as for a declared resource.
			arity: -1,
			transient: false,
		};
		if (schema.children === null) schema.children = new Map();
		schema.children.set(seg, schemaNode);
		childOf(root, seg, schemaNode).pinned = true;
		return resourceAddress(schemaNode, seg, [seg]);
	}

	function revision(target: AnyRef): number {
		const segments = refSegments(target);
		if (resolveSchema(schema, segments) === null) fail(`no such path "${target.path}"`);
		let node = root;
		for (let i = 0; i < segments.length; i++) {
			const child = lookupChild(node, segments[i]);
			if (child === undefined) break;
			node = child;
		}
		return node.ver;
	}

	function ref(path: string): Ref<unknown> {
		const segments = path.split('/');
		if (resolveSchema(schema, segments) === null) {
			fail(`no such path "${path}"; check it against the schema`);
		}
		return new RefImpl(path, segments, holder) as unknown as Ref<unknown>;
	}

	function detachPort(record: PortRecord): void {
		if (!record.live) return;
		record.live = false;
		ports.delete(record);
		for (const entry of [...watches]) {
			if (entry.owner !== record) continue;
			watches.delete(entry);
			unindexWatch(entry);
		}
		const detach = record.detach;
		record.detach = null;
		if (detach !== null) {
			try {
				detach();
			} catch (error) {
				reportError(error, record);
			}
		}
	}

	function attach(port: Port): Dispose {
		for (const existing of ports) {
			if (existing.port === port) fail(`port "${port.name}" is already attached`);
		}
		const record: PortRecord = { port, detach: null, live: true };
		ports.add(record);
		const ctx: PortContext = {
			read: (path) => readSegments(ref(path).path.split('/')),
			write: (path, value) => {
				const target = ref(path);
				act((tx) => tx.set(target, value), port.name);
			},
			watch: (pattern, cb) => {
				const entry: WatchEntry = { pattern: pattern.split('/'), cb, owner: record };
				watches.add(entry);
				indexWatch(entry);
				return () => {
					watches.delete(entry);
					unindexWatch(entry);
				};
			},
			commits: (cb) => {
				commitSubs.add(cb);
				return () => commitSubs.delete(cb);
			},
		};
		const detach = port.attach(ctx);
		if (typeof detach === 'function') record.detach = detach;
		return () => detachPort(record);
	}

	// ── The accessor tree ───────────────────────────────────────────────────

	/**
	 * Make a branch or bulk view a valid ADDRESS, not just a container of them.
	 * `useValue(s.users.at(id))` reads a whole record, so every node of the
	 * accessor tree has to answer the same internals question a leaf does.
	 * Non-enumerable so spreading or logging a view stays clean.
	 */
	function stampAddress(view: object, segments: readonly string[], joined?: string): void {
		Object.defineProperty(view, REF_INTERNALS, {
			value: {
				segments,
				holder,
				joined,
				schema: undefined,
				bulk: undefined,
				bulkResolved: false,
			},
			enumerable: false,
		});
	}

	/**
	 * The shared prototype for a group's views: `path` and one accessor per child, so a
	 * view is ONE allocation regardless of how many fields the group has.
	 *
	 * Building children eagerly made reading one field of an unobserved record scale
	 * with the width of the record: measured 218 ns at one field, 521 at eight, 1112 at
	 * sixteen, to read a single field every time. A caller that wants `user.name` should
	 * not pay for `user.email`.
	 *
	 * The first read of a child caches it as an own property, which shadows the
	 * accessor, so the render path that reads the same field every pass keeps paying a
	 * plain property read.
	 */
	function groupProto(schemaNode: SchemaNode): object {
		const existing = schemaNode.proto;
		if (existing !== null) return existing;
		const proto: Record<string, unknown> = {};
		Object.defineProperty(proto, 'path', {
			get(this: object): string {
				const internals = internalsOf(this)!;
				return internals.joined ?? (internals.joined = internals.segments.join('/'));
			},
			enumerable: true,
			configurable: true,
		});
		if (schemaNode.children !== null) {
			for (const [key, child] of schemaNode.children) {
				Object.defineProperty(proto, key, {
					get(this: object): unknown {
						const internals = internalsOf(this)!;
						const built = makeView(child, undefined, [...internals.segments, key]);
						Object.defineProperty(this, key, {
							value: built,
							enumerable: true,
							configurable: true,
						});
						return built;
					},
					enumerable: true,
					configurable: true,
				});
			}
		}
		schemaNode.proto = proto;
		return proto;
	}

	/**
	 * A resource address is BOTH a ref and a function. Nothing at runtime can tell
	 * "declared with no arguments" from "arguments not yet seen", and the TYPE
	 * already distinguishes them, so the value provides both shapes and the type
	 * decides which one an author may use.
	 */
	function resourceAddress(
		schemaNode: SchemaNode,
		path: string,
		segments: readonly string[],
	): unknown {
		const callable = (...args: unknown[]) => {
			const parts = args.map((arg) => {
				if (arg === null || typeof arg === 'object') {
					fail(
						`resource "${path}" received a non-primitive argument. Arguments become ` +
							'path segments, so they must be strings, numbers, or booleans.',
					);
				}
				return String(arg);
			});
			if (schemaNode.arity < 0) schemaNode.arity = parts.length;
			else if (schemaNode.arity !== parts.length) {
				fail(
					`resource "${path}" is addressed with ${schemaNode.arity} argument(s); ` +
						`received ${parts.length}. They are path segments, so the count is fixed.`,
				);
			}
			return new RefImpl(`${path}/${parts.join('/')}`, [...segments, ...parts], holder);
		};
		Object.defineProperty(callable, 'path', { value: path, enumerable: true });
		stampAddress(callable, segments);
		return callable;
	}

	function makeView(
		schemaNode: SchemaNode,
		path: string | undefined,
		segments: readonly string[],
	): unknown {
		switch (schemaNode.kind) {
			case RESOURCE:
				return resourceAddress(schemaNode, path ?? segments.join('/'), segments);
			case CELL:
			case DERIVED:
				return new RefImpl(path, segments, holder);
			case TASK: {
				// Joined here, not taken from the caller: a group builds its children lazily
				// and hands them no path, and a task names itself in its commits and errors.
				const here = path ?? segments.join('/');
				const statusRef = new RefImpl(`${here}/status`, [...segments, 'status'], holder);
				const resultRef = new RefImpl(`${here}/result`, [...segments, 'result'], holder);
				const errorRef = new RefImpl(`${here}/error`, [...segments, 'error'], holder);
				let generation = 0;
				const callable = (...args: unknown[]) => {
					if (schemaNode.task === null) {
						fail(`task "${here}" has no implementation; supply it in .with()`);
					}
					// Only the LATEST call publishes: two overlapping runs would otherwise
					// race to describe "the" status.
					const mine = ++generation;
					// Each `act` inside is its own commit; the task is not one transaction
					// and does not pretend to be.
					const controller = new AbortController();
					const ctx: TaskContext = {
						act: (fn, source) => act(fn, source ?? path),
						get: (<T>(target: Ref<T>) => readSegments(refSegments(target)) as T) as Get,
						signal: controller.signal,
					};
					act((tx) => {
						tx.set(statusRef as Ref<unknown>, 'running');
						tx.set(errorRef as Ref<unknown>, undefined);
					}, path);
					return Promise.resolve(schemaNode.task(ctx, ...args)).then(
						(value) => {
							if (generation !== mine) return value;
							act((tx) => {
								tx.set(resultRef as Ref<unknown>, value);
								tx.set(statusRef as Ref<unknown>, 'done');
							}, path);
							return value;
						},
						(error) => {
							if (generation === mine) {
								act((tx) => {
									tx.set(errorRef as Ref<unknown>, error);
									tx.set(statusRef as Ref<unknown>, 'failed');
								}, path);
							}
							throw error;
						},
					);
				};
				Object.defineProperty(callable, 'path', { value: here, enumerable: true });
				Object.defineProperty(callable, 'status', { value: statusRef, enumerable: true });
				Object.defineProperty(callable, 'result', { value: resultRef, enumerable: true });
				Object.defineProperty(callable, 'error', { value: errorRef, enumerable: true });
				stampAddress(callable, segments);
				return callable;
			}
			case ACTION: {
				// Same as TASK: an action is its own commit source, so it must know its path
				// even when the group above it built it lazily.
				const here = path ?? segments.join('/');
				return (...args: unknown[]) => {
					if (schemaNode.action === null) {
						fail(`action "${here}" has no implementation; supply it in .with()`);
					}
					act((tx) => schemaNode.action!(tx, ...args), here);
				};
			}
			case BULK: {
				const inner = schemaNode.dynamic!;
				const here = path ?? segments.join('/');
				// Resolved once: a bulk holder is schema-bounded and materialized eagerly, so
				// one that has no node here (a segment nested inside another one) never gains
				// one, and `null` is a permanent answer rather than a stale one.
				let self: Node | null | undefined;
				let childBulk: { node: Node; start: number } | null | undefined;
				// One slot for the key asked for last, because the adapter reads a record one
				// field at a time: `.at(id)` is called once per field. Measured at 285 ns per
				// field for three fields of one record without it, 143 with it. One slot and
				// not a map, so scanning distinct keys cannot promote a cache full of them.
				let lastKey: string | undefined;
				let lastView: unknown;
				const view: Record<string, unknown> = {
					path: here,
					at: (key: string | number) => {
						const child = String(key);
						// Interned on the trie node: a component re-reading its own address does not
						// rebuild the descriptor, and for a record that is the whole accessor subtree
						// rather than one ref. Pruning drops it with the node, so memory stays
						// O(observed), and ref identity is unspecified by contract.
						//
						// Checked BEFORE the last-key slot, and it deliberately does not write that
						// slot: keys cycling through a mounted window always miss it, and paying two
						// closure writes per read to serve a case this branch already handled cost
						// 24% on the list-read path when measured the other way round.
						if (self === undefined) self = findNode(segments);
						const node = self === null ? undefined : lookupChild(self, child);
						if (node !== undefined && node.view !== undefined) return node.view;
						if (child === lastKey) return lastView;
						// `undefined` path: the ref joins it from segments only if something
						// asks, which a write with no listener never does.
						const made = makeView(inner, undefined, [...segments, child]);
						// Every child of a bulk holder shares one element schema and one bulk holder,
						// and both answers are independent of the key. Seeding them here is what lets
						// a fresh `.at()` read or write skip the schema walk and the holder walk that
						// dominate its cost.
						const internals = internalsOf(made as object);
						if (internals !== undefined) {
							internals.schema = inner;
							if (childBulk === undefined) {
								// A holder with no node of its own sits inside an enclosing one, and the
								// enclosing answer is the same for the view and for every child of it.
								childBulk =
									self !== null ? { node: self, start: segments.length } : bulkRoot(segments);
							}
							internals.bulk = childBulk;
							internals.bulkResolved = true;
						}
						if (node !== undefined) node.view = made;
						lastKey = child;
						return (lastView = made);
					},
				};
				if (schemaNode.bulk === BULK_SEGMENT) {
					view.replaceAll = (next: unknown) => replaceAll(schemaNode, here, segments, next);
					view.snapshot = () => readValue(segments, schemaNode);
				}
				stampAddress(view, segments);
				return view;
			}
			default: {
				// A schema-bounded group is built ONCE per store, so eager children cost
				// nothing per access afterwards and every read is a plain property read.
				// Building the shared prototype instead would move that work into
				// `createStore`, where it measured 16% slower for a 400-leaf schema.
				if (schemaNode.fixed) {
					const base = path ?? segments.join('/');
					const view: Record<string, unknown> = { path: base };
					if (schemaNode.children !== null) {
						for (const [key, child] of schemaNode.children) {
							view[key] = makeView(child, base === '' ? key : `${base}/${key}`, [...segments, key]);
						}
					}
					stampAddress(view, segments);
					return view;
				}
				// A group under a bulk holder is built PER KEY, so eager children made
				// reading one field cost as much as the record is wide. The prototype is
				// built once for the whole segment and every key shares it.
				const view = Object.create(groupProto(schemaNode)) as object;
				stampAddress(view, segments, path);
				return view;
			}
		}
	}

	/**
	 * O(1) bulk replacement: the segment takes a new opaque value and only the
	 * descendants somebody is actually observing are woken.
	 */
	function replaceAll(
		schemaNode: SchemaNode,
		path: string,
		segments: readonly string[],
		next: unknown,
	): void {
		const node = findNode(segments);
		if (node === null) {
			// Only a segment with no bulk holder above it owns its own value; a
			// nested one lives inside its parent's opaque value, where there is
			// nothing to swap atomically.
			fail(
				`segment "${path}" is nested inside another bulk holder, so it has no ` +
					'independent value to replace; write its keys instead',
			);
		}
		version++;
		const prev = node.value;
		node.value = next;
		bumpToRoot(node, version);
		const woken = new Set<Observer>();
		collectSubtree(node, woken);
		collectDeep(node, woken);
		for (const derived of observedDerived) {
			const previous = derived.hasCache ? derived.value : undefined;
			const had = derived.hasCache;
			const value = evaluateDerived(nodeSegments(derived), derived.schema);
			if (had && Object.is(previous, value)) continue;
			collectObservers(derived, woken);
		}
		notify(woken, {
			id: ++commitId,
			source: 'replaceAll',
			writes: [{ path, prev, next }],
		});
	}

	const rootView = makeView(schema, '', []) as View<S>;

	function withImpls(fn: (s: View<S>, act: Act) => Impl<S>): Store<S> {
		installImpls(schema, fn(rootView, act));
		const missing = missingImpls(schema);
		if (missing.length > 0) {
			fail(`.with() left these declared slots unimplemented: ${missing.join(', ')}`);
		}
		return api;
	}

	const api: Store<S> = {
		state: rootView,
		with: withImpls,
		get: <T>(target: Ref<T>): T => readRef(target as AnyRef) as T,
		set: (target, value, source) => writeOne(target, value, source, null),
		patch: (target, values, source) =>
			act((tx) => tx.patch(target as never, values), source ?? 'patch'),
		update: (target, fn, source) =>
			writeOne(target, undefined, source, fn as (prev: unknown) => unknown),
		act,
		observe,
		ref,
		revision,
		kindOf,
		derive,
		resourceOf: resourceOf as Store<S>['resourceOf'],
		release,
		resource,
		refresh,
		save,
		forget,
		dehydrate,
		hydrate,
		attach,
		commits: (cb) => {
			commitSubs.add(cb);
			return () => commitSubs.delete(cb);
		},
		stats: () => ({
			nodes: countNodes(root),
			observedDerived: observedDerived.size,
			ports: ports.size,
			resources: resourceStates.size,
		}),
	};
	holder.store = api;
	return api;
}
