// A/B two builds of the core through the SAME harness.
//
//   node benchmarks/segment-state/build.mjs --src <variant-src> --out /tmp/variant/core.js
//   node benchmarks/segment-state/ab.mjs /tmp/variant/core.js
//
// The point is to stop judging an optimization by comparing a fresh run against a number
// written down earlier. Absolute nanoseconds move 2-3x with machine load, so two runs
// minutes apart are not comparable; two runs of the same case seconds apart, alternating
// which build goes first, are.
//
// Each case is measured in its own process (that is `hot.mjs`'s doing), and each build is
// measured REPEATS times per case with the order alternating, so drift lands on both
// builds rather than on whichever went second.
//
// Repetition is not optional. Run against a variant built from IDENTICAL source, one
// pass per build reported 6 cases faster and 6 slower with deltas up to 42%: a single
// best-of-5 does not resolve anything below roughly a factor of two on a busy machine.
// This driver therefore reports each build's own spread across repeats and refuses to
// call a delta a result when it is smaller than that spread.
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const HOT = resolve(import.meta.dirname, 'hot.mjs');
const BASE = process.env.SEGMENT_BASE ?? resolve(import.meta.dirname, '.build/core.js');
const VARIANT = process.argv[2];
if (VARIANT === undefined) {
	throw new Error('usage: node ab.mjs <variant-core.js>   (base from SEGMENT_BASE)');
}

function run(core, ...args) {
	const out = execFileSync(process.execPath, ['--expose-gc', HOT, ...args], {
		encoding: 'utf8',
		env: { ...process.env, SEGMENT_CORE: core },
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	return out;
}

/** Enumerated, not hardcoded, and without running a single measurement to find out. */
const total = Number(run(BASE, 'count'));
const REPEATS = Number(process.env.SEGMENT_AB_REPEATS ?? 5);
const rows = [];
for (let i = 0; i < total; i++) {
	const samples = { base: [], variant: [] };
	let label = '';
	for (let r = 0; r < REPEATS; r++) {
		const baseFirst = (i + r) % 2 === 0;
		const [first, second] = baseFirst ? [BASE, VARIANT] : [VARIANT, BASE];
		const a = JSON.parse(run(first, String(i)));
		const b = JSON.parse(run(second, String(i)));
		const [base, variant] = baseFirst ? [a, b] : [b, a];
		samples.base.push(base.nsPerOp);
		samples.variant.push(variant.nsPerOp);
		label = base.label;
	}
	const low = (xs) => Math.min(...xs);
	const spread = (xs) => (Math.max(...xs) - Math.min(...xs)) / Math.min(...xs);
	rows.push({
		label,
		base: low(samples.base),
		variant: low(samples.variant),
		// The larger of the two builds' own spreads is the floor on what this run can
		// distinguish: a delta below it is indistinguishable from the machine.
		floor: Math.max(spread(samples.base), spread(samples.variant)) * 100,
	});
	process.stderr.write(`${label} done\n`);
}

const width = Math.max(...rows.map((r) => r.label.length)) + 2;
const rule = '='.repeat(width + 34);
console.log('\n' + rule);
console.log('A/B: base vs variant, best of 5, one process per measurement');
console.log(`base    ${BASE}`);
console.log(`variant ${VARIANT}`);
console.log(rule);
console.log(
	'case'.padEnd(width) + 'base'.padEnd(10) + 'variant'.padEnd(10) + 'delta'.padEnd(10) + 'floor',
);
console.log('-'.repeat(width + 40));
let wins = 0;
let losses = 0;
let unresolved = 0;
for (const r of rows) {
	const delta = ((r.variant - r.base) / r.base) * 100;
	let mark = '';
	if (Math.abs(delta) <= r.floor) {
		mark = '';
		unresolved++;
	} else if (delta < 0) {
		mark = ' faster';
		wins++;
	} else {
		mark = ' SLOWER';
		losses++;
	}
	console.log(
		r.label.padEnd(width) +
			r.base.toFixed(1).padEnd(10) +
			r.variant.toFixed(1).padEnd(10) +
			`${delta >= 0 ? '+' : ''}${delta.toFixed(1)}%`.padEnd(10) +
			`+-${r.floor.toFixed(0)}%${mark}`,
	);
}
console.log(rule);
console.log(
	`${wins} faster, ${losses} slower, ${unresolved} below this run's own noise floor ` +
		`(${REPEATS} repeats per build per case)`,
);
console.log(rule);
