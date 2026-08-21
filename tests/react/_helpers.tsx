/** Test helpers kept local so the React suite never imports Octane's test tree. */
import { act, Component, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

export { act };

export interface MountResult {
	container: HTMLElement;
	root: Root;
	html(): string;
	unmount(): void;
	click(selector: string): void;
	type(selector: string, value: string): void;
	find(selector: string): Element;
	findAll(selector: string): Element[];
	update(node: ReactNode): void;
}

export function mount(node: ReactNode): MountResult {
	const container = document.createElement('div');
	document.body.appendChild(container);
	const root = createRoot(container);
	try {
		act(() => root.render(node));
	} catch (error) {
		try {
			act(() => root.unmount());
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
			act(() => root.unmount());
			container.remove();
		},
		click(selector) {
			const element = container.querySelector(selector);
			if (element === null) throw new Error(`no element matching ${selector}`);
			act(() => {
				element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
			});
		},
		type(selector, value) {
			const element = container.querySelector(selector);
			if (element === null) throw new Error(`no element matching ${selector}`);
			const input = element as HTMLInputElement;
			// React tracks the value it last rendered, so the write has to go through
			// the native setter or the following input event reports no change.
			const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
			act(() => {
				setter.call(input, value);
				input.dispatchEvent(new Event('input', { bubbles: true }));
			});
		},
		find(selector) {
			const element = container.querySelector(selector);
			if (element === null) throw new Error(`no element matching ${selector}`);
			return element;
		},
		findAll: (selector) => Array.from(container.querySelectorAll(selector)),
		update(next) {
			act(() => root.render(next));
		},
	};
}

/**
 * Mounts a tree that may suspend. React registers the resume for a thrown
 * promise only when the suspending render runs inside an ASYNC act; a tree
 * mounted through the sync variant shows its fallback and then never retries.
 */
export async function mountSuspending(node: ReactNode): Promise<MountResult> {
	let view!: MountResult;
	await act(async () => {
		view = mount(node);
	});
	return view;
}

/** Drains the microtask chain a settled resource walks before React retries. */
export async function settled(): Promise<void> {
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

interface BoundaryProps {
	fallback: ReactNode;
	children: ReactNode;
}

export class ErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
	state = { failed: false };

	static getDerivedStateFromError(): { failed: boolean } {
		return { failed: true };
	}

	render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}
