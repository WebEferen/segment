// The package root is the Octane-facing application API. The renderer-free
// engine remains available through /core, without leaking hooks into that entry.
import { createStore, useDraft, useStatus, useValue } from '../src/index.js';
import { createStore as createCoreStore } from '../src/core/index.js';
// @ts-expect-error Octane hooks belong to the package root, not the core entry.
import { useValue as coreUseValue } from '../src/core/index.js';

const app = createStore({ count: 0 });
const [count, setCount] = useValue(app.state.count);

export const typedCount: number = count;
export const typedSetter: (next: number | ((prev: number) => number)) => void = setCount;
export const hooks = { useDraft, useStatus, useValue };
export const coreStore = createCoreStore({ count: 0 });

void coreUseValue;
