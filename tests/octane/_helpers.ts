/** Test helpers kept local so the standalone package never imports Octane's test tree. */
import {
	act,
	createRoot,
	delegateEvents,
	drainPassiveEffects,
	flushSync,
	type ComponentBody,
	type Root,
} from 'octane';

export { act };

delegateEvents(['click', 'input', 'change', 'keydown', 'submit']);

export interface MountResult {
	container: HTMLElement;
	root: Root;
	html(): string;
	unmount(): void;
	click(selector: string): void;
	find(selector: string): Element;
	findAll(selector: string): Element[];
	update<P>(body: ComponentBody<P>, props?: P): void;
}

export function mount<P = undefined>(body: ComponentBody<P>, props?: P): MountResult {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		root.render(body, props);
		flushSync(() => {});
	} catch (error) {
		try {
			root.unmount();
		} finally {
			container.remove();
		}
		throw error;
	}
	return {
		container,
		root,
		html: () => container.innerHTML,
		unmount() {
			root.unmount();
			container.remove();
		},
		click(selector) {
			const element = container.querySelector(selector);
			if (element === null) throw new Error(`no element matching ${selector}`);
			flushSync(() => {
				if (typeof (element as HTMLElement).click === 'function') {
					(element as HTMLElement).click();
				} else {
					element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
				}
			});
		},
		find(selector) {
			const element = container.querySelector(selector);
			if (element === null) throw new Error(`no element matching ${selector}`);
			return element;
		},
		findAll: (selector) => Array.from(container.querySelectorAll(selector)),
		update(body, nextProps) {
			flushSync(() => root.render(body, nextProps));
		},
	};
}

export function flushEffects(): void {
	drainPassiveEffects();
}

export function nextPaint(): Promise<void> {
	drainPassiveEffects();
	return Promise.resolve();
}

export interface EffectLog {
	push: (entry: string) => void;
	entries: readonly string[];
	drain: () => string[];
	clear: () => void;
}

export function createLog(): EffectLog {
	const entries: string[] = [];
	return {
		entries,
		push: (entry) => entries.push(entry),
		drain: () => entries.splice(0, entries.length),
		clear: () => {
			entries.length = 0;
		},
	};
}
