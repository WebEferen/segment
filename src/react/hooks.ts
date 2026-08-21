// The React binding exposed by the `segment-state/react` entry point.
//
// The same three hooks as the Octane binding, with the same contract:
//
//   useValue   READ ANY ADDRESS. Returns [value, setter]. Waits if the address is
//              fetched. The setter's type is `never` unless it is a writable cell.
//   useStatus  the same address WITHOUT waiting, when you want to draw the loading
//              and error states yourself
//   useDraft   a local edit that publishes on demand, for a Save button
//
// You never combine them on one address, and `useValue` deliberately does not ask
// you to know what KIND of address you are reading. Actions are plain functions on
// the accessor tree, so you call `s.cart.add('sku')` directly.
//
// No provider, and no context lookup on the read path: a ref knows which store it
// belongs to, so `useValue(ref)` is self-sufficient. On the server you create a
// store per request and pass that request's `s` down; a module-global store would
// be shared between concurrent requests, which is a correctness bug, not a style
// question.
//
// Where this differs from the Octane binding, and why:
//
//  * React has no compiler-assigned hook slots, so each binding is kept in a
//    `useMemo` keyed by `[store, ref.path]`: one allocation per component per
//    address, re-created only when the address itself changes.
//  * Resource reads suspend through React 19's `use()`. A single `useValue` call
//    over an ARRAY of resources still starts every load before waiting on any of
//    them; two separate calls cannot, because the first suspends by throwing.
//  * `useDraft` reconciles a moved source through React's render-phase state
//    adjustment, so the two meet in the SAME render and the input never flashes
//    the old value.
//  * Notification granularity is the component: a woken hook re-renders the
//    component that called it, which is React's model. The store-side economics
//    (targeted wake-ups, O(observed) memory, reversible materialization) are
//    identical to the Octane binding because they live in the core.
import { use, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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

function bindingFor(ref: AnyRef, store: Store<unknown>): Binding {
	return useMemo(() => {
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
					'useValue() waits for the value; useStatus() lets you draw the loading ' +
					'and error states yourself.',
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
	}, [store, ref.path]);
}

/**
 * Read an address, and write it back when it is writable.
 *
 * ```tsx
 * const [theme, setTheme] = useValue(s.ui.theme);   // you declared it: writable
 * const [total] = useValue(s.cart.total);           // derived(): read only
 * const [user] = useValue(s.users.at(id));          // a group: the whole record
 * const [label] = useValue(store, selectLabel);     // computed here: read only
 * ```
 *
 * You get a setter for anything you declared as a plain value. For a `derived()`,
 * for a group of values, or for a computation done here, the setter's TYPE is
 * `never`, so taking it is a compile error rather than a runtime surprise.
 *
 * Each write is its own commit, attributed to the address. Use `useDraft` when the
 * write should wait for a Save button, and `store.act` when several writes have to
 * land together.
 *
 * Reading a group wakes on any write inside it, decided by one integer compare
 * rather than by diffing the object. Treat the record as read-only: mutating it
 * writes into the store behind its back, with nothing notified.
 *
 * A fetched value waits through React's suspense model (`use()`). Use `useStatus`
 * instead when the component should draw the pending and error states itself.
 *
 * One call site must keep one argument shape: a ref stays a ref, an array stays an
 * array, a selector stays a selector. That is what keeps React's hook order stable.
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
	if (typeof args[1] === 'function') {
		return [
			selected(args[0] as Store<unknown>, args[1] as (get: Get, s: unknown) => unknown),
			NOT_WRITABLE,
		];
	}
	if (Array.isArray(args[0])) {
		return [awaitAll(args[0] as readonly AnyRef[]), NOT_WRITABLE];
	}
	const ref = args[0] as AnyRef;
	const store = ownerOf(ref);
	if (store.kindOf(ref) === 'resource') {
		return [awaited(ref, store), NOT_WRITABLE];
	}
	const binding = bindingFor(ref, store);
	const snapshot = useSyncExternalStore(
		binding.subscribe,
		binding.snapshot,
		// Server and client read the same store API, so one function serves both and
		// hydration adopts the server's value before the commit-time re-check.
		binding.snapshot,
	);
	return [binding.leaf ? snapshot : store.get(ref), binding.set];
}

/**
 * The selector form of `useValue`.
 *
 * The selector is NOT evaluated per commit. When the component subscribes it
 * becomes an anonymous derivation owned by this hook instance, so from then on it
 * behaves exactly like a derivation declared in the schema: cached, glitch-free,
 * and re-run only when a dependency it actually read has moved, not on every
 * commit, which is what a render-time selector costs elsewhere.
 *
 * The derivation is created inside `subscribe` and released inside its cleanup, so
 * render stays pure and Strict Mode's mount/unmount/mount cycle re-creates it
 * cleanly; React guarantees the two are paired. A render that has not subscribed
 * yet (the first one, and the server) evaluates the selector once without
 * registering anything.
 *
 * Pass a referentially stable `select` (module scope or `useCallback`): a new
 * function identity re-creates the derivation and its subscription.
 */
function selected<T>(store: Store<unknown>, select: (get: Get, s: unknown) => T): T {
	const binding = useMemo(() => {
		let ref: AnyRef | null = null;
		const once: Get = (target) => store.get(target);
		return {
			subscribe: (onChange: () => void) => {
				ref ??= store.derive((get) => select(get, store.state)) as AnyRef;
				const stop = store.observe(ref, onChange);
				return () => {
					stop();
					if (ref !== null) {
						// Released on unsubscribe, because a per-instance derivation in a
						// long list would otherwise accumulate one dead node per row.
						store.release(ref);
						ref = null;
					}
				};
			},
			snapshot: () => (ref === null ? select(once, store.state) : store.get(ref)),
		};
	}, [store, select]);
	return useSyncExternalStore(binding.subscribe, binding.snapshot, binding.snapshot) as T;
}

/**
 * Read a `resource()` through `useValue` and return **its value**, not a promise.
 * The component suspends while the load is in flight, and the error is thrown to
 * the nearest error boundary.
 *
 * ```tsx
 * const [avatar] = useValue(s.users.at(id).avatar);
 * const [[a, b]] = useValue([s.users.at(x).avatar, s.users.at(y).avatar]);
 * ```
 *
 * Pass an ARRAY to wait for several at once: every load starts before anything
 * suspends, so the requests overlap. Two separate calls cannot do that, because
 * the first suspends by throwing and the second never runs.
 */
function awaited(ref: AnyRef, store: Store<unknown>): unknown {
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => store.observe(ref, onChange),
			snapshot: () => store.revision(ref),
		}),
		[store, ref.path],
	);
	useSyncExternalStore(binding.subscribe, binding.snapshot, binding.snapshot);
	const snap = store.resource(ref);
	if (snap.status === 'error') throw snap.error;
	if (snap.status === 'pending') return use(snap.promise!);
	return snap.value;
}

/**
 * The array form. Reads every snapshot FIRST, which starts every load, and only
 * then waits; `use()` is sanctioned in a loop, and each promise here is cached by
 * the store, so a wait that resumes re-reads settled snapshots and suspends only
 * on what is still in flight. The fetches themselves always run in parallel.
 */
function awaitAll(refs: readonly AnyRef[]): unknown[] {
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
	);
	useSyncExternalStore(binding.subscribe, binding.snapshot, binding.snapshot);

	const snaps = refs.map((ref) => store.resource(ref));
	for (const snap of snaps) if (snap.status === 'error') throw snap.error;
	for (const snap of snaps) if (snap.status === 'pending') use(snap.promise!);
	return snaps.map((snap) => snap.value);
}

/**
 * A resource's full state, without ever suspending. Reach for this when you want
 * to draw the pending or failed case yourself.
 *
 * ```tsx
 * const avatar = useStatus(s.users.at(id).avatar);
 * if (avatar.status === 'error') return <Retry onClick={() => store.refresh(…)} />;
 * ```
 */
export function useStatus<T>(ref: Ref<T>): ResourceSnapshot<T> {
	const target = ref as AnyRef;
	const store = ownerOf(target);
	const binding = useMemo(
		() => ({
			subscribe: (onChange: () => void) => store.observe(target, onChange),
			snapshot: () => store.revision(target),
		}),
		[store, target.path],
	);
	useSyncExternalStore(binding.subscribe, binding.snapshot, binding.snapshot);
	return store.resource(target) as ResourceSnapshot<T>;
}

/**
 * A local editable copy of a stored value, for a form.
 *
 * ```tsx
 * const [name, setName, publish] = useDraft(s.users.at(id).name);
 * <input value={name} onChange={(e) => setName(e.currentTarget.value)} />
 * <button onClick={publish}>Save</button>
 * ```
 *
 * When the stored value moves underneath an unsaved draft, the draft adopts it in
 * the SAME render through React's render-phase state adjustment; no effect fires a
 * setter a frame later, so the input never flashes the old value.
 */
export function useDraft<T>(ref: Ref<T>): [T, (next: T) => void, () => void] {
	const target = ref as AnyRef;
	const store = ownerOf(target);
	const [source] = useValue(ref);
	const [state, setState] = useState({ draft: source, source });
	let draft = state.draft;
	if (!Object.is(state.source, source)) {
		draft = source;
		setState({ draft: source, source });
	}
	// `publish` stays identity-stable across edits, so it reads the draft through a
	// box. The box is written where the draft moves: on render (covers adoption)
	// and synchronously in `setDraft` (covers publish in the same event handler).
	const box = useRef({ draft });
	box.current.draft = draft;
	const handlers = useMemo(
		() => ({
			setDraft: (next: T) => {
				box.current.draft = next;
				setState((prev) => ({ draft: next, source: prev.source }));
			},
			// A fetched address publishes through `save`, which applies the value
			// optimistically and restores it if the round trip rejects. Routing it here
			// means a draft over fetched data does not need a different call at the site.
			publish:
				store.kindOf(target) === 'resource'
					? () => void store.save(ref, box.current.draft)
					: () => store.set(ref, box.current.draft, `draft:${target.path}`),
		}),
		[store, target.path],
	);
	return [draft, handlers.setDraft, handlers.publish];
}
