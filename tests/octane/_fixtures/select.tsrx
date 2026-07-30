import { useValue } from 'segment-state/octane';
import type { AppStore } from './store.js';

interface Props {
	app: AppStore;
	runs: { n: number };
}

/**
 * The selector form. It becomes an anonymous derivation owned by THIS call site,
 * so it re-runs only when an address it read has moved — not on every commit.
 */
export function Selected({ app, runs }: Props) @{
	const [label] = useValue(app.store, (get, s) => {
		runs.n++;
		return `${get(s.ui.theme)}#${get(s.ui.count)}`;
	});
	<p id="selected">{label as string}</p>
}
