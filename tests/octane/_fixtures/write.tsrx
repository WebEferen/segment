import { useValue } from 'segment-state/octane';
import type { AppStore } from './store.js';

export function ThemeToggle({ app }: { app: AppStore }) @{
	const [theme, setTheme] = useValue(app.s.ui.theme);
	<div>
		<p id="theme">{theme as string}</p>
		<button id="dark" onClick={() => setTheme('dark')}>dark</button>
		<button id="flip" onClick={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}>
			flip
		</button>
	</div>
}

/**
 * A derivation is computed, so there is no setter to hand back. The TYPE of the
 * second member is `never`, which is why this fixture has to reach for it through
 * a cast: a TypeScript author simply could not write this by accident.
 */
export function WriteThroughDerived({ app }: { app: AppStore }) @{
	const pair = useValue(app.s.totals.doubled) as unknown as [number, (n: number) => void];
	// Called during setup rather than from an event: a delegated handler's error is
	// reported by the runtime instead of reaching the caller, which would make the
	// assertion about Octane's error routing rather than about this guard.
	pair[1](1);
	<p id="bad">{pair[0] as string}</p>
}
