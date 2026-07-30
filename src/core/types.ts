// Public type surface.
//
// Two measurements shaped this file and neither is negotiable:
//
//  * S1 proved that a callback inside the shape literal cannot see the type being
//    inferred from that literal — `S` collapses to `never`. So the shape is pure
//    data, and every implementation arrives in `.with()`, where the shape is
//    already resolved and `s` is simply in scope.
//  * S1 also proved template-literal path resolution is CHEAPER than the
//    accessor tree (120k instantiations against 638k), so typed string paths are
//    the default rather than an opt-in.
//
// Everything an author can infer from a value is inferred: a primitive is a
// cell, a plain object is a branch. Markers exist only where a value cannot
// carry the information — a key type, or a slot that is computed rather than
// stored.

declare const VALUE: unique symbol;
declare const KIND: unique symbol;
declare const BRANCH_VALUE: unique symbol;

/**
 * A branded address into the store. Two refs denote the same state when their
 * `path` is equal; object identity is NOT guaranteed for refs built through a
 * dynamic segment, because interning those would grow without bound over an
 * unbounded key space. Compare `path`, never `===`.
 *
 * The second parameter carries WHAT KIND of address this is, so `useValue` can
 * type its setter as `never` for a derivation or a branch. That is the whole
 * reason it exists: one hook returning a read/write pair must not hand back a
 * setter for something the store cannot write.
 *
 * `VALUE` is invariant, so a `Ref<number>` is not a `Ref<string>`. `KIND` is
 * covariant, so a `Ref<T, 'cell'>` still passes anywhere a `Ref<T>` is wanted.
 */
export interface Ref<T, K extends AddressKind = AddressKind> {
	readonly [VALUE]?: (v: T) => T;
	readonly [KIND]?: K;
	readonly path: string;
}

/** Writes a cell. Accepts a value or an updater, like `useState`. */
export type Setter<T> = (next: T | ((prev: T) => T)) => void;

/**
 * What `useValue` hands back. The setter is present only for an address the store
 * can actually write; for a derivation, a branch, or a selector it is `never`, so
 * taking it is a compile error rather than a runtime surprise.
 */
export type ValueTuple<T, K extends AddressKind> = 'cell' extends K ? [T, Setter<T>] : [T, never];

// ── Markers ─────────────────────────────────────────────────────────────────

export interface CellDef<T> {
	readonly kind: 'cell';
	readonly init: T;
}
export interface DerivedDef<T> {
	readonly kind: 'derived';
	readonly of?: (v: T) => T;
}
export interface ActionDef<A extends readonly unknown[]> {
	readonly kind: 'action';
	readonly args?: (a: A) => A;
}
/** How a task's most recent run is going. */
export type TaskStatus = 'idle' | 'running' | 'done' | 'failed';

/**
 * A multi-step operation over time. Declared separately from `action` because the
 * semantics genuinely differ: an action is ONE commit, a task is several.
 *
 * A task also EXPOSES ITS OWN RUN STATE as three readable addresses, so a component
 * can render progress and the result without the task writing them by hand:
 *
 * ```tsx
 * <button onClick={() => s.cart.checkout('SUMMER')}>Pay</button>
 * const [status] = useValue(s.cart.checkout.status);   // 'running' | 'done' | …
 * const [order]  = useValue(s.cart.checkout.result);
 * ```
 *
 * They are deliberately NOT readable through `useResource`: that hook reads during
 * render, and a task writes, so reading one from render would run the mutation on
 * every render.
 */
export interface TaskDef<A extends readonly unknown[], R = void> {
	readonly kind: 'task';
	readonly args?: (a: A) => A;
	readonly result?: (r: R) => R;
}
/**
 * A value that is fetched rather than written. Its settled value goes through
 * the ordinary commit path, so observers, ports, and `revision` see it exactly
 * as they see a cell.
 */
export interface ResourceDef<T, A extends readonly unknown[] = []> {
	readonly kind: 'resource';
	readonly of?: (v: T) => T;
	readonly args?: (a: A) => A;
	/** How many path segments the arguments occupy. */
	readonly arity: number;
}
export interface ListDef<S> {
	readonly kind: 'list';
	readonly shape: S;
}
/**
 * A bulk partition. Data under a segment is held as one opaque value with a
 * single version stamp, and nodes below it materialize only when observed. This
 * is what keeps memory O(observed) rather than O(data).
 */
export interface SegmentDef<K extends string, S> {
	readonly kind: 'segment';
	readonly shape: S;
	readonly key?: (k: K) => K;
}

export type AnyDef =
	| CellDef<any>
	| DerivedDef<any>
	| ActionDef<any>
	| TaskDef<any, any>
	| ResourceDef<any, any>
	| ListDef<any>
	| SegmentDef<any, any>;

/**
 * Objects that are VALUES rather than branches. A plain object literal nests; a
 * Date, Map, Set, or array is something you store. Anything else that should be
 * a value despite being an object takes the explicit `cell()` escape hatch.
 */
type ValueObject = readonly unknown[] | Date | Map<unknown, unknown> | Set<unknown> | RegExp;

/** Is this shape entry a stored value (a cell) rather than a marker or a branch? */
type IsCell<S> = [S] extends [AnyDef]
	? false
	: [S] extends [ValueObject]
		? true
		: [S] extends [object]
			? false
			: true;

// ── The accessor tree ───────────────────────────────────────────────────────

export interface SegmentView<K extends string, S> {
	at(key: K): View<S>;
	/** O(1) bulk replacement. Only materialized descendants are re-seeded. */
	replaceAll(next: Record<K, Snapshot<S>>): void;
	snapshot(): Record<K, Snapshot<S>>;
	readonly path: string;
}

export interface ListView<S> {
	at(index: number): View<S>;
	readonly path: string;
}

/**
 * A task address is callable AND carries its own run state, the same way a
 * parameterized resource is both a ref and a function.
 */
export type TaskView<A extends readonly unknown[], R> = ((...args: A) => Promise<R>) & {
	readonly path: string;
	/** `'running'` while the latest call is in flight. */
	readonly status: Ref<TaskStatus, 'cell'>;
	/** What the latest successful call returned. */
	readonly result: Ref<R | undefined, 'cell'>;
	/** What the latest failed call threw. */
	readonly error: Ref<unknown, 'cell'>;
};

/** The typed accessor tree an author actually calls. */
// Every test compares SINGLE-ELEMENT TUPLES. A conditional on a naked type
// parameter distributes over unions, which would turn a `boolean` cell into
// `Ref<true> | Ref<false>` and a `'light' | 'dark'` cell into a union of two refs
// — so `tx.set(ref, 'dark')` would stop type-checking on a perfectly ordinary
// schema. Tuple comparison keeps the union intact.
export type View<S> = [S] extends [CellDef<infer T>]
	? Ref<T, 'cell'>
	: [S] extends [DerivedDef<infer T>]
		? Ref<T, 'derived'>
		: [S] extends [ResourceDef<infer T, infer A>]
			? A extends readonly []
				? Ref<T, 'resource'>
				: // Arguments become path SEGMENTS, so `s.search('ada', 2)` addresses
					// `search/ada/2`. That is what makes the cache per argument set, and
					// what lets staleness, dehydrate, and ports treat it like any address.
					(...args: A) => Ref<T, 'resource'>
			: [S] extends [ActionDef<infer A>]
				? (...args: A) => void
				: [S] extends [TaskDef<infer A, infer R>]
					? (...args: A) => Promise<R>
					: [S] extends [ListDef<infer Sh>]
						? ListView<Sh>
						: [S] extends [SegmentDef<infer K, infer Sh>]
							? SegmentView<K, Sh>
							: IsCell<S> extends true
								? Ref<S, 'cell'>
								: BranchView<S>;

/**
 * A branch is an ADDRESS as well as a container, so it carries `path` like every
 * other node of the accessor tree. `compileSchema` rejects a shape key named
 * `path`, so this cannot shadow an author's own field.
 */
export type BranchView<S> = {
	readonly path: string;
	/** Phantom: what a read of this whole branch yields, so `useValue` can type it. */
	readonly [BRANCH_VALUE]?: Snapshot<S>;
} & {
	readonly [K in keyof S]: View<S[K]>;
};

/** The record a branch read yields, recovered from a branch view. */
export type BranchValueOf<B> = B extends { readonly [BRANCH_VALUE]?: infer V } ? V : unknown;

/**
 * Plain-object projection of a shape, used for bulk load and replace. A resource
 * IS data here: seeding its settled value is how a server-rendered payload is
 * adopted without the client refetching it.
 */
export type Snapshot<S> = [S] extends [CellDef<infer T>]
	? T
	: [S] extends [ResourceDef<infer T, any>]
		? T
		: [S] extends [DerivedDef<any>]
			? never
			: [S] extends [ActionDef<any>]
				? never
				: [S] extends [TaskDef<any>]
					? never
					: [S] extends [ListDef<infer Sh>]
						? Snapshot<Sh>[]
						: [S] extends [SegmentDef<infer K, infer Sh>]
							? Record<K, Snapshot<Sh>>
							: IsCell<S> extends true
								? S
								: { [K in keyof S as IsData<S[K]> extends true ? K : never]: Snapshot<S[K]> };

/** Derived values and actions are not data a caller supplies. */
type IsData<S> = [S] extends [DerivedDef<any>]
	? false
	: [S] extends [ActionDef<any>]
		? false
		: [S] extends [TaskDef<any, any>]
			? false
			: true;

// ── Reading and writing ─────────────────────────────────────────────────────

export type Get = <T>(ref: Ref<T>) => T;

export interface Tx {
	set<T>(ref: Ref<T>, value: T): void;
	update<T>(ref: Ref<T>, fn: (prev: T) => T): void;
	/**
	 * Write several values under one address at once.
	 *
	 * The keys you provide are written; everything else is left alone. So "add a
	 * field" and "overwrite the whole record" are the same operation, and there is
	 * no merge-or-replace flag to get wrong.
	 *
	 * ```ts
	 * tx.patch(s.users.at(id), { name: 'Ada' });          // one field
	 * tx.patch(s.users.at(id), { name: 'Ada', age: 36 }); // the whole record
	 * tx.patch(s.ui, { theme: 'dark', page: 1 });         // a group of cells
	 * ```
	 *
	 * Nested objects recurse. Derived and fetched slots are refused, because
	 * nothing can write them.
	 */
	patch<V>(ref: { readonly path: string; readonly [k: symbol]: unknown }, values: V): void;
	/** Reads staged writes first, so an action sees its own edits. */
	get<T>(ref: Ref<T>): T;
}

/** Run a transaction. Handed to `.with()` so an action needs nothing else. */
export type Act = (fn: (tx: Tx) => void, source?: string) => void;

/**
 * What an async task gets INSTEAD of a `tx`.
 *
 * A `tx` would be a trap here: it is only valid for the duration of one
 * synchronous transaction, so a write placed after an `await` would be staged into
 * a set that had already been committed and would vanish silently. A task gets
 * `act` instead and takes as many commits as the flow needs, each one atomic.
 */
export interface TaskContext {
	readonly act: Act;
	readonly get: Get;
	/** Aborted if the task is superseded; pass it to fetch. */
	readonly signal: AbortSignal;
}

// ── Resources ───────────────────────────────────────────────────────────────

export type ResourceStatus = 'idle' | 'pending' | 'ready' | 'error';

/**
 * Everything a consumer needs to render a fetched value, with no `isLoading`
 * boolean to get wrong. `promise` is the piece a renderer hands to its own
 * suspend primitive; the core stays out of that decision.
 */
export interface ResourceSnapshot<T> {
	readonly status: ResourceStatus;
	readonly value: T | undefined;
	readonly error: unknown;
	/** Non-null exactly while `status` is `'pending'`. */
	readonly promise: Promise<T> | null;
	/** A dependency moved after the value settled, so it is worth refreshing. */
	readonly stale: boolean;
}

export interface LoadContext<A extends readonly unknown[] = []> {
	/** Read other state. Reads are recorded, and a change marks this resource stale. */
	readonly get: Get;
	/** The arguments this address was built with, in declaration order. */
	readonly args: A;
	/** The innermost dynamic segment above this resource, or `''` when there is none. */
	readonly key: string;
	readonly path: string;
	/** Aborted when the load is superseded by a refresh or dropped by `forget`. */
	readonly signal: AbortSignal;
}

export interface SaveContext<T> {
	readonly value: T;
	readonly key: string;
	readonly path: string;
	readonly signal: AbortSignal;
}

export interface LiveContext<T> {
	readonly key: string;
	readonly path: string;
	/** Publish a value pushed from outside, as a normal commit. */
	readonly emit: (value: T) => void;
	readonly fail: (error: unknown) => void;
}

/**
 * The simple case is one async function. The object form adds write-back and an
 * outside push channel, and each part is independent.
 */
export type ResourceImpl<T, A extends readonly unknown[] = []> =
	| ((ctx: LoadContext<A>) => Promise<T> | T)
	| {
			load: (ctx: LoadContext<A>) => Promise<T> | T;
			/** Write-back. `store.save()` applies the value optimistically and rolls it back if this rejects. */
			save?: (ctx: SaveContext<T>) => Promise<void> | void;
			/** An outside push channel, e.g. a socket. Return a teardown. */
			live?: (ctx: LiveContext<T>) => (() => void) | void;
	  };

// ── Implementations ─────────────────────────────────────────────────────────

/** Does this subtree declare anything that needs an implementation? */
export type NeedsImpl<S> = [S] extends [DerivedDef<any>]
	? true
	: [S] extends [ActionDef<any>]
		? true
		: [S] extends [TaskDef<any>]
			? true
			: [S] extends [ResourceDef<any, any>]
				? true
				: [S] extends [ListDef<infer Sh>]
					? NeedsImpl<Sh>
					: [S] extends [SegmentDef<any, infer Sh>]
						? NeedsImpl<Sh>
						: IsCell<S> extends true
							? false
							: true extends { [K in keyof S]: NeedsImpl<S[K]> }[keyof S]
								? true
								: false;

/**
 * Implementation tree passed to `.with()`. Key remapping drops every slot that
 * needs no implementation, so the object is exhaustive by construction:
 * forgetting a derived is a compile error rather than a startup crash.
 *
 * No callback takes a `root` parameter — `.with()` hands the accessor tree to
 * the enclosing closure, so `s` is simply in scope.
 */
export type Impl<S> = [S] extends [DerivedDef<infer T>]
	? (get: Get) => T
	: [S] extends [ResourceDef<infer T, infer A>]
		? ResourceImpl<T, A>
		: [S] extends [ActionDef<infer A>]
			? (tx: Tx, ...args: A) => void
			: [S] extends [TaskDef<infer A, infer R>]
				? (ctx: TaskContext, ...args: A) => Promise<R> | R
				: [S] extends [ListDef<infer Sh>]
					? Impl<Sh>
					: [S] extends [SegmentDef<any, infer Sh>]
						? Impl<Sh>
						: IsCell<S> extends true
							? never
							: { [K in keyof S as NeedsImpl<S[K]> extends true ? K : never]: Impl<S[K]> };

// ── Commits and ports ───────────────────────────────────────────────────────

/** One applied write, as it appears in the serializable commit stream. */
export interface Write {
	readonly path: string;
	readonly prev: unknown;
	readonly next: unknown;
}

export interface Commit {
	readonly id: number;
	/** Names what caused it: an action's path, a port's name, or `'action'`. */
	readonly source: string;
	readonly writes: readonly Write[];
}

export interface PortContext {
	read(path: string): unknown;
	write(path: string, value: unknown): void;
	/**
	 * `*` matches exactly one segment. `**` matches one or more trailing segments
	 * and must be the LAST token: anything after it is not consulted.
	 */
	watch(pattern: string, cb: (path: string) => void): () => void;
	commits(cb: (commit: Commit) => void): () => void;
}

export interface Port {
	readonly name: string;
	attach(ctx: PortContext): void | (() => void);
}

export interface ObserveOptions {
	/** Wake on any write in this node's subtree, not just at the node itself. */
	readonly deep?: boolean;
}

// ── Server rendering ────────────────────────────────────────────────────────

/**
 * A dehydrated store: a FLAT map from path to value, which is what makes the
 * three server-rendering shapes one mechanism rather than three.
 *
 *  * Plain SSR ships the whole map.
 *  * Partial prerendering ships the static slice (`include: ['config/**']`) at
 *    build time and the rest per request; the client merges them.
 *  * Incremental regeneration ships a build-time map plus `at`, and a resource
 *    whose `maxAge` has passed comes back marked stale rather than blocking.
 *
 * Derivations and actions never appear: one is recomputed, the other is code.
 */
export interface Payload {
	/** Format version. Present so a stored payload can be migrated rather than guessed at. */
	readonly v: 1;
	/** Epoch milliseconds this payload was produced, when the producer supplied it. */
	readonly at?: number;
	readonly data: Readonly<Record<string, unknown>>;
}

export interface DehydrateOptions {
	/** Path patterns to include, same grammar as a port watch. Everything, if omitted. */
	readonly include?: readonly string[];
	/** Path patterns to drop, applied after `include`. */
	readonly exclude?: readonly string[];
	/** Stamp the payload with a production time, for a revalidation window. */
	readonly at?: number;
}

export interface HydrateOptions {
	/**
	 * Treat a resource value as stale when the payload is older than this many
	 * milliseconds. It is adopted either way, so the first paint uses it and the
	 * refresh happens behind it.
	 */
	readonly maxAge?: number;
	/** Attribution for the resulting commit. Defaults to `'hydrate'`. */
	readonly source?: string;
	/**
	 * Path patterns this payload is ALLOWED to write. Anything outside them is
	 * dropped, and `rejected` on the result says what was.
	 *
	 * Required in practice for a payload that came back over the wire. Without it
	 * a server response can write any address in the store, including local UI
	 * state the server has no business touching — so a buggy or hostile endpoint
	 * would be able to clobber state a component trusts. Pass the paths the call
	 * site actually expected to change.
	 */
	readonly allow?: readonly string[];
}

export interface HydrateResult {
	/** Paths that were written. */
	readonly applied: readonly string[];
	/** Paths dropped because `allow` did not cover them. */
	readonly rejected: readonly string[];
	/** Paths dropped because the current schema does not describe them. */
	readonly unknown: readonly string[];
}

export type Dispose = () => void;

/** What kind of thing an address names. See `store.kindOf`. */
export type AddressKind = 'cell' | 'derived' | 'resource' | 'action' | 'branch' | 'bulk';
