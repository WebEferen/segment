// Ports are the whole interop argument for this package: a service with no
// reference to any JavaScript object in the store participates by PATH.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Commit, Port, PortContext } from '../src/core/index.js';
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
		store.attach(recordingPort('probe', (c) => void (ctx = c)));

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
		store.attach(recordingPort('socket', (c) => void (ctx = c)));
		ctx.write('ui/count', 3);
		expect(sources).toEqual(['socket']);
	});

	it('delivers the commit stream', () => {
		const { store, s } = makeStore();
		const seen: Commit[] = [];
		let ctx!: PortContext;
		store.attach(recordingPort('log', (c) => void (ctx = c)));
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
		store.attach(recordingPort('p', (c) => void (ctx = c)));
		ctx.watch('ui/count', hit);
		store.act((tx) => tx.set(s.ui.count, 1));
		store.act((tx) => tx.set(s.ui.theme, 'dark'));
		expect(hit.mock.calls).toEqual([['ui/count']]);
	});

	it('matches a single-segment wildcard but not across segments', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		store.attach(recordingPort('p', (c) => void (ctx = c)));
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
		store.attach(recordingPort('p', (c) => void (ctx = c)));
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
		const detach = store.attach(recordingPort('p', () => cleanup));
		expect(cleanup).not.toHaveBeenCalled();
		detach();
		expect(cleanup).toHaveBeenCalledTimes(1);
	});

	it('stops watches when the port detaches', () => {
		const { store, s } = makeStore();
		const hit = vi.fn();
		let ctx!: PortContext;
		const detach = store.attach(recordingPort('p', (c) => void (ctx = c)));
		ctx.watch('ui/**', hit);
		detach();
		store.act((tx) => tx.set(s.ui.count, 1));
		expect(hit).not.toHaveBeenCalled();
	});

	it('refuses to attach the same port twice', () => {
		const { store } = makeStore();
		const port = recordingPort('dup');
		store.attach(port);
		expect(() => store.attach(port)).toThrow(/already attached/);
	});

	it('isolates a throwing watch callback and detaches that port', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const { store, s } = makeStore();
		const other = vi.fn();
		let bad!: PortContext;
		let good!: PortContext;
		store.attach(recordingPort('bad', (c) => void (bad = c)));
		store.attach(recordingPort('good', (c) => void (good = c)));
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
		store.attach(recordingPort('p', (c) => void (ctx = c)));
		expect(() => ctx.read('users/u1/nmae')).toThrow(/no such path/);
		expect(() => ctx.write('nope/here', 1)).toThrow(/no such path/);
	});

	it('counts attached ports', () => {
		const { store } = makeStore();
		expect(store.stats().ports).toBe(0);
		const off = store.attach(recordingPort('a'));
		store.attach(recordingPort('b'));
		expect(store.stats().ports).toBe(2);
		off();
		expect(store.stats().ports).toBe(1);
	});
});
