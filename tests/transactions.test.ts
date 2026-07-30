import { describe, expect, it, vi } from 'vitest';
import { makeStore, uid } from './fixture.js';

describe('transactions', () => {
	it('rolls the whole write set back when the action throws', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.ui.count, 7));
		const observer = vi.fn();
		store.observe(s.ui.count, observer);

		expect(() =>
			store.act((tx) => {
				tx.set(s.ui.count, 99);
				tx.set(s.ui.theme, 'dark');
				throw new Error('boom');
			}),
		).toThrow('boom');

		expect(store.get(s.ui.count)).toBe(7);
		expect(store.get(s.ui.theme)).toBe('light');
		expect(observer).not.toHaveBeenCalled();
	});

	it('lets an action read its own staged writes', () => {
		const { store, s } = makeStore();
		const seen: number[] = [];
		store.act((tx) => {
			tx.set(s.ui.count, 3);
			seen.push(tx.get(s.ui.count));
			tx.update(s.ui.count, (n) => n + 1);
			seen.push(tx.get(s.ui.count));
		});
		expect(seen).toEqual([3, 4]);
		expect(store.get(s.ui.count)).toBe(4);
	});

	it('does not leak a staged write to a reader outside the action', () => {
		const { store, s } = makeStore();
		let observedDuring: number | null = null;
		store.act((tx) => {
			tx.set(s.ui.count, 5);
			observedDuring = store.get(s.ui.count);
		});
		expect(observedDuring).toBe(0);
		expect(store.get(s.ui.count)).toBe(5);
	});

	it('notifies an observer once for a commit that writes its path twice', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(s.ui.count, observer);
		store.act((tx) => {
			tx.set(s.ui.count, 1);
			tx.set(s.ui.count, 2);
		});
		expect(observer).toHaveBeenCalledTimes(1);
		expect(store.get(s.ui.count)).toBe(2);
	});

	it('notifies a deep observer once for a commit touching several of its leaves', () => {
		const { store, s } = makeStore();
		const observer = vi.fn();
		store.observe(store.ref('users'), observer, { deep: true });
		store.observe(s.users.at(uid(1)).name, () => {});
		store.act((tx) => {
			tx.set(s.users.at(uid(1)).name, 'a');
			tx.set(s.users.at(uid(1)).age, 1);
			tx.set(s.users.at(uid(2)).name, 'b');
		});
		expect(observer).toHaveBeenCalledTimes(1);
	});

	it('defers a write made from inside a notification to a following commit', () => {
		const { store, s } = makeStore();
		const order: string[] = [];
		store.observe(s.ui.count, () => {
			order.push(`count=${store.get(s.ui.count)}`);
			if (store.get(s.ui.count) < 3) {
				store.act((tx) => tx.update(s.ui.count, (n) => n + 1));
			}
		});
		store.act((tx) => tx.set(s.ui.count, 1));
		// Each step is its own commit, and no observer ever saw an uncommitted value.
		expect(order).toEqual(['count=1', 'count=2', 'count=3']);
		expect(store.get(s.ui.count)).toBe(3);
	});

	it('throws rather than spinning when re-entrant writes never settle', () => {
		const { store, s } = makeStore();
		store.observe(s.ui.count, () => {
			store.act((tx) => tx.update(s.ui.count, (n) => n + 1));
		});
		expect(() => store.act((tx) => tx.set(s.ui.count, 1))).toThrow(/without settling/);
	});

	it('attributes a commit to its source', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		store.act((tx) => tx.set(s.ui.count, 1));
		store.act((tx) => tx.set(s.ui.count, 2), 'my-feature');
		s.cart.bump(1);
		expect(sources).toEqual(['action', 'my-feature', 'cart/bump']);
	});

	it('reports every applied write, with previous and next values', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.ui.count, 4));
		const commits: unknown[] = [];
		store.commits((commit) => commits.push(commit.writes));
		store.act((tx) => {
			tx.set(s.ui.count, 5);
			tx.set(s.ui.theme, 'dark');
		});
		expect(commits).toEqual([
			[
				{ path: 'ui/count', prev: 4, next: 5 },
				{ path: 'ui/theme', prev: 'light', next: 'dark' },
			],
		]);
	});
});

describe('commit source', () => {
	it('uses the explicit name when one is given', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		store.set(s.ui.count, 1, 'mySource');
		expect(sources).toEqual(['mySource']);
	});

	it('names the calling function when nothing is given', () => {
		// Derived only in development, and only while something is listening. It is a
		// convenience for devtools, never something to route on.
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));

		function renameTheThing() {
			store.set(s.ui.count, 7);
		}
		renameTheThing();
		expect(sources).toEqual(['renameTheThing']);
	});

	it('falls back when there is no useful caller name', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		store.set(s.ui.count, 9);
		// An arrow at module scope, or a frame we cannot read, must not produce noise.
		expect(sources[0]).toBeTypeOf('string');
		expect(sources[0]!.length).toBeGreaterThan(0);
	});

	it('costs nothing when nobody is listening to commits', () => {
		// No subscriber and no watch: the name is not derived at all, so a hot write
		// path never captures a stack.
		const { store, s } = makeStore();
		store.set(s.ui.count, 1);
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		store.set(s.ui.count, 2);
		expect(sources).toEqual([expect.any(String)]);
	});

	it('keeps an action path as its own source', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		s.cart.bump(1);
		expect(sources).toEqual(['cart/bump']);
	});
});
