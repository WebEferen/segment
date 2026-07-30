// The same store WITHOUT `.with()`: every computed thing is an ordinary exported
// function or constant.
//
// Typechecked, because this is the alternative the README offers and an unverified
// alternative is a trap.
import { createStore, segment } from '../src/core/index.js';

type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
type Expect<T extends true> = T;

// ── The store: pure data, and nothing declared twice ────────────────────────

export const store = createStore({
	ui: { query: '', page: 1 },
	users: segment({ name: '', votes: 0 }),
});

export const s = store.state;

// ── A derivation: created once, at module scope ─────────────────────────────

export const queryLength = store.derive((get) => get(s.ui.query).length);

// ── A getter and a setter, as plain functions ──────────────────────────────
//
// These are for OUTSIDE a render: an event handler, module code, a port, a test.
// `getUserName` reads synchronously and does not subscribe, so a component that
// called it would never re-render. Inside a render use
// `useValue(s.users.at(id).name)`, which is the only thing that can subscribe,
// wait, and clean up after itself.

export function getUserName(id: string): string {
	return store.get(s.users.at(id).name);
}

// No source string: in development the commit is named after the calling function,
// so devtools shows `setUserName` without you writing it. Pass one explicitly when
// you want a name that is not the function's.
export function setUserName(id: string, name: string): void {
	store.set(s.users.at(id).name, name);
}

export function upvote(id: string): void {
	store.update(s.users.at(id).votes, (n) => n + 1);
}

/** Several writes that have to land together still go through one transaction. */
export function resetUser(id: string): void {
	store.act((tx) => {
		tx.set(s.users.at(id).name, '');
		tx.set(s.users.at(id).votes, 0);
	});
}

// ── A fetched value: an exported function you call with arguments ───────────
//
// The arguments become path segments, so two callers passing the same id share one
// fetch and one cache entry, exactly as a declared `resource()` would.
//
// In a component: const [name] = useValue(fetchUserName(id));

export const fetchUserName = store.resourceOf<string, [id: string]>(
	async ({ args: [id], signal }) => (await fetch(`/api/users/${id}/name`, { signal })).text(),
);

export const nameAddress = fetchUserName('u1');
export type _AddressHasPath = Expect<Equal<typeof nameAddress.path, string>>;

// ── An async flow: an ordinary async exported function ─────────────────────
//
// Each `store.set` inside is its own commit, exactly as a declared `task()` would
// be. What you give up is the task's automatic status/result/error addresses: keep
// progress in a cell of your own if a component has to render it.

export async function publish(label: string): Promise<string> {
	store.set(s.ui.page, 1);
	const response = await fetch('/api/publish', { method: 'POST', body: label });
	// A write AFTER the await is a separate commit, which is the honest shape: this
	// flow was never one transaction.
	store.set(s.ui.query, label);
	return response.text();
}

export type _PublishReturns = Expect<Equal<Awaited<ReturnType<typeof publish>>, string>>;
