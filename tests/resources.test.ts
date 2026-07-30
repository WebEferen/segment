import { describe, expect, it, vi } from 'vitest';
import { createStore, resource } from '../src/core/index.js';
import { flush, makeResourceStore } from './resource-fixture.js';

describe('resources: reading', () => {
	it('starts the load on first read and reports pending with a promise', () => {
		const { store, s } = makeResourceStore();
		const snap = store.resource(s.users.at('u1').avatar);
		expect(snap.status).toBe('pending');
		expect(snap.value).toBeUndefined();
		expect(snap.promise).toBeInstanceOf(Promise);
		expect(snap.stale).toBe(false);
	});

	it('does not start a load until something reads it', () => {
		const { loads } = makeResourceStore();
		expect(loads).toEqual([]);
	});

	it('shares one load between concurrent readers', () => {
		const { store, s, loads } = makeResourceStore();
		const a = store.resource(s.users.at('u1').avatar);
		const b = store.resource(s.users.at('u1').avatar);
		expect(loads).toEqual(['avatar:u1']);
		expect(a.promise).toBe(b.promise);
	});

	it('passes the innermost dynamic segment as the key', () => {
		const { store, s, loads } = makeResourceStore();
		store.resource(s.users.at('u7').avatar);
		store.resource(s.users.at('u9').avatar);
		expect(loads).toEqual(['avatar:u7', 'avatar:u9']);
	});

	it('publishes the settled value through the ordinary commit path', async () => {
		const { store, s, settle } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		const observer = vi.fn();
		const commits: string[] = [];
		store.observe(ref, observer);
		store.commits((commit) => commits.push(`${commit.source}:${commit.writes[0]?.path}`));

		settle('avatar:u1', 'https://img/1');
		await flush();

		expect(store.get(ref)).toBe('https://img/1');
		expect(store.resource(ref).status).toBe('ready');
		expect(observer).toHaveBeenCalled();
		expect(commits).toContain('resource:load:users/u1/avatar');
	});

	it('notifies an observed one-argument resource for a live value', () => {
		let emit = (_value: string) => {};
		const store = createStore({ lookup: resource<string, [id: string]>() }).with(() => ({
			lookup: {
				load: () => new Promise<string>(() => {}),
				live: (ctx) => {
					emit = ctx.emit;
				},
			},
		}));
		const ref = store.state.lookup('one');
		const observer = vi.fn();
		const off = store.observe(ref, observer);

		emit('ready');

		expect(store.get(ref)).toBe('ready');
		expect(observer).toHaveBeenCalledTimes(1);
		off();
	});

	it('moves the subtree revision when a resource settles', async () => {
		const { store, s, settle } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.observe(ref, () => {});
		const before = store.revision(store.ref('users'));
		settle('avatar:u1', 'x');
		await flush();
		expect(store.revision(store.ref('users'))).not.toBe(before);
	});

	it('reports an error without crashing on an unhandled rejection', async () => {
		const { store, s, breakLoad } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		const observer = vi.fn();
		store.observe(ref, observer);
		// Nothing awaits the exposed promise; a terminal handler must already exist.
		breakLoad('avatar:u1', new Error('network down'));
		await flush();

		const snap = store.resource(ref);
		expect(snap.status).toBe('error');
		expect((snap.error as Error).message).toBe('network down');
		expect(snap.promise).toBeNull();
		expect(observer).toHaveBeenCalled();
	});

	it('accepts the bare async-function form', async () => {
		const { store, s } = makeResourceStore();
		const snap = store.resource(s.plain);
		expect(snap.status).toBe('pending');
		await snap.promise;
		expect(store.get(s.plain)).toBe('plain-value');
	});

	it('refuses to read a non-resource path as a resource', () => {
		const { store, s } = makeResourceStore();
		expect(() => store.resource(s.region)).toThrow(/is not a resource/);
	});
});

describe('resources: refresh and forget', () => {
	it('supersedes an in-flight load and aborts it', async () => {
		const { store, s, loads, aborted, settle } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		store.refresh(ref);
		expect(loads).toEqual(['avatar:u1', 'avatar:u1']);
		expect(aborted).toEqual(['avatar:u1']);

		// The superseded response must not publish over the newer load.
		settle('avatar:u1', 'second');
		await flush();
		expect(store.get(ref)).toBe('second');
	});

	it('does not let a stale response overwrite a newer value', async () => {
		const { store, s, settle } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		const first = 'avatar:u1';
		store.refresh(ref); // replaces the gate, so `first` now refers to the newer one
		settle(first, 'newest');
		await flush();
		expect(store.get(ref)).toBe('newest');
		expect(store.resource(ref).status).toBe('ready');
	});

	it('forget aborts, clears the value, and drops the state', async () => {
		const { store, s, settle, aborted } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.observe(ref, () => {});
		settle('avatar:u1', 'img');
		await flush();
		expect(store.get(ref)).toBe('img');

		store.forget(ref);
		expect(store.get(ref)).toBeUndefined();
		expect(store.stats().resources).toBe(0);

		// A second forget on an in-flight load aborts it.
		store.resource(ref);
		store.forget(ref);
		expect(aborted).toContain('avatar:u1');
	});

	it('reloads after forget', async () => {
		const { store, s, settle, loads } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		settle('avatar:u1', 'first');
		await flush();
		store.forget(ref);
		store.resource(ref);
		expect(loads).toEqual(['avatar:u1', 'avatar:u1']);
	});
});

describe('resources: write-back', () => {
	it('applies the value immediately and confirms', async () => {
		const { store, s, settle, saves } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		settle('avatar:u1', 'old');
		await flush();

		const pending = store.save(ref, 'new');
		// Optimistic: visible before the round trip finishes.
		expect(store.get(ref)).toBe('new');
		await pending;
		expect(saves).toEqual([{ key: 'u1', value: 'new' }]);
		expect(store.get(ref)).toBe('new');
	});

	it('restores the previous value when save rejects', async () => {
		const { store, s, settle, failSaves } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		settle('avatar:u1', 'old');
		await flush();

		failSaves();
		await expect(store.save(ref, 'new')).rejects.toThrow('save rejected');
		// An optimistic update is a transaction that never confirmed.
		expect(store.get(ref)).toBe('old');
		expect(store.resource(ref).status).toBe('error');
	});

	it('reports the rollback in the commit stream', async () => {
		const { store, s, settle, failSaves } = makeResourceStore();
		const ref = s.users.at('u1').avatar;
		store.resource(ref);
		settle('avatar:u1', 'old');
		await flush();

		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));
		failSaves();
		await store.save(ref, 'new').catch(() => {});
		expect(sources).toEqual(['resource:save', 'resource:save:rollback']);
	});

	it('refuses to save a resource that declares no save', async () => {
		const { store, s } = makeResourceStore();
		await expect(store.save(s.readonly_, 'x')).rejects.toThrow(/declares no save/);
	});

	it('refuses an ordinary write to a resource path', () => {
		const { store, s } = makeResourceStore();
		expect(() => store.act((tx) => tx.set(s.users.at('u1').avatar, 'x'))).toThrow(
			/use save\(\) to write it back/,
		);
	});
});

describe('resources: outside push', () => {
	it('publishes an emitted value as a commit', () => {
		const { store, s, live } = makeResourceStore();
		const observer = vi.fn();
		store.observe(s.ticker, observer);
		const sources: string[] = [];
		store.commits((commit) => sources.push(commit.source));

		live().emit('tick-1');
		expect(store.get(s.ticker)).toBe('tick-1');
		expect(store.resource(s.ticker).status).toBe('ready');
		expect(observer).toHaveBeenCalled();
		expect(sources).toEqual(['resource:live']);
	});

	it('surfaces a pushed failure as an error status', () => {
		const { store, s, live } = makeResourceStore();
		store.observe(s.ticker, () => {});
		live().fail(new Error('stream closed'));
		expect(store.resource(s.ticker).status).toBe('error');
	});

	it('tears the channel down on forget', () => {
		const { store, s, liveTeardowns } = makeResourceStore();
		store.resource(s.ticker);
		expect(liveTeardowns()).toBe(0);
		store.forget(s.ticker);
		expect(liveTeardowns()).toBe(1);
	});
});

describe('resources: staleness and retention', () => {
	it('marks a loaded value stale when a dependency moves', async () => {
		const { store, s, settle } = makeResourceStore();
		store.observe(s.feed, () => {});
		settle('feed', 'eu-feed');
		await flush();
		expect(store.resource(s.feed).stale).toBe(false);

		store.act((tx) => tx.set(s.region, 'us'));
		expect(store.resource(s.feed).stale).toBe(true);
		// The value is still there; staleness is advice, not a reset.
		expect(store.get(s.feed)).toBe('eu-feed');
	});

	it('wakes an observer when a value becomes stale', async () => {
		const { store, s, settle } = makeResourceStore();
		const observer = vi.fn();
		store.observe(s.feed, observer);
		settle('feed', 'eu-feed');
		await flush();
		observer.mockClear();
		store.act((tx) => tx.set(s.region, 'us'));
		expect(observer).toHaveBeenCalled();
	});

	it('clears staleness on refresh', async () => {
		const { store, s, settle } = makeResourceStore();
		store.observe(s.feed, () => {});
		settle('feed', 'eu-feed');
		await flush();
		store.act((tx) => tx.set(s.region, 'us'));
		expect(store.resource(s.feed).stale).toBe(true);

		store.refresh(s.feed);
		settle('feed', 'us-feed');
		await flush();
		expect(store.resource(s.feed).stale).toBe(false);
		expect(store.get(s.feed)).toBe('us-feed');
	});

	it('adopts a seeded value without fetching, which is how a server payload lands', () => {
		const { store, s, loads } = makeResourceStore();
		const seeded = Object.create(null) as Record<string, { name: string; avatar: string }>;
		seeded.u1 = { name: 'Ada', avatar: 'https://img/seeded' };
		s.users.replaceAll(seeded);

		const snap = store.resource(s.users.at('u1').avatar);
		expect(snap.status).toBe('ready');
		expect(snap.value).toBe('https://img/seeded');
		expect(snap.promise).toBeNull();
		expect(loads).toEqual([]);
	});

	it('keeps transient state bounded by activity, not by how much was fetched', async () => {
		const { store, s, settle } = makeResourceStore();
		// 50 resources fetched, none observed.
		for (let i = 0; i < 50; i++) store.resource(s.users.at(`u${i}`).avatar);
		expect(store.stats().resources).toBe(50);
		for (let i = 0; i < 50; i++) settle(`avatar:u${i}`, `img-${i}`);
		await flush();
		// Settled, unobserved, nothing pushing: the entries go, the values stay.
		expect(store.stats().resources).toBe(0);
		expect(store.get(s.users.at('u49').avatar)).toBe('img-49');
	});

	it('retains state while a resource is observed', async () => {
		const { store, s, settle } = makeResourceStore();
		const off = store.observe(s.users.at('u1').avatar, () => {});
		settle('avatar:u1', 'img');
		await flush();
		expect(store.stats().resources).toBe(1);
		off();
		expect(store.stats().resources).toBe(0);
	});

	it('retains state while a load is in flight or failed', async () => {
		const { store, s, breakLoad } = makeResourceStore();
		store.resource(s.users.at('u1').avatar);
		expect(store.stats().resources).toBe(1);
		breakLoad('avatar:u1', new Error('boom'));
		await flush();
		// An error must survive so a reader can see it.
		expect(store.stats().resources).toBe(1);
	});

	it('release() of a resourceOf tears down its live channel and transient state', async () => {
		const { store } = makeResourceStore();
		const teardown = vi.fn();
		const feed = store.resourceOf({
			load: async () => 'first',
			live: () => teardown,
		});
		store.resource(feed);
		await flush();
		expect(store.stats().resources).toBe(1);
		// The documented pattern is a per-component resourceOf released on
		// unmount, which routinely happens while the channel is still open.
		store.release(feed);
		expect(teardown).toHaveBeenCalledTimes(1);
		expect(store.stats().resources).toBe(0);
	});
});
