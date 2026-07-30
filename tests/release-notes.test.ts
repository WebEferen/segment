import { describe, expect, it } from 'vitest';

import { extractReleaseNotes } from '../scripts/release-notes.mjs';

describe('release notes', () => {
	it('extracts only the requested changelog section', () => {
		const changelog = `# package

## 0.2.0

### Minor Changes

- Add the next feature.

## 0.1.0

### Patch Changes

- Initial release.
`;

		expect(extractReleaseNotes(changelog, '0.2.0')).toBe(
			'### Minor Changes\n\n- Add the next feature.\n',
		);
	});

	it('fails when the version has no changelog section', () => {
		expect(() => extractReleaseNotes('# package\n', '1.0.0')).toThrow(
			'CHANGELOG.md does not contain ## 1.0.0',
		);
	});

	it('fails when the changelog section is empty', () => {
		expect(() => extractReleaseNotes('## 1.0.0\n\n## 0.9.0\n\n- Previous', '1.0.0')).toThrow(
			'## 1.0.0 does not contain release notes',
		);
	});
});
