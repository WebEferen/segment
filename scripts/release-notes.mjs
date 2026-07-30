import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function extractReleaseNotes(changelog, version) {
	const lines = changelog.split(/\r?\n/);
	const heading = `## ${version}`;
	const start = lines.findIndex((line) => line.trim() === heading);

	if (start === -1) {
		throw new Error(`CHANGELOG.md does not contain ${heading}`);
	}

	const nextHeading = lines.findIndex((line, index) => index > start && /^##\s+/.test(line));
	const end = nextHeading === -1 ? lines.length : nextHeading;
	const notes = lines
		.slice(start + 1, end)
		.join('\n')
		.trim();

	if (notes.length === 0) {
		throw new Error(`${heading} does not contain release notes`);
	}

	return `${notes}\n`;
}

async function main() {
	const version = process.argv[2];
	if (!version) throw new Error('Usage: node scripts/release-notes.mjs <version> [changelog]');

	const changelogPath = resolve(process.argv[3] ?? 'CHANGELOG.md');
	const changelog = await readFile(changelogPath, 'utf8');
	process.stdout.write(extractReleaseNotes(changelog, version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	main().catch((error) => {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	});
}
