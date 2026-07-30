import { createStore, resource, segment } from '../src/core/index.js';

/** A promise the test settles by hand, so no assertion depends on real timing. */
export function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let queued microtasks run, which is all these resources ever wait on. */
export async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

export function makeResourceStore() {
	const loads: string[] = [];
	const aborted: string[] = [];
	const saves: Array<{ key: string; value: string }> = [];
	const gates = new Map<string, ReturnType<typeof deferred<string>>>();
	let saveFails = false;
	let liveEmit: ((value: string) => void) | null = null;
	let liveFail: ((error: unknown) => void) | null = null;
	let liveTeardowns = 0;

	const gate = (id: string) => {
		const created = deferred<string>();
		gates.set(id, created);
		return created.promise;
	};

	const store = createStore({
		region: 'eu',
		users: segment<string>()({
			name: 'anonymous',
			avatar: resource<string>(),
		}),
		feed: resource<string>(),
		ticker: resource<string>(),
		plain: resource<string>(),
		readonly_: resource<string>(),
	}).with((s) => ({
		users: {
			avatar: {
				load: ({ key, signal }) => {
					loads.push(`avatar:${key}`);
					signal.addEventListener('abort', () => aborted.push(`avatar:${key}`));
					return gate(`avatar:${key}`);
				},
				save: async ({ key, value }) => {
					saves.push({ key, value });
					if (saveFails) throw new Error('save rejected');
				},
			},
		},
		// Reads `region`, so moving it makes an already-loaded value stale.
		feed: ({ get }) => {
			loads.push(`feed:${get(s.region)}`);
			return gate('feed');
		},
		ticker: {
			load: () => {
				loads.push('ticker');
				return gate('ticker');
			},
			live: ({ emit, fail }) => {
				liveEmit = emit;
				liveFail = fail;
				return () => {
					liveTeardowns++;
				};
			},
		},
		plain: async () => 'plain-value',
		readonly_: () => gate('readonly'),
	}));

	return {
		store,
		s: store.state,
		loads,
		aborted,
		saves,
		settle: (id: string, value: string) => gates.get(id)!.resolve(value),
		breakLoad: (id: string, error: unknown) => gates.get(id)!.reject(error),
		failSaves: () => {
			saveFails = true;
		},
		live: () => ({ emit: liveEmit!, fail: liveFail! }),
		liveTeardowns: () => liveTeardowns,
	};
}
