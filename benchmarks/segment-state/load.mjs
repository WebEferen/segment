// Load tests for the paths that dominate createStore and derived propagation.
//
//   pnpm benchmark:load
//
// Each number is the best of several passes. Interference only makes a pass slower.
// The assertions (diamond, rollback, chain value, unrelated derivations not
// re-running) are exact and fail the process when they break.
import { createStore, derived } from './.build/core.js';

function shape(n) {
	const cells = Object.create(null);
	for (let i = 0; i < n; i++) cells['c' + i] = 0;
	return cells;
}

const SHAPE = shape(1000);

function minOf(passes, fn) {
	let best = Infinity;
	for (let i = 0; i < passes; i++) {
		const value = fn();
		if (value < best) best = value;
	}
	return best;
}

function createUs() {
	return minOf(8, () => {
		const n = 400;
		const start = process.hrtime.bigint();
		for (let i = 0; i < n; i++) createStore(SHAPE);
		return Number(process.hrtime.bigint() - start) / 1e6 / n;
	});
}

function chainStore(depth) {
	const store = createStore({ root: 0 });
	let prev = store.state.root;
	let leaf = prev;
	for (let d = 0; d < depth; d++) {
		const src = prev;
		leaf = store.derive((get) => get(src) + 1);
		prev = leaf;
	}
	let notes = 0;
	let seen = 0;
	store.observe(leaf, () => {
		notes++;
		seen = store.get(leaf);
	});
	return {
		store,
		notes: () => notes,
		seen: () => seen,
	};
}

function chainUs(depth) {
	return minOf(6, () => {
		const { store, seen, notes } = chainStore(depth);
		store.set(store.state.root, 1);
		const n = 4000;
		const start = process.hrtime.bigint();
		for (let i = 0; i < n; i++) store.set(store.state.root, i + 2);
		const us = Number(process.hrtime.bigint() - start) / 1e3 / n;
		if (seen() !== n + 1 + depth) throw new Error(`chain ${depth} leaf ${seen()}`);
		if (notes() !== n + 1) throw new Error(`chain ${depth} notes ${notes()}`);
		return us;
	});
}

function unrelatedUs(nDerived) {
	return minOf(6, () => {
		const store = createStore({ root: 0, other: 1 });
		let runs = 0;
		let notes = 0;
		for (let i = 0; i < nDerived; i++) {
			const d = store.derive((get) => {
				runs++;
				return get(store.state.other);
			});
			store.observe(d, () => {
				notes++;
			});
		}
		const seeded = runs;
		const n = 3000;
		const start = process.hrtime.bigint();
		for (let i = 0; i < n; i++) store.set(store.state.root, i + 1);
		const us = Number(process.hrtime.bigint() - start) / 1e3 / n;
		if (runs !== seeded) throw new Error(`unrelated recomputed ${runs - seeded}`);
		if (notes !== 0) throw new Error(`unrelated woke ${notes}`);
		return us;
	});
}

function writeNs() {
	return minOf(6, () => {
		const store = createStore({ n: 0 });
		const ref = store.state.n;
		const n = 200_000;
		for (let i = 0; i < 1000; i++) store.set(ref, i);
		const start = process.hrtime.bigint();
		for (let i = 0; i < n; i++) store.set(ref, i);
		return Number(process.hrtime.bigint() - start) / n;
	});
}

function readNs() {
	return minOf(6, () => {
		const store = createStore({ n: 1 });
		const ref = store.state.n;
		let sink = 0;
		const n = 200_000;
		const start = process.hrtime.bigint();
		for (let i = 0; i < n; i++) sink += store.get(ref);
		if (sink < 0) throw new Error('unreachable');
		return Number(process.hrtime.bigint() - start) / n;
	});
}

function diamond() {
	const store = createStore({
		n: 0,
		b: derived(),
		c: derived(),
		d: derived(),
	}).with((s) => ({
		b: (get) => get(s.n) + 1,
		c: (get) => get(s.n) + 1,
		d: (get) => get(s.b) + get(s.c),
	}));
	const seen = [];
	store.observe(store.state.d, () => {
		seen.push(store.get(store.state.d));
	});
	store.set(store.state.n, 3);
	if (seen.length !== 1 || seen[0] !== 8) {
		throw new Error(`diamond notified ${JSON.stringify(seen)}, want [8]`);
	}
}

function rollback() {
	const store = createStore({ n: 1, m: 2 });
	let calls = 0;
	store.observe(store.state.n, () => {
		calls++;
	});
	try {
		store.act((tx) => {
			tx.set(store.state.n, 9);
			tx.set(store.state.m, 8);
			throw new Error('x');
		});
		throw new Error('act swallowed the throw');
	} catch (error) {
		if (!(error instanceof Error) || error.message !== 'x') throw error;
	}
	if (store.get(store.state.n) !== 1 || store.get(store.state.m) !== 2) {
		throw new Error('act did not roll back');
	}
	if (calls !== 0) throw new Error(`act notified ${calls}`);
}

diamond();
rollback();

const create = createUs();
const rows = [
	['create 1000 cells', `${Math.round(1000 / create)} ops/s`, `${create.toFixed(3)} ms`],
	['write root, chain depth 5', `${chainUs(5).toFixed(3)} µs`, 'one notify, final leaf'],
	['write root, chain depth 20', `${chainUs(20).toFixed(3)} µs`, 'one notify, final leaf'],
	['write, 0 unrelated deriveds', `${unrelatedUs(0).toFixed(3)} µs`, 'no recompute'],
	['write, 20 unrelated deriveds', `${unrelatedUs(20).toFixed(3)} µs`, 'no recompute'],
	['write, 100 unrelated deriveds', `${unrelatedUs(100).toFixed(3)} µs`, 'no recompute'],
	['write fixed cell, no observers', `${writeNs().toFixed(1)} ns`, 'held ref'],
	['read fixed cell, held ref', `${readNs().toFixed(1)} ns`, 'held ref'],
];

const width = Math.max(...rows.map((row) => row[0].length)) + 2;
console.log('\nSegment load, best of 6–8. Diamond and rollback assertions passed.');
for (const [name, value, note] of rows) {
	console.log(name.padEnd(width) + value.padEnd(16) + note);
}
