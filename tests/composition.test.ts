// Anonymous derivations and async tasks: the two things that exist because the
// alternatives were traps.
import { describe, expect, it, vi } from 'vitest';
import { dehydrate } from '../src/ssr/index.js';
import { action, createStore, task } from '../src/core/index.js';
import { makeStore, uid } from './fixture.js';

describe('store.derive', () => {
	it('computes from the addresses it read', () => {
		const { store, s } = makeStore();
		const doubled = store.derive((get) => get(s.ui.count) * 2);
		store.set(s.ui.count, 21);
		expect(store.get(doubled)).toBe(42);
	});

	it('caches, so reading it twice runs it once', () => {
		const { store, s } = makeStore();
		const runs = vi.fn((n: number) => n * 2);
		const doubled = store.derive((get) => runs(get(s.ui.count)));
		store.get(doubled);
		store.get(doubled);
		store.get(doubled);
		expect(runs).toHaveBeenCalledTimes(1);
	});

	it('wakes an observer only when its own inputs move', () => {
		const { store, s } = makeStore();
		const doubled = store.derive((get) => get(s.ui.count) * 2);
		const observer = vi.fn();
		store.observe(doubled, observer);

		store.set(s.ui.theme, 'dark');
		expect(observer).not.toHaveBeenCalled();
		store.set(s.ui.count, 1);
		expect(observer).toHaveBeenCalledTimes(1);
	});

	it('release drops it, which is what stops a long list leaking one per row', () => {
		const { store, s } = makeStore();
		const baseline = store.stats().nodes;
		const refs = [];
		for (let i = 0; i < 100; i++) refs.push(store.derive((get) => get(s.ui.count) + i));
		expect(store.stats().nodes).toBe(baseline + 100);
		for (const ref of refs) store.release(ref);
		expect(store.stats().nodes).toBe(baseline);
	});

	it('refuses to release anything the schema declared', () => {
		const { store, s } = makeStore();
		expect(() => store.release(s.ui.count)).toThrow(/lives as long as the store/);
	});

	it('keeps its reserved prefix out of an author address space', () => {
		expect(() => createStore({ '$derive:0': 1 })).toThrow(/reserved/);
	});
});

describe('task', () => {
	it('takes several commits over time, each atomic', async () => {
		const store = createStore({
			status: 'idle',
			count: 0,
			run: task<[by: number]>(),
		}).with((s) => ({
			run: async ({ act, get }) => {
				act((tx) => tx.set(s.status, 'working'));
				await Promise.resolve();
				act((tx) => tx.set(s.count, get(s.count) + 1));
				act((tx) => tx.set(s.status, 'done'));
			},
		}));

		// Only the implementation's own writes, so the task's run-state commits do not
		// obscure what this test is about.
		const seen: string[] = [];
		store.commits((commit) => {
			const path = commit.writes[0]?.path;
			if (path !== undefined && !path.startsWith('run/')) seen.push(path);
		});

		const pending = store.state.run(1);
		// The first commit landed before the await; the rest had not happened yet.
		expect(store.get(store.state.status)).toBe('working');
		await pending;
		expect(store.get(store.state.status)).toBe('done');
		expect(store.get(store.state.count)).toBe(1);
		// Three separate commits, not one: an async flow is not one transaction, and
		// the commit stream says so honestly.
		expect(seen).toEqual(['status', 'count', 'status']);
	});

	it('returns a promise callers can await', async () => {
		const store = createStore({ done: false, go: task() }).with((s) => ({
			go: async ({ act }) => {
				await Promise.resolve();
				act((tx) => tx.set(s.done, true));
			},
		}));
		const result = store.state.go();
		expect(result).toBeInstanceOf(Promise);
		await result;
		expect(store.get(store.state.done)).toBe(true);
	});

	it('carries an abort signal for the fetch it wraps', async () => {
		let seen: AbortSignal | undefined;
		const store = createStore({ go: task() }).with(() => ({
			go: ({ signal }) => {
				seen = signal;
			},
		}));
		await store.state.go();
		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen!.aborted).toBe(false);
	});

	it('reports a task with no implementation', () => {
		const store = createStore({ go: task() });
		expect(() => store.state.go()).toThrow(/supply it in \.with\(\)/);
		expect(() => createStore({ go: task() }).with(() => ({}) as never)).toThrow(/\bgo\b/);
	});

	it('cannot be written or observed, like any action', () => {
		const store = createStore({ go: task(), tick: action() }).with(() => ({
			go: () => {},
			tick: () => {},
		}));
		const ref = store.ref('go');
		expect(() => store.act((tx) => tx.set(ref, 1))).toThrow(/is an action/);
		expect(() => store.observe(ref, () => {})).toThrow(/cannot be observed/);
	});

	it('is omitted from a dehydrated payload', () => {
		const store = createStore({ n: 1, go: task() }).with(() => ({ go: () => {} }));
		expect(Object.keys(dehydrate(store).data)).toEqual(['n']);
	});
});

describe('patch', () => {
	it('writes the keys you give and leaves the rest alone', () => {
		const { store, s } = makeStore();
		store.act((tx) => tx.set(s.users.at(uid(1)).age, 30));
		store.patch(s.users.at(uid(1)), { name: 'Ada' });
		expect(store.get(s.users.at(uid(1)).name)).toBe('Ada');
		expect(store.get(s.users.at(uid(1)).age)).toBe(30);
	});

	it('overwriting a whole record is the same call with every key', () => {
		const { store, s } = makeStore();
		store.patch(s.users.at(uid(1)), { name: 'Ada', age: 36 });
		expect(store.get(s.users.at(uid(1)).name)).toBe('Ada');
		expect(store.get(s.users.at(uid(1)).age)).toBe(36);
	});

	it('lands as ONE commit, waking each affected observer once', () => {
		const { store, s } = makeStore();
		const name = vi.fn();
		const age = vi.fn();
		store.observe(s.users.at(uid(1)).name, name);
		store.observe(s.users.at(uid(1)).age, age);
		const commits: number = ((): number => {
			let n = 0;
			store.commits(() => n++);
			store.patch(s.users.at(uid(1)), { name: 'Ada', age: 36 });
			return n;
		})();
		expect(commits).toBe(1);
		expect(name).toHaveBeenCalledTimes(1);
		expect(age).toHaveBeenCalledTimes(1);
	});

	it('patches a group of plain cells', () => {
		const { store, s } = makeStore();
		store.patch(s.ui, { count: 5, theme: 'dark' });
		expect(store.get(s.ui.count)).toBe(5);
		expect(store.get(s.ui.theme)).toBe('dark');
	});

	it('recurses into nested groups', () => {
		const store = createStore({ a: { b: { c: 0, d: 0 } } });
		store.patch(store.state.a, { b: { c: 1 } });
		expect(store.get(store.state.a.b.c)).toBe(1);
		expect(store.get(store.state.a.b.d)).toBe(0);
	});

	it('refuses to write anything the store computes', () => {
		const { store, s } = makeStore();
		expect(() => store.patch(s.calc, { sum: 1 })).toThrow(/computed by the store/);
	});

	it('rejects a key the schema does not describe', () => {
		const { store, s } = makeStore();
		expect(() => store.patch(s.ui, { nope: 1 } as never)).toThrow(/no such path/);
	});

	it('refuses an ordinary write to a group, which used to be lost silently', () => {
		const { store } = makeStore();
		const group = store.ref('ui');
		expect(() => store.act((tx) => tx.set(group, { count: 1 }))).toThrow(/use patch\(\)/);
	});
});

describe('task: returning a value', () => {
	it('resolves to whatever the implementation returned', async () => {
		const store = createStore({
			count: 0,
			place: task<[sku: string], { id: string }>(),
		}).with((s) => ({
			place: async ({ act }, sku) => {
				act((tx) => tx.update(s.count, (n) => n + 1));
				await Promise.resolve();
				return { id: `order-${sku}` };
			},
		}));

		const result = await store.state.place('abc');
		expect(result).toEqual({ id: 'order-abc' });
		expect(store.get(store.state.count)).toBe(1);
	});

	it('still resolves to undefined when nothing is returned', async () => {
		const store = createStore({ go: task() }).with(() => ({ go: () => {} }));
		await expect(store.state.go()).resolves.toBeUndefined();
	});
});

describe('task: its own run state', () => {
	function makeTaskStore() {
		let settle!: (value: string) => void;
		let fail_!: (error: unknown) => void;
		const store = createStore({
			run: task<[n: number], string>(),
		}).with(() => ({
			run: () =>
				new Promise<string>((resolve, reject) => {
					settle = resolve;
					fail_ = reject;
				}),
		}));
		return {
			store,
			s: store.state,
			settle: (v: string) => settle(v),
			fail: (e: unknown) => fail_(e),
		};
	}

	it('reports idle, running, then done, and holds the result', async () => {
		const { store, s, settle } = makeTaskStore();
		expect(store.get(s.run.status)).toBe('idle');
		expect(store.get(s.run.result)).toBeUndefined();

		const pending = s.run(1);
		expect(store.get(s.run.status)).toBe('running');

		settle('order-1');
		await pending;
		expect(store.get(s.run.status)).toBe('done');
		expect(store.get(s.run.result)).toBe('order-1');
		expect(store.get(s.run.error)).toBeUndefined();
	});

	it('reports failed and holds the error', async () => {
		const { store, s, fail } = makeTaskStore();
		const pending = s.run(1);
		fail(new Error('declined'));
		await expect(pending).rejects.toThrow('declined');
		expect(store.get(s.run.status)).toBe('failed');
		expect((store.get(s.run.error) as Error).message).toBe('declined');
	});

	it('wakes an observer of the status, so a component can render progress', async () => {
		const { store, s, settle } = makeTaskStore();
		const seen: unknown[] = [];
		store.observe(s.run.status, () => seen.push(store.get(s.run.status)));
		const pending = s.run(1);
		settle('ok');
		await pending;
		expect(seen).toEqual(['running', 'done']);
	});

	it('lets only the latest of two overlapping runs publish', async () => {
		const { store, s } = makeTaskStore();
		let first!: (v: string) => void;
		let second!: (v: string) => void;
		const local = createStore({ run: task<[], string>() }).with(() => ({
			run: () =>
				new Promise<string>((resolve) =>
					first === undefined ? (first = resolve) : (second = resolve),
				),
		}));
		const a = local.state.run();
		const b = local.state.run();
		// The older run settles LAST and must not describe "the" status.
		second('newer');
		await b;
		first('older');
		await a;
		expect(local.get(local.state.run.result)).toBe('newer');
		expect(store.get(s.run.status)).toBe('idle');
	});

	it('keeps run state out of a dehydrated payload', () => {
		const { store, s } = makeTaskStore();
		void s.run(1);
		expect(Object.keys(dehydrate(store).data)).toEqual([]);
	});
});
