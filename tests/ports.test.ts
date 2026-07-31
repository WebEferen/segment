// Ports are the whole interop argument for this package: a service with no
// reference to any JavaScript object in the store participates by PATH.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Port, PortContext } from '../src/core/index.js';
import { attachPort } from '../src/ports/index.js';
import { makeStore, uid } from './fixture.js';

afterEach(() => {
	vi.restoreAllMocks();
});

function recordingPort(name: string, onAttach?: (ctx: PortContext) => void | (() => void)): Port {
	return { name, attach: (ctx) => onAttach?.(ctx) };
}

describe('ports', () => {
	it('reads and writes by path string', () => {
		const { store, s } = makeStore();
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('probe', (c) => void (ctx = c)),
		);

		store.act((tx) => tx.set(s.users.at(uid(1)).name, 'Ada'));
		expect(ctx.read('users/u1/name')).toBe('Ada');

		ctx.write('users/u1/age', 36);
		expect(store.get(s.users.at(uid(1)).age)).toBe(36);
	});

	it('attributes a port write to the port', () => {
		const { store } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('socket', (c) => void (ctx = c)),
		);
		ctx.write('ui/count', 3);
		expect(sources).toEqual(['socket']);
	});

	it('delivers the commit stream', () => {
		const { store, s } = makeStore();
		const seen: Commit[] = [];
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('log', (c) => void (ctx = c)),
		);
		ctx.commits((commit) => seen.push(commit));
		store.act((tx) => tx.set(s.ui.count, 1));
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(seen.map((c) => c.writes[0]?.path)).toEqual(['ui/count', 'ui/theme']);
		expect(seen[0]?.id).toBe(1);
		expect(seen[1]?.id).toBe(2);
	});

	it('matches an exact watch pattern', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('p', (c) => void (ctx = c)),
		);
		ctx.watch('ui/count', hit);
		store.act((tx) => tx.set(s.ui.count, 1));
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(hit.mock.calls).toEqual([['ui/count']]);
	});

	it('matches a single-segment wildcard but not across segments', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('p', (c) => void (ctx = c)),
		);
		ctx.watch('users/*/name', hit);
		store.act((tx) => {
			tx.set(s.users.at(uid(1)).name, 'a');
			tx.set(s.users.at(uid(2)).name, 'b');
			tx.set(s.users.at(uid(1)).age, 1);
		});
		expect(hit.mock.calls).toEqual([['users/u1/name'], ['users/u2/name']]);
	});

	it('matches a multi-segment wildcard', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('p', (c) => void (ctx = c)),
		);
		ctx.watch('users/**', hit);
		store.act((tx) => {
			tx.set(s.users.at(uid(1)).name, 'a');
			tx.set(s.ui.count, 1);
		});
		expect(hit.mock.calls).toEqual([['users/u1/name']]);
	});

	it('runs the cleanup the port returned when detached', () => {
		const { store } = makeStore();
		const cleanup = vi.fn();
		const detach = attachPort(
			store,
			recordingPort('p', () => cleanup),
		);
		expect(cleanup).not.toHaveBeenCalled();
		detach();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('stops watches when the port detaches', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		const detach = attachPort(
			store,
			recordingPort('p', (c) => void (ctx = c)),
		);
		ctx.watch('ui/**', hit);
		detach();
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(hit).not.toHaveBeenCalled();
	});

	it('stops commit listeners owned by a detached port', () => {
		const { store, s } = makeStore();
		const seen = vi.fn();
		const detach = attachPort(
			store,
			recordingPort('p', (ctx) => {
				ctx.commits(seen);
			}),
		);

		detach();
		store.set(s.ui.count, 1);

		expect(seen).not.toHaveBeenCalled();
	});

	it('rolls back adapter state when attach throws', () => {
		const { store, s } = makeStore();
		const watched = vi.fn();
		const broken = recordingPort('broken', (ctx) => {
			ctx.watch('ui/**', watched);
			throw new Error('attach failed');
		});

		expect(() => attachPort(store, broken)).toThrow('attach failed');
		expect(store.stats().ports).toBe(0);
		store.set(s.ui.count, 1);
		expect(watched).not.toHaveBeenCalled();
	});

	it('runs a late teardown when the port detached during attach', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const { store } = makeStore();
		const cleanup = vi.fn();

		attachPort(store, {
			name: 'self-detaching',
			attach(ctx) {
				ctx.watch('ui/count', () => {
					throw new Error('detach me');
				});
				ctx.write('ui/count', 1);
				return cleanup;
			},
		});

		expect(cleanup).toHaveBeenCalledTimes(1);
		expect(store.stats().ports).toBe(0);
	});

	it('defers a write made by a watch until the triggering commit finishes', () => {
		const { store, s } = makeStore();
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		attachPort(
			store,
			recordingPort('socket', (ctx) => {
				ctx.watch('ui/count', () => ctx.write('ui/theme', 'dark'));
			}),
		);

		store.set(s.ui.count, 1, 'ui/count');

		expect(store.get(s.ui.theme)).toBe('dark');
		expect(sources).toEqual(['ui/count', 'socket']);
	});

	it('refuses to attach the same port twice', () => {
		const { store } = makeStore();
		const port = recordingPort('dup');
		attachPort(store, port);
		expect(() => attachPort(store, port)).toThrow(/already attached/);
	});

	it('isolates a throwing watch callback and detaches that port', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { store, s } = makeStore();
		const other = vi.fn();
		let bad!: PortContext;
		let good!: PortContext;
		attachPort(
			store,
			recordingPort('bad', (c) => void (bad = c)),
		);
		attachPort(
			store,
			recordingPort('good', (c) => void (good = c)),
		);
		bad.watch('ui/**', () => {
			throw new Error('port exploded');
		});
		good.watch('ui/**', other);

		// The commit itself must survive a broken port.
		expect(() => store.act((tx) => tx.set(s.ui.count, 1))).not.toThrow();
		expect(store.get(s.ui.count)).toBe(1);
		expect(other).toHaveBeenCalledTimes(1);
		expect(consoleError).toHaveBeenCalled();
		expect(store.stats().ports).toBe(1);

		// The broken port is gone, so the next commit costs nothing extra.
		store.act((tx) => tx.set(s.ui.count, 2));
		expect(other).toHaveBeenCalledTimes(2);
	});

	it('rejects a port path the schema does not describe', () => {
		const { store } = makeStore();
		let ctx!: PortContext;
		attachPort(
			store,
			recordingPort('p', (c) => void (ctx = c)),
		);
		expect(() => ctx.read('users/u1/nmae')).toThrow(/no such path/);
		expect(() => ctx.write('nope/here', 1)).toThrow(/no such path/);
	});

	it('counts attached ports', () => {
		const { store } = makeStore();
		expect(store.stats().ports).toBe(0);
		const off = attachPort(store, recordingPort('a'));
		attachPort(store, recordingPort('b'));
		expect(store.stats().ports).toBe(2);
		off();
		expect(store.stats().ports).toBe(1);
	});
});
