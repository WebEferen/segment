// The package root is the Octane-facing application API. The renderer-free
// engine remains available through /core, without leaking hooks into that entry.
import { createStore, useDraft, useStatus, useValue } from '../src/index.js';
import { createStore as createCoreStore } from '../src/core/index.js';
// @ts-expect-error Octane hooks belong to the package root, not the core entry.
import { useValue as coreUseValue } from '../src/core/index.js';

// The React entry mirrors the root surface, with the React binding in place of
// the Octane one and the same setter typing.
import {
	createStore as createReactEntryStore,
	useDraft as reactUseDraft,
	useStatus as reactUseStatus,
	useValue as reactUseValue,
} from '../src/react/index.js';

const app = createStore({ count: 0 });
const [count, setCount] = useValue(app.state.count);

export const typedCount: number = count;
export const typedSetter: (next: number | ((prev: number) => number)) => void = setCount;
export const hooks = { useDraft, useStatus, useValue };
export const coreStore = createCoreStore({ count: 0 });

const reactApp = createReactEntryStore({ count: 0 });
const [reactCount, setReactCount] = reactUseValue(reactApp.state.count);

export const typedReactCount: number = reactCount;
export const typedReactSetter: (next: number | ((prev: number) => number)) => void = setReactCount;
export const reactHooks = {
	useDraft: reactUseDraft,
	useStatus: reactUseStatus,
	useValue: reactUseValue,
};

void coreUseValue;
