import { action, createStore, derived, list, segment } from '../src/core/index.js';

export type UserId = string & { readonly __brand: 'UserId' };

/** Evaluation counters, so tests can assert HOW OFTEN a derivation ran. */
export interface Counters {
	double: number;
	plusOne: number;
	sum: number;
	label: number;
	subtotal: number;
}

export function makeStore() {
	const counters: Counters = { double: 0, plusOne: 0, sum: 0, label: 0, subtotal: 0 };

	const store = createStore({
		// Plain values ARE the declaration: each is a cell with this initial value.
		ui: { count: 0, theme: 'light' },
		users: segment<UserId>()({
			name: 'anonymous',
			age: 0,
			label: derived<string>(),
		}),
		cart: {
			items: list({ sku: '', qty: 1 }),
			subtotal: derived<number>(),
			bump: action<[by: number]>(),
			reset: action(),
		},
		// A diamond over `ui.count`: `sum` must see one consistent value of `count`.
		calc: {
			double: derived<number>(),
			plusOne: derived<number>(),
			sum: derived<number>(),
		},
	}).with((s) => ({
		users: {
			label: (get) => {
				counters.label++;
				return `${get(s.ui.theme)}:user`;
			},
		},
		cart: {
			subtotal: (get) => {
				counters.subtotal++;
				return get(s.cart.items.at(0).qty) * 10;
			},
			bump: (tx, by) => {
				tx.update(s.ui.count, (n) => n + by);
			},
			reset: (tx) => {
				tx.set(s.ui.count, 0);
				tx.set(s.ui.theme, 'light');
			},
		},
		calc: {
			double: (get) => {
				counters.double++;
				return get(s.ui.count) * 2;
			},
			plusOne: (get) => {
				counters.plusOne++;
				return get(s.ui.count) + 1;
			},
			sum: (get) => {
				counters.sum++;
				return get(s.calc.double) + get(s.calc.plusOne);
			},
		},
	}));

	return { store, counters, s: store.state };
}

export const uid = (n: number): UserId => `u${n}` as UserId;
