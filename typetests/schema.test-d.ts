// The S1 gates, pinned against the API as it now stands.
//
// Every assertion is an EXACT equality built on the invariant-function trick, so
// `Equal<any, X>` is false. That matters more than it looks: the failure mode
// this file exists to catch is a schema whose inference silently collapsed to
// `any`, which typechecks green while offering no safety at all.
import { action, cell, createStore, derived, list, resource, segment } from '../src/core/index.js';
import type { Get, Impl, LoadContext, Ref, Snapshot, Tx, View } from '../src/core/index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type ExpectNot<T extends false> = T;

// Pin the helper itself.
export type _AnyIsCaught = ExpectNot<Equal<any, string>>;
export type _NarrowIsNotWide = ExpectNot<Equal<'a', string>>;

type UserId = string & { readonly __brand: 'UserId' };

const shape = {
	// Raw values ARE the declaration. No marker, and they widen, so a cell holding
	// 'light' still accepts 'dark'.
	ui: { theme: 'light', count: 0, ready: false },
	tags: ['a', 'b'],
	when: new Date(0),
	point: cell({ x: 0, y: 0 }),
	users: segment<UserId>()({
		name: '',
		age: 0,
		label: derived<string>(),
		avatar: resource<string>(),
	}),
	cart: {
		items: list({ sku: '', qty: 1 }),
		total: derived<number>(),
		add: action<[sku: string, qty: number]>(),
	},
};

type Shape = typeof shape;

const store = createStore(shape).with((s, act) => ({
	users: {
		label: (get) => get(s.ui.theme).toUpperCase(),
		avatar: ({ key, signal }: LoadContext) => fetch(`/a/${key}`, { signal }).then((r) => r.text()),
	},
	cart: {
		total: (get) => get(s.cart.items.at(0).qty) * 2,
		add: (tx, sku, qty) => {
			tx.set(s.cart.items.at(0).sku, sku);
			tx.set(s.cart.items.at(0).qty, qty);
			act(() => {});
		},
	},
}));

const s = store.state;
declare const uid: UserId;

// The second type argument is the address KIND. It is what lets `useValue` type
// its setter as `never` for anything the store computes rather than stores, so it
// belongs in these assertions.
// ── Raw values become cells of the WIDENED type ─────────────────────────────
export type _CellString = Expect<Equal<typeof s.ui.theme, Ref<string, 'cell'>>>;
export type _CellNumber = Expect<Equal<typeof s.ui.count, Ref<number, 'cell'>>>;
export type _CellBoolean = Expect<Equal<typeof s.ui.ready, Ref<boolean, 'cell'>>>;
// An array is a value, not a branch and not an addressable list.
export type _CellArray = Expect<Equal<typeof s.tags, Ref<string[], 'cell'>>>;
export type _CellDate = Expect<Equal<typeof s.when, Ref<Date, 'cell'>>>;
// A plain object needs cell() to stay one value.
export type _CellObject = Expect<Equal<typeof s.point, Ref<{ x: number; y: number }, 'cell'>>>;

// A widened cell accepts another value of the same type.
store.act((tx) => tx.set(s.ui.theme, 'dark'));

// ── Markers ─────────────────────────────────────────────────────────────────
export type _SegmentCell = Expect<
	Equal<ReturnType<typeof s.users.at>['name'], Ref<string, 'cell'>>
>;
export type _SegmentDerived = Expect<
	Equal<ReturnType<typeof s.users.at>['label'], Ref<string, 'derived'>>
>;
export type _SegmentResource = Expect<
	Equal<ReturnType<typeof s.users.at>['avatar'], Ref<string, 'resource'>>
>;
export type _ListCell = Expect<
	Equal<ReturnType<typeof s.cart.items.at>['qty'], Ref<number, 'cell'>>
>;
export type _Derived = Expect<Equal<typeof s.cart.total, Ref<number, 'derived'>>>;
export type _Action = Expect<Equal<typeof s.cart.add, (sku: string, qty: number) => void>>;

// ── Keys are enforced, not widened ─────────────────────────────────────────
export type _SegmentKey = Expect<Equal<Parameters<typeof s.users.at>[0], UserId>>;
export type _ListIndex = Expect<Equal<Parameters<typeof s.cart.items.at>[0], number>>;
export const okKey = s.users.at(uid);
// @ts-expect-error a bare string is not a UserId
export const badKey = s.users.at('plain');

// ── Reads carry the value type through ─────────────────────────────────────
const theme = store.get(s.ui.theme);
const count = store.get(s.ui.count);
export type _ReadString = Expect<Equal<typeof theme, string>>;
export type _ReadNumber = Expect<Equal<typeof count, number>>;

const snap = store.resource(s.users.at(uid).avatar);
export type _ResourceValue = Expect<Equal<typeof snap.value, string | undefined>>;
export type _ResourcePromise = Expect<Equal<typeof snap.promise, Promise<string> | null>>;

// ── Refs are invariant, so a value type cannot be laundered ────────────────
// @ts-expect-error Ref<number> is not a Ref<string>
export const laundered: Ref<string> = s.ui.count;

// @ts-expect-error a string is not assignable to a number cell
store.act((tx) => tx.set(s.ui.count, 'nope'));

// @ts-expect-error saving the wrong type into a resource
void store.save(s.users.at(uid).avatar, 42);

// ── Snapshot carries DATA only, including resource values for rehydration ──
type UserSnapshot = Snapshot<Shape>['users'][UserId];
export type _SnapshotKeys = Expect<Equal<keyof UserSnapshot, 'name' | 'age' | 'avatar'>>;
export type _SnapshotTypes = Expect<
	Equal<UserSnapshot, { name: string; age: number; avatar: string }>
>;
type CartSnapshot = Snapshot<Shape>['cart'];
export type _CartSnapshotKeys = Expect<Equal<keyof CartSnapshot, 'items'>>;

// ── .with() is exhaustive by construction ──────────────────────────────────
type Required_ = Impl<Shape>;
export type _ImplCartKeys = Expect<Equal<keyof Required_['cart'], 'total' | 'add'>>;
export type _ImplUserKeys = Expect<Equal<keyof Required_['users'], 'label' | 'avatar'>>;
// `ui`, `tags`, `when`, and `point` hold only data, so they must not appear.
export type _ImplTopKeys = Expect<Equal<keyof Required_, 'users' | 'cart'>>;

// No implementation callback takes a `root`: `.with()` puts `s` in scope.
export type _DerivedImpl = Expect<Equal<Required_['cart']['total'], (get: Get) => number>>;
export type _ActionImpl = Expect<
	Equal<Required_['cart']['add'], (tx: Tx, sku: string, qty: number) => void>
>;

type Complete = {
	users: { label: (get: Get) => string; avatar: (ctx: LoadContext) => Promise<string> };
	cart: {
		total: (get: Get) => number;
		add: (tx: Tx, sku: string, qty: number) => void;
	};
};
type MissingDerived = { users: Complete['users']; cart: { add: Complete['cart']['add'] } };
type MissingBranch = { cart: Complete['cart'] };
type WrongReturn = {
	users: Complete['users'];
	cart: { total: (get: Get) => string; add: Complete['cart']['add'] };
};
type WrongArgs = {
	users: Complete['users'];
	cart: { total: Complete['cart']['total']; add: (tx: Tx, sku: number, qty: number) => void };
};

export type _CompleteAccepted = Expect<Equal<Complete extends Required_ ? true : false, true>>;
export type _MissingDerivedRejected = Expect<
	Equal<MissingDerived extends Required_ ? true : false, false>
>;
export type _MissingBranchRejected = Expect<
	Equal<MissingBranch extends Required_ ? true : false, false>
>;
export type _WrongReturnRejected = Expect<
	Equal<WrongReturn extends Required_ ? true : false, false>
>;
export type _WrongArgsRejected = Expect<Equal<WrongArgs extends Required_ ? true : false, false>>;

// ── Recursive shapes ───────────────────────────────────────────────────────
// A comment tree cannot be inferred from a literal, so the API must accept an
// explicitly declared recursive shape. S1 measured this working to ten levels.
import type { CellDef, ListDef, SegmentDef } from '../src/core/index.js';

interface CommentShape {
	text: CellDef<string>;
	replies: ListDef<CommentShape>;
}
interface TreeSchema {
	comments: SegmentDef<string, CommentShape>;
}
declare const tree: View<TreeSchema>;
const nested = tree.comments.at('c1').replies.at(0).replies.at(1).replies.at(2);
export type _RecursiveLeaf = Expect<Equal<typeof nested.text, Ref<string, 'cell'>>>;
