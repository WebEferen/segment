import { cpSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

function run(args, extraEnv = {}) {
	const result = spawnSync(pnpm, args, {
		cwd: root,
		stdio: 'inherit',
		env: { ...process.env, ...extraEnv },
	});

	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
}

run(['build']);
run(['--dir', 'playground', 'exec', 'vite', 'build', '--base=/segment/playground/']);
run(['exec', 'vitepress', 'build', 'docs']);

const source = resolve(root, 'playground/dist');
const target = resolve(root, 'docs/.vitepress/dist/playground');

if (!existsSync(resolve(source, 'index.html'))) {
	throw new Error('Playground build did not produce index.html');
}

cpSync(source, target, { recursive: true, force: true });
console.log('Embedded playground at docs/.vitepress/dist/playground');
