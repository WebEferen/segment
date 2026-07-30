// Compile the core to plain JS so a measurement reflects the library rather than the
// transpiler. `keepNames` is off on purpose: tsx leaves it on, and its `__name`
// wrapper around every function dominated an earlier profile.
import { build } from 'esbuild';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// `--src <dir> --out <file>` builds a VARIANT of the core, so a candidate optimization
// can be A/B'd against the current one without editing the package. `hot.mjs` reads the
// same core from SEGMENT_CORE, so a variant is measured by the identical harness.
const here = dirname(new URL(import.meta.url).pathname);
const arg = (name, fallback) => {
	const i = process.argv.indexOf(name);
	return i === -1 ? fallback : process.argv[i + 1];
};
const src = arg('--src', resolve(here, '../../src'));
const out = resolve(arg('--out', resolve(here, '.build/core.js')));
mkdirSync(dirname(out), { recursive: true });

await build({
	entryPoints: [resolve(src, 'core/index.ts')],
	outfile: out,
	bundle: true,
	format: 'esm',
	platform: 'node',
	target: 'node22',
	keepNames: false,
	minify: false,
	define: { 'process.env.NODE_ENV': '"production"' },
});
console.log('built', out);
