import { build } from 'esbuild';
import { gzipSync } from 'node:zlib';

const root = new URL('../', import.meta.url).pathname;

async function bundle(name, contents) {
	const result = await build({
		stdin: { contents, resolveDir: root, sourcefile: `${name}.ts` },
		bundle: true,
		define: { 'process.env.NODE_ENV': '"production"' },
		external: ['octane', 'react'],
		format: 'esm',
		logLevel: 'silent',
		metafile: true,
		minify: true,
		platform: 'browser',
		treeShaking: true,
		write: false,
	});
	const output = result.outputFiles[0].contents;
	const metadata = Object.values(result.metafile.outputs)[0];
	return {
		name,
		gzip: gzipSync(output).length,
		inputs: Object.keys(metadata.inputs),
	};
}

function optionalInputs(result) {
	return result.inputs.filter((input) => /dist\/(?:octane|ports|ssr)\//.test(input));
}

/** The React binding proper; the react entry INDEX is re-exports and not counted. */
function reactBindingInputs(result) {
	return result.inputs.filter((input) => input.includes('dist/react/hooks'));
}

const rootStore = await bundle(
	'root-store',
	'import { createStore } from "./dist/index.js"; export const store = createStore({ count: 0 });',
);
const core = await bundle(
	'core-subpath',
	'import { createStore } from "./dist/core/index.js"; export const store = createStore({ count: 0 });',
);
const octane = await bundle(
	'with-octane',
	'import { useValue } from "./dist/index.js"; export { useValue };',
);
const ssr = await bundle(
	'with-ssr',
	'import { createStore, dehydrate } from "./dist/index.js"; const store = createStore({ count: 0 }); export const payload = dehydrate(store);',
);
const ports = await bundle(
	'with-ports',
	'import { createStore, attachPort } from "./dist/index.js"; const store = createStore({ count: 0 }); export const attach = (port) => attachPort(store, port);',
);
const reactStore = await bundle(
	'react-store',
	'import { createStore } from "./dist/react/index.js"; export const store = createStore({ count: 0 });',
);
const react = await bundle(
	'with-react',
	'import { useValue } from "./dist/react/index.js"; export { useValue };',
);

for (const result of [rootStore, core, reactStore]) {
	const unexpected = optionalInputs(result);
	if (unexpected.length > 0) {
		throw new Error(
			`${result.name} bundle retained renderer or adapters: ${unexpected.join(', ')}`,
		);
	}
}
for (const result of [rootStore, core, octane, ssr, ports, reactStore]) {
	if (reactBindingInputs(result).length > 0) {
		throw new Error(`${result.name} bundle retained the React binding`);
	}
}
if (rootStore.gzip > 10_000) {
	throw new Error(`root store bundle is ${rootStore.gzip} B gzip; budget is 10000 B`);
}
if (reactStore.gzip > 10_000) {
	throw new Error(`react store bundle is ${reactStore.gzip} B gzip; budget is 10000 B`);
}
if (reactBindingInputs(react).length === 0) {
	throw new Error('React import did not retain the React binding');
}
if (optionalInputs(react).length > 0) {
	throw new Error('React import retained Octane, ports, or SSR');
}
if (!optionalInputs(octane).some((input) => input.includes('dist/octane/'))) {
	throw new Error('root Octane import did not retain the Octane binding');
}
if (!optionalInputs(ssr).some((input) => input.includes('dist/ssr/'))) {
	throw new Error('SSR import did not retain the SSR entry point');
}
if (optionalInputs(ssr).some((input) => input.includes('dist/ports/'))) {
	throw new Error('SSR import retained the ports entry point');
}
if (!optionalInputs(ports).some((input) => input.includes('dist/ports/'))) {
	throw new Error('ports import did not retain the ports entry point');
}
if (optionalInputs(ports).some((input) => input.includes('dist/ssr/'))) {
	throw new Error('ports import retained the SSR entry point');
}

for (const result of [rootStore, core, octane, ssr, ports, reactStore, react]) {
	console.log(`${result.name}: ${result.gzip} B gzip`);
}
