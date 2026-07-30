// Slot mechanics, the same shape `@octanejs/jotai` and `@octanejs/tanstack-query`
// use. The Octane compiler injects a per-call-site Symbol into every hook call in
// a COMPILED file; these binding files are plain `.ts` and are not compiled, so a
// hook here receives the caller's slot as its trailing argument and derives a
// distinct sub-slot for each base hook it composes.

// Memoized: subSlot runs on every hook call on every render, so the concat plus
// the `Symbol.for` registry lookup is worth caching.
const subSlotCache = new Map<symbol, Map<string, symbol>>();
const bareTagCache = new Map<string, symbol>();

export function subSlot(slot: symbol | undefined, tag: string): symbol {
	// No inherited slot means the caller was not compiled — a vendored wrapper, or
	// a test calling the hook directly. A stable TAG-ONLY symbol keeps sibling base
	// hooks inside one composed hook distinct; returning undefined would collapse
	// them onto the bare path and collide their state.
	if (slot === undefined) {
		let bare = bareTagCache.get(tag);
		if (bare === undefined) bareTagCache.set(tag, (bare = Symbol.for(`@octanejs/segment:${tag}`)));
		return bare;
	}
	let byTag = subSlotCache.get(slot);
	if (byTag === undefined) subSlotCache.set(slot, (byTag = new Map()));
	let sym = byTag.get(tag);
	if (sym === undefined) byTag.set(tag, (sym = Symbol.for(`${slot.description ?? ''}:${tag}`)));
	return sym;
}

/** Split the compiler-injected trailing slot off a hook's runtime args. */
export function splitSlot(args: unknown[]): [unknown[], symbol | undefined] {
	const tail = args[args.length - 1];
	const slot = typeof tail === 'symbol' ? tail : undefined;
	return [slot !== undefined ? args.slice(0, -1) : args, slot];
}
