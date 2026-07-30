import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const staging = await mkdtemp(join(tmpdir(), 'segment-state-pack-'));

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: 'utf8',
		stdio: 'inherit',
	});

	if (result.error !== undefined) throw result.error;
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(' ')} exited with status ${result.status}`);
	}
}

try {
	run('pnpm', ['pack', '--pack-destination', staging], root);

	const archiveName = `${manifest.name.replace(/^@/, '').replaceAll('/', '-')}-${manifest.version}.tgz`;
	const archive = join(staging, archiveName);
	const consumer = join(staging, 'consumer');
	await mkdir(consumer);
	await writeFile(
		join(consumer, 'package.json'),
		`${JSON.stringify({ name: 'segment-state-pack-smoke', private: true, type: 'module' }, null, 2)}\n`,
	);

	// Installing the tarball catches missing files and broken export paths that a
	// workspace symlink cannot reveal. The package has no required dependencies,
	// so this step is deterministic and does not need registry access.
	run(
		'npm',
		[
			'install',
			'--offline',
			'--ignore-scripts',
			'--no-audit',
			'--no-fund',
			'--package-lock=false',
			archive,
		],
		consumer,
	);

	const smoke = `
		const root = await import('segment-state');
		const core = await import('segment-state/core');
		for (const name of ['cell', 'createStore', 'segment']) {
			if (typeof root[name] !== 'function' || root[name] !== core[name]) {
				throw new Error('broken packed export: ' + name);
			}
		}
		const store = root.createStore({ count: 0 });
		store.set(store.state.count, 1, 'pack/smoke');
		if (store.get(store.state.count) !== 1) throw new Error('packed runtime smoke test failed');
	`;
	run(process.execPath, ['--input-type=module', '--eval', smoke], consumer);

	console.log(`Verified packed artifact: ${archiveName}`);
} finally {
	await rm(staging, { recursive: true, force: true });
}
