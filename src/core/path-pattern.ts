/** Match the path grammar shared by SSR slices and port watches. */
export function matchesPath(pattern: readonly string[], path: string): boolean {
	const segments = path.split('/');
	let p = 0;
	let s = 0;
	while (p < pattern.length) {
		const token = pattern[p];
		if (token === '**') return s < segments.length;
		if (s >= segments.length) return false;
		if (token !== '*' && token !== segments[s]) return false;
		p++;
		s++;
	}
	return s === segments.length;
}

/** First concrete path segment, without allocating `path.split('/')`. */
export function pathHead(path: string): string {
	const at = path.indexOf('/');
	return at < 0 ? path : path.slice(0, at);
}
