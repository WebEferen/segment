// The Octane binding exposed by the main `segment-state` entry point.
//
// Three hooks, and only the first is needed to read anything:
//
//   useValue   READ ANY ADDRESS. Returns [value, setter]. Waits if the address is
//              fetched. The setter's type is `never` unless it is a writable cell.
//   useStatus  the same address WITHOUT waiting, when you want to draw the loading
//              and error states yourself
//   useDraft   a local edit that publishes on demand, for a Save button
//
// You never combine them on one address. `useValue` deliberately does not ask you to
// know what KIND of address you are reading: needing to know that before you could
// read it is what made an earlier four-hook surface confusing.
//
// Nothing else is needed: actions are plain functions on the accessor tree, so you
// call `s.cart.add('sku')` directly.
//
// No provider, and no context lookup on the read path: a ref knows which store it
// belongs to, so `useValue(ref)` is self-sufficient. On the server you create a
// store per request and pass that request's `s` down — a module-global store
// would be shared between concurrent requests, which is a correctness bug, not a
// style question.
//
// What this takes from Octane, and why each one matters:
//
//  * Compiler-assigned hook slots, so `subscribe` and `getSnapshot` are allocated
//    ONCE PER COMPONENT rather than once per render. Every existing store binding
//    in this repo reallocates them every render.
//  * `use()` for resource reads, so several independent resources in one component
//    are batched into one suspend and fetched IN PARALLEL. React runs the same
//    code as a waterfall.
//  * `useLinkedState` for `useDraft`, so a moved source reconciles inside the same
//    render instead of scheduling a setter from an effect.
//  * Block granularity: a hook inside a `@for` item body wakes only that item's
//    block, not the list.
//  * `revision()` for branch reads, so a whole subtree is one integer compare.
import { use, useEffect, useLinkedState, useMemo, useSyncExternalStore } from 'octane';
import { storeOf } from '../core/store.js';
import type {
	AddressKind,
	BranchValueOf,
	Get,
	Ref,
	ResourceSnapshot,
	Store,
	ValueTuple,
	View,
} from '../core/index.js';
import { splitSlot, subSlot } from './internal.js';

/**
 * `Ref<T>`'s phantom field is invariant on purpose, so `Ref<T>` is not assignable
 * to `Ref<unknown>`. The binding addresses refs structurally for the same reason
 * the core does, rather than weakening that guarantee for consumers.
 */
type AnyRef = Ref<unknown>;

function ownerOf(ref: { readonly path: string }): Store<unknown> {
	const store = storeOf(ref) as Store<unknown> | null;
	if (store === null) {
		throw new Error(
			'[segment-state] this ref has no owning store. Build refs from ' +
				'`store.state` or `store.ref(path)` rather than by hand.',
		);
	}
	return store;
}

interface Binding {
	subscribe: (onChange: () => void) => () => void;
	snapshot: () => unknown;
	/** A leaf can be gated on its value; a branch cannot (see below). */
	leaf: boolean;
	/** A real setter for a cell; the loud stand-in for anything else. */
	set: unknown;
}

/**
 * Stands in for the setter of a non-writable address. Its TYPE is `never`, so a
 * TypeScript caller cannot reach here at all; this exists for a JavaScript caller
 * and says which hook to use instead of failing somewhere unrelated.
 */
const NOT_WRITABLE = () => {
	throw new Error(
		'[segment-state] this value cannot be written. You can write anything you ' +
			'declared as a plain value; the store computes derived() and fetches ' +
			'resource(), and an object in your shape just groups other values.',
	);
};

/**
 * One allocation per component per address, not one per render. The compiler slot
 * is what makes this possible — without a stable slot there is nowhere to keep
 * the pair, which is why an inline `getSnapshot` is the norm elsewhere.
 */
function bindingFor(ref: AnyRef, store: Store<unknown>, slot: symbol | undefined): Binding {
	return useMemo(
		() => {
			const kind = store.kindOf(ref);
			if (kind === 'action') {
				throw new Error(
					`[segment-state] "${ref.path}" is something you call, not something you ` +
						'read. Call it directly: `s.cart.add("sku")`.',
				);
			}
			if (kind === 'resource') {
				throw new Error(
					`[segment-state] "${ref.path}" is fetched, so reading it means waiting. ` +
						'Use useResource() to wait for the value, or useStatus() to draw the ' +
						'loading and error states yourself.',
				);
			}
			const leaf = kind === 'cell' || kind === 'derived';
			return {
				subscribe: (onChange: () => void) => store.observe(ref, onChange),
				// A branch is gated on `revision`, not on its value. Writes go THROUGH
				// to the bulk value in place, so a branch object's identity never
				// changes and a value snapshot would report "unchanged" forever.
				snapshot: leaf ? () => store.get(ref) : () => store.revision(ref),
				leaf,
				set:
					kind === 'cell'
						? (next: unknown) =>
								typeof next === 'function'
									? store.update(ref, next as (prev: unknown) => unknown, ref.path)
									: store.set(ref, next, ref.path)
						: NOT_WRITABLE,
			};
		},
		[store, ref.path],
		subSlot(slot, 'bind'),
	);
}

/**
 * Read an address, and write it back when it is writable.
 *
 * ```tsx
 * const [theme, setTheme] = useValue(s.ui.theme);   // you declared it: writable
 * const [total] = useValue(s.cart.total);           // derived(): read only
 * const [user] = useValue(s.users.at(id));          // a group: the whole record
 * const [label] = useValue(store, (get, s) => …);   // computed here: read only
 * ```
 *
 * You get a setter for anything you declared as a plain value. For a `derived()`,
 * for a group of values, or for a computation done here, the setter's TYPE is
 * `never`, so taking it is a compile error rather than a runtime surprise. One
 * read/write hook must not hand back a setter that could not work.
 *
 * Each write is its own commit, attributed to the address. Use `useDraft` when the
 * write should wait for a Save button, and `store.act` when several writes have to
 * land together.
 *
 * Reading a group wakes on any write inside it, decided by one integer compare
 * rather than by diffing the object. Treat the record as read-only: mutating it
 * writes into the store behind its back, with nothing notified.
 *
 * A fetched value waits through Octane's suspense model. Use `useStatus` instead
 * when the component should draw the pending and error states itself.
 */
export function useValue<T, K extends AddressKind>(ref: Ref<T, K>): ValueTuple<T, K>;
export function useValue<const T extends readonly Ref<unknown>[]>(
	refs: T,
): [{ -readonly [K in keyof T]: T[K] extends Ref<infer V, AddressKind> ? V : never }, never];
export function useValue<B extends { readonly path: string }>(
	branch: B,
): [BranchValueOf<B> | undefined, never];
export function useValue<S, T>(store: Store<S>, select: (get: Get, s: View<S>) => T): [T, never];
export function useValue(...args: unknown[]): [unknown, unknown] {
	const [rest, slot] = splitSlot(args);
	if (typeof rest[1] === 'function') {
		return [
			selected(
				rest[0] as Store<unknown>,
				rest[1] as (get: Get, s: unknown) => unknown,
				subSlot(slot, 'sel'),
			),
			NOT_WRITABLE,
		];
	}
	if (Array.isArray(rest[0])) {
		return [awaitAll(rest[0] as readonly AnyRef[], subSlot(slot, 'all')), NOT_WRITABLE];
	}
	const ref = rest[0] as AnyRef;
	const store = ownerOf(ref);
	if (store.kindOf(ref) === 'resource') {
		return [awaited(ref, store, subSlot(slot, 'await')), NOT_WRITABLE];
	}
	const binding = bindingFor(ref, store, subSlot(slot, 'v'));
	const snapshot = useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		// Server and client read the same store API, so one function serves both and
		// hydration adopts the server's value before the commit-time re-check.
		binding.snapshot,
		subSlot(slot, 'store'),
	);
	// The setter is allocated once per component, alongside the binding, so the
	// read-only case pays nothing for the pair it does not use.
	return [binding.leaf ? snapshot : store.get(ref), binding.set];
}

/**
 * The selector form of `useValue`.
 *
 * The selector is NOT evaluated during render. On mount it becomes an anonymous
 * derivation owned by this call site, so from then on it behaves exactly like a
 * derivation declared in the schema: cached, glitch-free, and re-run only when a
 * dependency it actually read has moved — not on every commit, which is what a
 * render-time selector costs elsewhere. The compiler-assigned slot is what makes
 * "owned by this call site" possible.
 *
 * Released on unmount, because a per-instance derivation in a long list would
 * otherwise accumulate one dead node per row.
 */
function selected<T>(store: Store<unknown>, select: (get: Get, s: unknown) => T, slot: symbol): T {
	const ref = useMemo(
		() => store.derive((get) => select(get, store.state)),
		[store, select],
		subSlot(slot, 'derive'),
	) as Ref<T>;
	useEffect(() => () => store.release(ref as AnyRef), [store, ref], subSlot(slot, 'free'));
	const address = ref as AnyRef;
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => store.observe(address, onChange),
			snapshot: () => store.get(address),
		}),
		[store, address.path],
		subSlot(slot, 'bind'),
	);
	return useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		binding.snapshot,
		subSlot(slot, 'store'),
	) as T;
}

/**
 * Read a `resource()` and return **its value** — not a promise. The component
 * waits while the load is in flight, and the error is thrown to the nearest
 * `@catch`.
 *
 * Named after the thing it reads, so the schema and the hook use one word for one
 * concept: `avatar: resource<string>()` is read with `useResource(s.….avatar)`.
 *
 * ```tsx
 * const avatar = useResource(s.users.at(id).avatar);
 * const [a, b] = useResource([s.users.at(x).avatar, s.users.at(y).avatar]);
 * ```
 *
 * Pass an ARRAY to wait for several at once: every load starts before anything
 * suspends, so the requests overlap and the component suspends once. Two separate
 * calls cannot do that — the first suspends by throwing, so the second never runs.
 */
function awaited(ref: AnyRef, store: Store<unknown>, slot: symbol): unknown {
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => store.observe(ref, onChange),
			snapshot: () => store.revision(ref),
		}),
		[store, ref.path],
		subSlot(slot, 'bind'),
	);
	useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		binding.snapshot,
		subSlot(slot, 'store'),
	);
	const snap = store.resource(ref);
	if (snap.status === 'error') throw snap.error;
	if (snap.status === 'pending') return use(snap.promise!);
	return snap.value;
}

/**
 * The array form of `useResource`. Starts every load BEFORE waiting on any of them,
 * which is the only way to overlap the requests: a single `useResource` suspends by
 * throwing, so a second call placed after it would never run and its load would
 * never begin.
 */
function awaitAll(refs: readonly AnyRef[], slot: symbol | undefined): unknown[] {
	const store = ownerOf(refs[0]);
	const key = refs.map((ref) => ref.path).join('|');
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => {
				const disposers = refs.map((ref) => store.observe(ref, onChange));
				return () => {
					for (const dispose of disposers) dispose();
				};
			},
			// One number covering every member, so the gate stays a single compare.
			snapshot: () => {
				let sum = 0;
				for (const ref of refs) sum += store.revision(ref);
				return sum;
			},
		}),
		[store, key],
		subSlot(slot, 'bind'),
	);
	useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		binding.snapshot,
		subSlot(slot, 'store'),
	);

	// Read every snapshot FIRST. Reading one starts its load, so by the time
	// anything suspends they are all in flight.
	const snaps = refs.map((ref) => store.resource(ref));
	for (const snap of snaps) if (snap.status === 'error') throw snap.error;
	const pending = snaps.filter((snap) => snap.status === 'pending');
	// One combined wait, so the component suspends once rather than per member.
	if (pending.length > 0) use(Promise.all(pending.map((snap) => snap.promise!)));
	return snaps.map((snap) => snap.value);
}

/**
 * A resource's full state, without ever suspending. Reach for this when you want
 * to draw the pending or failed case yourself.
 *
 * ```tsx
 * const avatar = useStatus(s.users.at(id).avatar);
 * @if (avatar.status === 'error') { <Retry onClick={() => store.refresh(…)} /> }
 * ```
 */
export function useStatus<T>(ref: Ref<T>): ResourceSnapshot<T>;
export function useStatus<T>(...args: unknown[]): ResourceSnapshot<T> {
	const [rest, slot] = splitSlot(args);
	const ref = rest[0] as AnyRef;
	const store = ownerOf(ref);
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => store.observe(ref, onChange),
			snapshot: () => store.revision(ref),
		}),
		[store, ref.path],
		subSlot(slot, 'bind'),
	);
	useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		binding.snapshot,
		subSlot(slot, 'store'),
	);
	return store.resource(ref) as ResourceSnapshot<T>;
}

/**
 * A local editable copy of a stored value, for a form.
 *
 * ```tsx
 * const [name, setName, publish] = useDraft(s.users.at(id).name);
 * <input value={name} onInput={(e) => setName(e.currentTarget.value)} />
 * <button onClick={publish}>Save</button>
 * ```
 *
 * When the stored value moves underneath an unsaved draft, the two reconcile in
 * the SAME render through `useLinkedState` — no effect fires a setter a frame
 * later, so the input never flashes the old value.
 */
export function useDraft<T>(ref: Ref<T>): [T, (next: T) => void, () => void];
export function useDraft<T>(...args: unknown[]): [T, (next: T) => void, () => void] {
	const [rest, slot] = splitSlot(args);
	const ref = rest[0] as AnyRef;
	const store = ownerOf(ref);
	// Composed hook: forward a sub-slot through the implementation signature, which
	// the public overload deliberately hides from callers.
	const source = (useValue as unknown as (r: AnyRef, sub: symbol) => [T, unknown])(
		ref,
		subSlot(slot, 'src'),
	)[0];
	const [draft, setDraft, getDraft] = useLinkedState<T, T>(
		source,
		(next) => next,
		undefined,
		subSlot(slot, 'linked'),
	);
	const publish = useMemo(
		() =>
			// A fetched address publishes through `save`, which applies the value
			// optimistically and restores it if the round trip rejects. Routing it here
			// means a draft over fetched data does not need a different call at the site.
			store.kindOf(ref) === 'resource'
				? () => void store.save(ref as Ref<T>, getDraft())
				: () => store.set(ref as Ref<T>, getDraft(), `draft:${ref.path}`),
		[store, ref.path],
		subSlot(slot, 'publish'),
	);
	return [draft, setDraft as (next: T) => void, publish];
}
