// One library's mount cost and memory overhead, in a FRESH PROCESS.
//
//   node --expose-gc benchmarks/segment-state/isolated.mjs <library>
//
// Every number here needs its own process, and each one needed a correction:
//
// - `heapUsed` deltas are worthless once a process has allocated heavily, because V8
//   grows the heap once and later allocations fit in space it already committed. Five
//   libraries measured in one process reported ~0 MB for four of them while their
//   stores demonstrably held the data.
// - The library is imported BEFORE the first measurement. Importing it after put its
//   compiled code inside "heap held by the state layer", which is both wrong and
//   unfair to whichever library ships more code. Code size is a separate axis.
// - The measurement is taken after warm-up, so JIT feedback vectors sit outside it.
// - The RAW DATA sits outside it too. All five hold the same 20,000 values, so
//   including them added the same constant to everyone and hid the thing being
//   compared: what the state layer adds on top, and what one mounted window costs.
// - The footprint is taken with ONE window mounted. The repeated timing passes each
//   pushed another window of handles, so this used to report the heap for 1,000 live
//   subscriptions while calling it a 200-row window.
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const own = createRequire(resolve(ROOT, 'package.json'));
const KEYS = 20_000;
const WINDOW = 200;
/**
 * Memory is measured over a much larger window than timing is.
 *
 * At 200 rows the per-row figure swung between 545 and 2201 bytes across runs for
 * identical code: whatever a `heapUsed` delta picks up that is not the window divides
 * by only 200. Over 5,000 rows the same noise divides by 25 times more, and the figure
 * reproduces. Timing stays at 200, which is a realistic visible window.
 */
const MEM_WINDOW = 5_000;
const which = process.argv[2];
/**
 * 'timing', 'memory', or both by default. `run.mjs` asks for each in its own
 * process: after a timing pass has made the library's function literals hot,
 * V8 allocates feedback vectors eagerly for every closure the NEXT store
 * creates, and that charged a library ~1-2 KB per closure it defines (measured:
 * +209 KB on the store with the most closures, for identical data). Memory is
 * therefore taken in a process where nothing has run hot, which is what "the
 * heap the state layer adds" means.
 */
const mode = process.argv[3] ?? 'all';

// ── Load the library first, so none of it lands inside a measurement ─────────
const lib =
	which === 'segment'
		? // Lets the A/B driver feed two builds through this exact same fresh-process
			// timing and heap harness instead of copying it for each candidate.
			await import(process.env.SEGMENT_CORE ?? './.build/core.js')
		: which === 'jotai'
			? await import(own.resolve('jotai/vanilla'))
			: which === 'zustand'
				? await import(own.resolve('zustand/vanilla'))
				: which === 'valtio'
					? await import(own.resolve('valtio/vanilla'))
					: which === 'redux'
						? await import(own.resolve('redux'))
						: undefined;
if (lib === undefined) throw new Error(`unknown library ${which}`);

// ── The raw data, which every library holds and none should be charged for ───
const KEY = Array.from({ length: KEYS }, (_, i) => `k${i}`);
const VALUE = Array.from({ length: KEYS }, (_, i) => `v${i}`);

function settle() {
	for (let i = 0; i < 6; i++) global.gc();
	return process.memoryUsage().heapUsed;
}

/**
 * Each adapter loads the same 20,000 values and exposes the two operations a mounted
 * row performs: subscribe to its own address, and read it.
 */
const ADAPTERS = {
	segment: () => {
		const { createStore, segment } = lib;
		const store = createStore({ rows: segment('') });
		const bulk = Object.create(null);
		for (let i = 0; i < KEYS; i++) bulk[KEY[i]] = VALUE[i];
		store.state.rows.replaceAll(bulk);
		const s = store.state;
		return {
			// The keyed subscription the view ships for exactly this pattern; the
			// ref-building form `store.observe(s.rows.at(key), cb)` is equivalent.
			subscribe: (i) => s.rows.observe(KEY[i], () => {}),
			// The same read shape the other adapters use: zustand and redux read
			// `getState()[key]`, valtio reads `state.rows[key]`, and `snapshot()`
			// is Segment's documented handle on the partition. Reading through
			// `store.get(s.rows.at(key))` instead would also intern a descriptor
			// per row, which is the render-path optimization, not the read.
			read: (i) => s.rows.snapshot()[KEY[i]],
		};
	},
	jotai: () => {
		const store = lib.createStore();
		// An atom exists only once asked for, so holding the dataset means creating
		// them all. That IS the atom-per-key footprint.
		const family = new Map();
		for (let i = 0; i < KEYS; i++) family.set(i, lib.atom(VALUE[i]));
		return {
			subscribe: (i) => store.sub(family.get(i), () => {}),
			read: (i) => store.get(family.get(i)),
		};
	},
	zustand: () => {
		const initial = {};
		for (let i = 0; i < KEYS; i++) initial[KEY[i]] = VALUE[i];
		const store = lib.createStore(() => initial);
		return {
			subscribe: () => store.subscribe(() => {}),
			read: (i) => store.getState()[KEY[i]],
		};
	},
	valtio: () => {
		// The same record-per-key shape run.mjs uses for valtio's A and C axes:
		// valtio subscribes to an OBJECT, so watching one row means watching the
		// record that contains its field. The flat-string variant this file used
		// before subscribed every "row" to the ROOT proxy, which is neither
		// per-row addressing nor the configuration the other axes measure, so
		// valtio's results row was quietly mixing two incompatible fixtures.
		const state = lib.proxy({ rows: {} });
		for (let i = 0; i < KEYS; i++) state.rows[KEY[i]] = { name: VALUE[i] };
		return {
			subscribe: (i) => lib.subscribe(state.rows[KEY[i]], () => {}, true),
			read: (i) => state.rows[KEY[i]].name,
		};
	},
	redux: () => {
		const initial = {};
		for (let i = 0; i < KEYS; i++) initial[KEY[i]] = VALUE[i];
		const store = lib.createStore((s = initial) => s);
		return {
			subscribe: () => store.subscribe(() => {}),
			read: (i) => store.getState()[KEY[i]],
		};
	},
};

const make = ADAPTERS[which];

/** Best of N: interference only ever makes a pass slower. */
function fastest(passes, run) {
	let best = Infinity;
	for (let pass = 0; pass < passes; pass++) {
		const start = process.hrtime.bigint();
		run();
		const ms = Number(process.hrtime.bigint() - start) / 1e6;
		if (ms < best) best = ms;
	}
	return best;
}

function windowOf(api, rows = WINDOW) {
	const held = [];
	return {
		held,
		rows,
		mount: () => {
			for (let i = 0; i < rows; i++) {
				held.push(api.subscribe(i));
				api.read(i);
			}
		},
		unmount: () => {
			for (const off of held) off();
			held.length = 0;
		},
	};
}

// ── Timing: cold first, because a cold mount is what a page load pays ────────
const wantTiming = mode !== 'memory';
const wantMemory = mode !== 'timing';
const api = wantTiming ? make() : null;

// Retire the SETUP's allocation debt before the window opens, without forcing a
// GC. The dataset the adapter just built sits live in the nursery, and the next
// scavenge evacuates it at ~0.5 ms — a bill that landed inside whichever
// library's mount allocated enough to trigger it (the per-key libraries) and
// outside the others', purely as a step function of window size. Forced
// `global.gc()` here would be its own distortion: repeated full GCs age and
// flush lazily-compiled bytecode, which taxed the small-mount libraries 15-100 µs
// for code recompilation. Plain transient allocation churns the nursery through
// natural scavenges instead: the dataset is promoted out, and the window opens
// with the same quiet heap for everyone. It also evicts the dataset from the CPU
// cache, which is the realistic state — a real mount does not run within
// microseconds of parsing the payload, and the L2-warm dataset was flattering
// the read half of the small-mount libraries by ~20 µs.
const result = { library: which, rows: WINDOW };

if (wantTiming) {
	{
		let sink = null;
		for (let i = 0; i < 2_000_000; i++) sink = [i, 0];
		if (sink.length !== 2) throw new Error('unreachable');
	}
	// Pin the nursery phase: the filler leaves the semispace at whatever fill
	// level its last iteration happened to reach, so whether the window's own
	// allocations cross the scavenge threshold inside the timed region was
	// luck. A single MINOR collection is cheap (the filler's garbage is dead,
	// so there is nothing to evacuate), does not age or flush compiled code the
	// way the forced full GCs of flaw 7 did, and every library's window now
	// opens at the same nursery phase.
	global.gc({ type: 'minor' });

	const live = windowOf(api);
	result.coldMountMs = (() => {
		const start = process.hrtime.bigint();
		live.mount();
		return Number(process.hrtime.bigint() - start) / 1e6;
	})();
	result.teardownMs = (() => {
		const start = process.hrtime.bigint();
		live.unmount();
		return Number(process.hrtime.bigint() - start) / 1e6;
	})();
	result.cycleMs = fastest(20, () => {
		live.mount();
		live.unmount();
	});
}

// ── Memory: what the layer adds over the raw data, and what a window costs ───
if (wantMemory) {
	// A throwaway store first, so the library's one-time compile residue (lazily
	// compiled bytecode, any warm-up it runs) sits OUTSIDE the measurement, the
	// same way the import does. The measured store is the second one, in a
	// process where no timing loop has made the literals hot, so neither
	// first-call compilation nor eager feedback vectors are billed as state.
	make();
	const beforeStore = settle();
	const measured = make();
	const mounted = windowOf(measured, MEM_WINDOW);
	const afterStore = settle();
	mounted.mount();
	const afterWindow = settle();
	if (measured.read(0) !== 'v0' || mounted.held.length !== MEM_WINDOW) {
		throw new Error('fixture did not hold its data');
	}
	/** Heap the state layer adds on top of the 20,000 raw values. */
	result.layerBytes = Math.max(0, afterStore - beforeStore);
	/** Heap one mounted row costs, averaged over a large window (see MEM_WINDOW). */
	result.bytesPerRow = Math.max(0, afterWindow - afterStore) / MEM_WINDOW;
}

process.stdout.write(JSON.stringify(result));
