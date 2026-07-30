// Segment against the store libraries this repo already binds.
//
// The primary numbers are DETERMINISTIC WORK COUNTS, not wall time: how many
// subscriber callbacks and selector evaluations a single targeted write costs, and
// how much per-key bookkeeping survives observer churn. Those are exact, they do
// not move with the machine, and they are what the designs actually differ in.
//
//   node --expose-gc --import tsx benchmarks/segment-state/run.mjs
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { createStore as createSegment, segment } from '../../src/core/index.ts';

const ROOT = resolve(import.meta.dirname, '../..');
const own = createRequire(resolve(ROOT, 'package.json'));

const zustand = await import(own.resolve('zustand/vanilla'));
const jotai = await import(own.resolve('jotai/vanilla'));
const valtio = await import(own.resolve('valtio/vanilla'));
const redux = await import(own.resolve('redux'));

// Sized so the immutable-snapshot libraries finish: zustand and redux copy the
// whole state object on every write, so their cost is O(keys) PER WRITE. The two
// primary measurements (A and B) are exact counts and do not depend on these
// numbers at all; C and D do, and are reported as secondary.
const SUBSCRIBERS = 1_000;
const KEYS = 20_000;
const CHURN_ROUNDS = 200;
const WINDOW = 200;
const WRITES = 2_000;

const key = (i) => `k${i}`;

// ── Adapters ────────────────────────────────────────────────────────────────
//
// Each one is written the way its own documentation tells you to subscribe to one
// field, with no extra machinery the library does not ship.

const adapters = {
	segment: () => {
		// ONE STRING per key, which is what every other adapter holds too. Earlier
		// versions wrapped each value in a record and made Segment's heap number look
		// worse than the comparison warranted.
		const store = createSegment({ rows: segment('') });
		const s = store.state;
		const bulk = Object.create(null);
		for (let i = 0; i < KEYS; i++) bulk[key(i)] = `n${i}`;
		s.rows.replaceAll(bulk);
		return {
			// The keyed subscription the view ships for exactly this pattern; the
			// ref-building form `store.observe(s.rows.at(key), cb)` is equivalent.
			observe: (i, cb) => s.rows.observe(key(i), cb),
			write: (i, value) => store.set(s.rows.at(key(i)), value),
			// The same read shape the other adapters use (`getState()[key]`,
			// `state.rows[key]`): `snapshot()` is the documented handle on the
			// partition, and it is the live value, not a copy.
			read: (i) => s.rows.snapshot()[key(i)],
			retained: () => store.stats().nodes,
			selectorRuns: () => 0,
			preload: () => {}, // replaceAll above already loaded every key
		};
	},

	jotai: () => {
		const store = jotai.createStore();
		// The atomFamily shape: one atom per key, memoized so two subscribers to the
		// same key share it. Nothing removes an atom once created.
		const family = new Map();
		const atomFor = (i) => {
			let a = family.get(i);
			if (a === undefined) family.set(i, (a = jotai.atom(`n${i}`)));
			return a;
		};
		return {
			observe: (i, cb) => store.sub(atomFor(i), cb),
			write: (i, value) => store.set(atomFor(i), value),
			read: (i) => store.get(atomFor(i)),
			retained: () => family.size,
			selectorRuns: () => 0,
			// An atom exists only once asked for, so "the dataset is loaded" means
			// creating them all. That IS the atom-per-key footprint.
			preload: () => {
				for (let i = 0; i < KEYS; i++) atomFor(i);
			},
		};
	},

	zustand: () => {
		let selectorRuns = 0;
		const initial = {};
		for (let i = 0; i < KEYS; i++) initial[key(i)] = `n${i}`;
		const store = zustand.createStore(() => initial);
		return {
			// Zustand notifies every listener on every write; a listener that cares
			// about one field has to run its own selector to find out whether it did.
			observe: (i, cb) => {
				let previous = store.getState()[key(i)];
				return store.subscribe((state) => {
					selectorRuns++;
					const next = state[key(i)];
					if (next === previous) return;
					previous = next;
					cb();
				});
			},
			write: (i, value) => store.setState({ [key(i)]: value }),
			read: (i) => store.getState()[key(i)],
			retained: () => 0,
			selectorRuns: () => selectorRuns,
			preload: () => {}, // the initial object already holds every key
		};
	},

	valtio: () => {
		const state = valtio.proxy({ rows: {} });
		for (let i = 0; i < KEYS; i++) state.rows[key(i)] = { name: `n${i}` };
		// Same one field per key as the others.
		return {
			// Valtio subscribes to an OBJECT, so watching one field means watching the
			// record that contains it. The third argument forces SYNCHRONOUS
			// notification: without it valtio batches to a microtask and this
			// measurement would read 0 callbacks, which would flatter it for being
			// async rather than for doing less work.
			observe: (i, cb) => valtio.subscribe(state.rows[key(i)], cb, true),
			write: (i, value) => {
				state.rows[key(i)].name = value;
			},
			read: (i) => valtio.snapshot(state.rows[key(i)]).name,
			retained: () => 0,
			selectorRuns: () => 0,
			preload: () => {}, // the proxy already holds every key
		};
	},

	redux: () => {
		let selectorRuns = 0;
		const initial = {};
		for (let i = 0; i < KEYS; i++) initial[key(i)] = `n${i}`;
		const store = redux.createStore((state = initial, action) =>
			action.type === 'set' ? { ...state, [action.key]: action.value } : state,
		);
		return {
			observe: (i, cb) => {
				let previous = store.getState()[key(i)];
				return store.subscribe(() => {
					selectorRuns++;
					const next = store.getState()[key(i)];
					if (next === previous) return;
					previous = next;
					cb();
				});
			},
			write: (i, value) => store.dispatch({ type: 'set', key: key(i), value }),
			read: (i) => store.getState()[key(i)],
			retained: () => 0,
			selectorRuns: () => selectorRuns,
			preload: () => {}, // the initial object already holds every key
		};
	},
};

// ── Measurements ────────────────────────────────────────────────────────────

/** A: one targeted write among many independent subscribers. */
function fanout(make) {
	const api = make();
	let woken = 0;
	const offs = [];
	for (let i = 0; i < SUBSCRIBERS; i++) offs.push(api.observe(i, () => woken++));
	const before = api.selectorRuns();
	api.write(0, 'changed');
	const result = { woken, selectorRuns: api.selectorRuns() - before };
	for (const off of offs) off();
	return result;
}

/** B: does per-key bookkeeping survive a scrolling window? */
function churn(make) {
	const api = make();
	const baseline = api.retained();
	let live = [];
	for (let i = 0; i < WINDOW; i++) live.push(api.observe(i, () => {}));
	const withWindow = api.retained();
	for (let round = 1; round <= CHURN_ROUNDS; round++) {
		for (const off of live) off();
		live = [];
		const start = (round * WINDOW) % (KEYS - WINDOW);
		for (let i = 0; i < WINDOW; i++) live.push(api.observe(start + i, () => {}));
	}
	const after = api.retained();
	for (const off of live) off();
	return {
		baseline,
		withWindow,
		after,
		touched: WINDOW * (CHURN_ROUNDS + 1),
		growth: withWindow === baseline ? 1 : (after - baseline) / (withWindow - baseline),
	};
}

/**
 * C: wall time for many targeted writes with the window subscribed.
 *
 * BEST of several passes, not the mean: wall time on a loaded machine is noisy in one
 * direction only (interference makes it slower, never faster), so the minimum is the
 * least noisy estimate of how fast the code can actually go.
 */
function throughput(make, passes = 3) {
	let best = Infinity;
	for (let pass = 0; pass < passes; pass++) {
		const api = make();
		const offs = [];
		for (let i = 0; i < WINDOW; i++) offs.push(api.observe(i, () => {}));
		const start = process.hrtime.bigint();
		for (let w = 0; w < WRITES; w++) api.write(w % WINDOW, `v${w}`);
		best = Math.min(best, Number(process.hrtime.bigint() - start) / 1e6);
		for (const off of offs) off();
	}
	return best;
}

/**
 * D and E: heap held, and what a mount costs, measured in a FRESH PROCESS per
 * library.
 *
 * Measuring all five in one process is invalid: `heapUsed` deltas report ~0 MB once a
 * process has allocated heavily, because V8 reuses space it already committed. An
 * earlier version of this file did exactly that and reported 0.2 MB for a store that
 * demonstrably held 20,000 values.
 */
function isolatedMode(name, mode) {
	const out = execFileSync(
		process.execPath,
		['--expose-gc', resolve(import.meta.dirname, 'isolated.mjs'), name, mode],
		{ encoding: 'utf8' },
	);
	return JSON.parse(out);
}

function isolated(name) {
	// Two processes, not one: a timing pass makes the library's function literals
	// hot, and the next store then pays eager feedback-vector allocation for every
	// closure it defines, which billed the closure-heaviest library ~200 KB of
	// V8 bookkeeping as if it were state. See the `mode` note in isolated.mjs.
	return { ...isolatedMode(name, 'memory'), ...isolatedMode(name, 'timing') };
}

// ── Report ──────────────────────────────────────────────────────────────────

const names = Object.keys(adapters);

// Every forked measurement runs BEFORE any in-process work. Interleaved, each library's
// mount cost was measured on a machine the previous library's 7-second write pass had
// just heated: 2.0 ms against the 1.0 ms the same fork reports on a quiet machine.
const iso = new Map();
for (const name of names) {
	process.stderr.write(`mount+memory ${name} ... `);
	iso.set(name, isolated(name));
	process.stderr.write('done\n');
}

const rows = [];
for (const name of names) {
	process.stderr.write(`measuring ${name} ... `);
	const make = adapters[name];
	const a = fanout(make);
	const b = churn(make);
	const c = throughput(make);
	rows.push({ name, ...a, ...b, ms: c, iso: iso.get(name) });
	process.stderr.write('done\n');
}

const pad = (v, n) => String(v).padEnd(n);
const mb = (b) => (b / 1024 / 1024).toFixed(2);

console.log('\n' + '='.repeat(100));
console.log(`A. One targeted write, ${SUBSCRIBERS} independent subscribers`);
console.log('='.repeat(100));
console.log(pad('library', 12) + pad('callbacks woken', 18) + pad('selector runs', 16) + 'verdict');
console.log('-'.repeat(100));
for (const r of rows) {
	const verdict =
		r.selectorRuns === 0 && r.woken <= 1
			? 'only the address that changed'
			: r.selectorRuns > 0
				? `O(subscribers): every subscriber re-checked`
				: `${r.woken} woken`;
	console.log(pad(r.name, 12) + pad(r.woken, 18) + pad(r.selectorRuns, 16) + verdict);
}

console.log('\n' + '='.repeat(100));
console.log(
	`B. Per-key bookkeeping after churn: ${CHURN_ROUNDS} rounds x ${WINDOW} observers, ` +
		`${rows[0].touched.toLocaleString()} subscriptions over 19,800 distinct keys, ${WINDOW} live at the end`,
);
console.log('='.repeat(100));
console.log(
	pad('library', 12) +
		pad('baseline', 11) +
		pad('one window', 13) +
		pad('after churn', 14) +
		'verdict',
);
console.log('-'.repeat(100));
for (const r of rows) {
	const verdict =
		r.withWindow === r.baseline
			? 'keeps no per-key state (pays in A instead)'
			: r.after === r.withWindow
				? 'released what it stopped observing'
				: `retains everything ever observed (x${r.growth.toFixed(0)})`;
	console.log(
		pad(r.name, 12) + pad(r.baseline, 11) + pad(r.withWindow, 13) + pad(r.after, 14) + verdict,
	);
}

console.log('\n' + '='.repeat(100));
console.log(
	`C/D. ${WRITES.toLocaleString()} targeted writes, and heap with ${KEYS.toLocaleString()} records loaded`,
);
console.log('='.repeat(100));
console.log(
	pad('library', 12) + pad('write ms', 12) + 'heap the state layer adds over the raw data',
);
console.log('-'.repeat(100));
for (const r of rows) {
	console.log(pad(r.name, 12) + pad(r.ms.toFixed(1), 12) + `${mb(r.iso.layerBytes)} MB`);
}

console.log('\n' + '='.repeat(100));
console.log(`E. What the first paint pays: subscribe and read ${WINDOW} rows`);
console.log('='.repeat(100));
console.log(
	pad('library', 12) +
		pad('cold mount', 13) +
		pad('unmount', 11) +
		pad('warm cycle', 13) +
		'per mounted row',
);
console.log('-'.repeat(100));
for (const r of rows) {
	console.log(
		pad(r.name, 12) +
			pad(`${r.iso.coldMountMs.toFixed(3)} ms`, 13) +
			pad(`${r.iso.teardownMs.toFixed(3)} ms`, 11) +
			pad(`${r.iso.cycleMs.toFixed(4)} ms`, 13) +
			`${r.iso.bytesPerRow.toFixed(0)} B`,
	);
}
console.log('='.repeat(100));
