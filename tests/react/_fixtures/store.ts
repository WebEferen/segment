// The same application store the Octane suite uses, built from the core entry
// point alone: the React binding must never need Octane on its path.
import { action, createStore, derived, resource, segment } from 'segment-state/core';

export interface Gate {
	resolve: (value: string) => void;
	reject: (error: unknown) => void;
	promise: Promise<string>;
}

function deferred(): Gate {
	let resolve!: (value: string) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<string>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

export function makeAppStore() {
	const gates = new Map<string, Gate>();
	const loadOrder: string[] = [];

	const store = createStore({
		ui: { theme: 'light', count: 0 },
		users: segment<string>()({
			name: 'anonymous',
			age: 0,
			avatar: resource<string>(),
		}),
		totals: { doubled: derived<number>() },
		bump: action<[by: number]>(),
	}).with((s) => ({
		users: {
			avatar: ({ key }) => {
				loadOrder.push(key);
				const gate = deferred();
				gates.set(key, gate);
				return gate.promise;
			},
		},
		totals: { doubled: (get) => get(s.ui.count) * 2 },
		bump: (tx, by) => tx.update(s.ui.count, (n) => n + by),
	}));

	return {
		store,
		s: store.state,
		gates,
		loadOrder,
		settle: (key: string, value: string) => gates.get(key)!.resolve(value),
		breakLoad: (key: string, error: unknown) => gates.get(key)!.reject(error),
	};
}

export type AppStore = ReturnType<typeof makeAppStore>;
