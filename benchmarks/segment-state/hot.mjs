// The hot paths of segment-state, isolated so an optimization has a number.
//
//   node benchmarks/segment-state/hot.mjs            all cases
//   node benchmarks/segment-state/hot.mjs 4          one case, as JSON
//
// EVERY CASE RUNS IN ITS OWN PROCESS. Measuring them in one process made the result
// depend on their order in this file: each case leaves a 20,000-key store behind, so
// a case near the bottom was timed against a heap full of an earlier case's garbage
// and read 2x slower than the same code measured first. A fresh process per case is
// what makes two runs of this file comparable.
//
// Built to plain JS with `keepNames: false` before measuring: running the core
// through tsx wraps every function in esbuild's `__name` helper, which was 42% of
// self time in a profile. That is the harness, not the library.
import { execFileSync } from 'node:child_process';
// SEGMENT_CORE points this at a variant build, so an A/B runs through the identical
// harness instead of a second one written to match.
const { createStore, derived, segment } = await import(
	process.env.SEGMENT_CORE ?? './.build/core.js'
);

const KEYS = 20_000;
const OPS = 200_000;
const PASSES = 5;
const ALLOC_OPS = 20_000;
const WINDOW = 200;
/**
 * Keys are pre-generated. Building one per operation with a template literal was
 * measuring string concatenation inside every case AND inside the calibration, which
 * made the calibration do strictly more work than the cases compared against it. A
 * real caller already holds its ids.
 */
const KEY = Array.from({ length: KEYS }, (_, i) => `k${i}`);

function build() {
	const store = createStore({
		flat: 0,
		nested: { a: { b: 0 } },
		rows: segment(''),
		doubled: derived(),
	}).with((s) => ({ doubled: (get) => get(s.flat) * 2 }));
	const s = store.state;
	const bulk = Object.create(null);
	for (let i = 0; i < KEYS; i++) bulk[KEY[i]] = `v${i}`;
	s.rows.replaceAll(bulk);
	return { store, s };
}

function records() {
	const store = createStore({ rows: segment({ name: '', age: 0 }) });
	const s = store.state;
	const bulk = Object.create(null);
	for (let i = 0; i < KEYS; i++) bulk[KEY[i]] = { name: `v${i}`, age: i };
	s.rows.replaceAll(bulk);
	return { store, s };
}

/** Observe a window of keys, the way a mounted list of that size does. */
function watching(ctx) {
	for (let i = 0; i < WINDOW; i++) ctx.store.observe(ctx.s.rows.at(KEY[i]), () => {});
	return ctx;
}

const CASES = [
	// ── Reads ────────────────────────────────────────────────────────────────
	{
		label: 'read  cell, held ref',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.flat };
		},
		body: ({ store, ref }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(ref);
			return sink;
		},
	},
	{
		label: 'read  segment leaf, held ref',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.rows.at('k1') };
		},
		body: ({ store, ref }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(ref).length;
			return sink;
		},
	},
	{
		label: 'read  segment leaf, fresh .at() each time',
		setup: build,
		body: ({ store, s }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(s.rows.at(KEY[i % KEYS])).length;
			return sink;
		},
	},
	// The mounted-list path: the addresses read are the ones the store observes,
	// which is what a rendered `@for` does on every pass. Kept separate from the
	// unobserved case above because only this one can intern its descriptor.
	{
		label: 'read  segment leaf, .at() on OBSERVED key',
		setup: () => watching(build()),
		body: ({ store, s }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(s.rows.at(KEY[i % WINDOW])).length;
			return sink;
		},
	},
	{
		label: 'read  record field, .at() on OBSERVED key',
		setup: () => watching(records()),
		body: ({ store, s }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(s.rows.at(KEY[i % WINDOW]).name).length;
			return sink;
		},
	},
	{
		label: 'read  record field, fresh .at() each time',
		setup: records,
		body: ({ store, s }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(s.rows.at(KEY[i % KEYS]).name).length;
			return sink;
		},
	},
	// What the adapter actually does for a row: one `useValue` per field, so `.at(id)`
	// is called once per field rather than once per row.
	{
		label: 'read  3 fields of one record, .at() per field',
		setup: records,
		body: ({ store, s }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops / 3; i++) {
				const key = KEY[i % KEYS];
				sink += store.get(s.rows.at(key).name).length;
				sink += store.get(s.rows.at(key).age);
				sink += store.get(s.rows.at(key).name).length;
			}
			return sink;
		},
	},
	{
		label: 'read  derivation, clean',
		setup: () => {
			const { store, s } = build();
			store.get(s.doubled);
			return { store, ref: s.doubled };
		},
		body: ({ store, ref }, ops) => {
			let sink = 0;
			for (let i = 0; i < ops; i++) sink += store.get(ref);
			return sink;
		},
	},

	// ── Writes ───────────────────────────────────────────────────────────────
	{
		label: 'write cell, held ref, no observers',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.flat };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.set(ref, i);
			return 0;
		},
	},
	{
		label: 'write cell, held ref, ONE observer',
		setup: () => {
			const { store, s } = build();
			store.observe(s.flat, () => {});
			return { store, ref: s.flat };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.set(ref, i);
			return 0;
		},
	},
	{
		label: 'write cell, held ref, commit subscriber',
		setup: () => {
			const { store, s } = build();
			store.commits(() => {});
			return { store, ref: s.flat };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.set(ref, i);
			return 0;
		},
	},
	{
		label: 'write segment leaf, held ref',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.rows.at('k1') };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.set(ref, `x${i}`);
			return 0;
		},
	},
	{
		label: 'write segment leaf, fresh .at() each time',
		setup: build,
		body: ({ store, s }, ops) => {
			for (let i = 0; i < ops; i++) store.set(s.rows.at(KEY[i % KEYS]), `x${i}`);
			return 0;
		},
	},
	{
		label: 'write segment leaf, .at() on OBSERVED key',
		setup: () => watching(build()),
		body: ({ store, s }, ops) => {
			for (let i = 0; i < ops; i++) store.set(s.rows.at(KEY[i % WINDOW]), `x${i}`);
			return 0;
		},
	},
	{
		label: 'write nested cell, held ref',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.nested.a.b };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.set(ref, i);
			return 0;
		},
	},
	{
		label: 'write cell via act(), one write',
		setup: () => {
			const { store, s } = build();
			return { store, ref: s.flat };
		},
		body: ({ store, ref }, ops) => {
			for (let i = 0; i < ops; i++) store.act((tx) => tx.set(ref, i));
			return 0;
		},
	},
	{
		label: 'write 3 in one act()',
		setup: build,
		body: ({ store, s }, ops) => {
			for (let i = 0; i < ops / 3; i++) {
				store.act((tx) => {
					tx.set(s.flat, i);
					tx.set(s.nested.a.b, i);
					tx.set(s.rows.at('k1'), `x${i}`);
				});
			}
			return 0;
		},
	},
];

/**
 * Calibration: the same loop shape over a plain Map of the same size, which is the
 * cheapest keyed read the language has. Absolute nanoseconds move by 2-3x with
 * machine load (measured: an unrelated `tsc` in another checkout doubled every row
 * at once), so each case also reports its cost as a multiple of this. The multiple
 * is what survives a busy machine and what can be compared against a past run.
 */
function calibrate() {
	const map = new Map();
	for (let i = 0; i < KEYS; i++) map.set(KEY[i], `v${i}`);
	let best = Infinity;
	for (let pass = 0; pass < PASSES; pass++) {
		const start = process.hrtime.bigint();
		let sink = 0;
		for (let i = 0; i < OPS; i++) sink += map.get(KEY[i % KEYS]).length;
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		if (sink === -1) throw new Error('unreachable');
		if (ms < best) best = ms;
	}
	return (best * 1e6) / OPS;
}

/**
 * Time is best-of-N: interference only ever makes a pass slower, so the minimum is
 * the least noisy estimate. Allocation is a SEPARATE short pass, because a heapUsed
 * delta is exact only while no collection happens inside the window: across 200,000
 * operations a scavenge lands mid-loop and the delta reports what the collector did
 * rather than what the code allocated. ALLOC_OPS keeps the garbage under the young
 * generation, so nothing is collected and the delta is the real figure.
 */
function time({ label, setup, body }) {
	const baselineNs = calibrate();
	let best = Infinity;
	for (let pass = 0; pass < PASSES; pass++) {
		const ctx = setup();
		for (let i = 0; i < 4; i++) global.gc();
		const start = process.hrtime.bigint();
		const sink = body(ctx, OPS);
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		if (sink === -1) throw new Error('unreachable');
		if (ms < best) best = ms;
	}
	return { label, nsPerOp: (best * 1e6) / OPS, baselineNs };
}

/**
 * Allocation gets a process of its own, and it is the FIRST thing that runs in it.
 *
 * Measured after the timing passes, the same `store.set` reported 4 B/op or 56 B/op
 * depending only on what had run before it: five timing passes leave five dead
 * 20,000-key stores on the heap, and a heapUsed delta then reports incremental
 * marking and promotion rather than the operation. Below roughly 100 B/op this metric
 * is only meaningful on a heap nothing else has churned.
 */
function alloc({ setup, body }) {
	const ctx = setup();
	body(ctx, 2000); // warm, so first-call lazy work is not charged to the measurement
	for (let i = 0; i < 6; i++) global.gc();
	const before = process.memoryUsage().heapUsed;
	body(ctx, ALLOC_OPS);
	return Math.max(0, process.memoryUsage().heapUsed - before) / ALLOC_OPS;
}

const only = process.argv[2];
if (only === 'count') {
	// So a driver can enumerate the cases without running any of them.
	process.stdout.write(String(CASES.length));
} else if (only !== undefined) {
	const which = CASES[Number(only)];
	const result = process.argv[3] === 'alloc' ? { bytesPerOp: alloc(which) } : time(which);
	process.stdout.write(JSON.stringify(result));
} else {
	const self = new URL(import.meta.url).pathname;
	const fork = (i, mode) =>
		JSON.parse(
			execFileSync(process.execPath, ['--expose-gc', self, String(i), ...(mode ? [mode] : [])], {
				encoding: 'utf8',
			}),
		);
	const rows = CASES.map((_, i) => ({ ...fork(i), ...fork(i, 'alloc') }));
	const width = Math.max(...rows.map((r) => r.label.length)) + 2;
	const rule = '='.repeat(width + 44);
	const baseline = rows.reduce((sum, r) => sum + r.baselineNs, 0) / rows.length;
	console.log('\n' + rule);
	console.log(`Segment hot paths, best of ${PASSES}, ${OPS.toLocaleString()} ops each`);
	console.log(`one process per case; baseline is one Map.get over ${KEYS.toLocaleString()} keys,`);
	console.log(`which came out at ${baseline.toFixed(1)} ns on average across the cases`);
	console.log(rule);
	console.log('case'.padEnd(width) + 'ns/op'.padEnd(12) + 'x baseline'.padEnd(12) + 'bytes/op');
	console.log('-'.repeat(width + 44));
	for (const r of rows) {
		console.log(
			r.label.padEnd(width) +
				r.nsPerOp.toFixed(1).padEnd(12) +
				`${(r.nsPerOp / r.baselineNs).toFixed(1)}x`.padEnd(12) +
				(r.bytesPerOp < 1 ? '~0' : r.bytesPerOp.toFixed(0)),
		);
	}
	console.log(rule);
}
