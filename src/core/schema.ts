import type {
	ActionDef,
	AnyDef,
	CellDef,
	DerivedDef,
	Get,
	ListDef,
	ResourceDef,
	ResourceImpl,
	SegmentDef,
	TaskContext,
	TaskDef,
	Tx,
} from './types.js';

/**
 * Runtime brand on every marker. A plain branch object is told apart from a
 * marker by THIS, not by sniffing a `kind` string — otherwise a branch that
 * happens to contain a field named `kind` would be misread as a marker, silently
 * producing a store with a missing subtree.
 */
export const DEF: unique symbol = Symbol('@octanejs/segment.def');

export const BRANCH = 0;
export const CELL = 1;
export const DERIVED = 2;
export const ACTION = 3;
export const BULK = 4;
export const RESOURCE = 5;
export const TASK = 6;

/** Reserved prefix for `store.derive()`, kept out of an author's address space. */
export const DERIVE_PREFIX = '$derive:';
/** Reserved prefix for `store.resourceOf()`. */
export const FETCH_PREFIX = '$fetch:';

/** Every prefix the store owns, so a shape cannot collide with one. */
export const RESERVED_PREFIXES: readonly string[] = [DERIVE_PREFIX, FETCH_PREFIX];

/** Normalize the two resource authoring forms into the one shape the store uses. */
export function normalizeResource(impl: unknown, path: string): SchemaNode['resource'] {
	const candidate = impl as { load?: unknown } | ((ctx: never) => unknown);
	const normalized =
		typeof candidate === 'function'
			? { load: candidate }
			: candidate !== null && typeof candidate === 'object' && typeof candidate.load === 'function'
				? candidate
				: undefined;
	if (normalized === undefined) {
		fail(
			`resource "${path || '<root>'}" must be an async function, ` + 'or an object with a `load`',
		);
	}
	return normalized as SchemaNode['resource'];
}

/** Names the accessor tree itself occupies on every node. */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
	'path',
	'at',
	'observe',
	'replaceAll',
	'snapshot',
]);

export const BULK_LIST = 2;
export const BULK_SEGMENT = 3;

export interface SchemaNode {
	kind: number;
	/** 0 when not a bulk holder, otherwise which flavour. */
	bulk: number;
	children: Map<string, SchemaNode> | null;
	/** Shape reached through any key of a bulk holder. */
	dynamic: SchemaNode | null;
	init: unknown;
	derive: ((get: Get) => unknown) | null;
	action: ((tx: Tx, ...args: unknown[]) => void) | null;
	task: ((ctx: TaskContext, ...args: unknown[]) => unknown) | null;
	/** Normalized resource implementation: the bare-function form is widened here once. */
	resource: {
		load: (ctx: never) => unknown;
		save?: (ctx: never) => unknown;
		live?: (ctx: never) => (() => void) | void;
	} | null;
	/**
	 * True when no bulk holder sits above this node. Such nodes are bounded by
	 * the schema, so they are materialized eagerly; everything below a bulk
	 * holder is materialized only on observation.
	 */
	fixed: boolean;
	/** Schema path with `*` standing in for a dynamic segment. */
	path: string;
	/**
	 * Shared prototype for the accessor views of this node, built on first use by the
	 * store that owns this schema. Schema nodes are per-store, so this caches nothing
	 * across stores.
	 */
	proto: object | null;
	/**
	 * Run state a task maintains for itself. It is real, readable state, but it
	 * describes THIS session's attempt, so `dehydrate` leaves it out: shipping
	 * "running" from a server render would be a lie on arrival.
	 */
	transient: boolean;
	/**
	 * Argument segments a resource address carries: -1 until the first call pins it,
	 * 0 for a plain resource. `resolveSchema` skips exactly this many segments.
	 */
	arity: number;
}

// ── Markers ─────────────────────────────────────────────────────────────────
//
// Free functions rather than methods on a builder object, so a shape needs no
// callback wrapper and unused markers tree-shake away. Only the things a VALUE
// cannot express need one: a key type, or a slot that is computed.

function mark<T extends object>(value: T): T {
	Object.defineProperty(value, DEF, { value: true, enumerable: false });
	return value;
}

/**
 * Escape hatch for an object you want stored as one value rather than walked as
 * a branch. Primitives, arrays, Dates, Maps, and Sets are already treated as
 * values, so this is only for a plain object or a narrowed literal union.
 */
export function cell<T>(init: T): CellDef<T> {
	return mark({ kind: 'cell', init }) as CellDef<T>;
}

/** An addressable list: each item's fields get their own address. */
export function list<S>(shape: S): ListDef<S> {
	return mark({ kind: 'list', shape }) as ListDef<S>;
}

/**
 * A bulk partition: contents live as one opaque value with a single version
 * stamp, and nodes below materialize only while observed.
 *
 * `segment(shape)` for plain string keys, `segment<UserId>()(shape)` for a branded
 * one (see `dict` for why the second form is curried).
 */
export function segment<S extends object>(shape: S): SegmentDef<string, S>;
export function segment<K extends string>(): <S>(shape: S) => SegmentDef<K, S>;
export function segment(shape?: unknown): unknown {
	if (shape !== undefined) return mark({ kind: 'segment', shape });
	return (inner: unknown) => mark({ kind: 'segment', shape: inner });
}

/** A computed value. Implemented in `.with()`. */
export function derived<T>(): DerivedDef<T> {
	return mark({ kind: 'derived' }) as DerivedDef<T>;
}

/**
 * A fetched value. Implemented in `.with()`.
 *
 * With an argument tuple, the address becomes callable and the arguments turn into
 * PATH SEGMENTS: `resource<Result[], [q: string, page: number]>()` is addressed as
 * `s.search('ada', 2)`, which is the path `search/ada/2`. That is why the cache is
 * per argument set without a separate cache key, and why staleness, `dehydrate`,
 * and ports need no special case for it.
 *
 * Arguments therefore have to be primitives: they are stringified into the path.
 */
export function resource<T, A extends readonly unknown[] = []>(): ResourceDef<T, A> {
	// Arity cannot be read from a type, so it is inferred at the first call and
	// pinned there; a resource is always addressed with the same argument count.
	return mark({ kind: 'resource', arity: -1 }) as ResourceDef<T, A>;
}

/**
 * A state transition callable from the accessor tree: ONE commit, all or nothing.
 * Implemented in `.with()`.
 */
export function action<A extends unknown[] = []>(): ActionDef<A> {
	return mark({ kind: 'action' }) as ActionDef<A>;
}

/**
 * An async operation that takes SEVERAL commits over time, each atomic. Separate
 * from `action` because its implementation receives `act` rather than a `tx` — a
 * `tx` is only live for one synchronous transaction, so a write after an `await`
 * would be staged into an already-committed set and lost.
 */
export function task<A extends unknown[] = [], R = void>(): TaskDef<A, R> {
	return mark({ kind: 'task' }) as TaskDef<A, R>;
}

// ── Compilation ─────────────────────────────────────────────────────────────

function isDef(value: unknown): value is AnyDef {
	return typeof value === 'object' && value !== null && DEF in value;
}

/**
 * Mirrors the `IsCell` type: a plain object nests, everything else is a value.
 * Keeping the two in step is what makes the inferred types match the runtime.
 */
function isValue(shape: unknown): boolean {
	if (shape === null || typeof shape !== 'object') return true;
	if (Array.isArray(shape)) return true;
	return (
		shape instanceof Date || shape instanceof Map || shape instanceof Set || shape instanceof RegExp
	);
}

function fail(message: string): never {
	throw new Error(`[@octanejs/segment] ${message}`);
}

function join(parent: string, segmentName: string): string {
	return parent === '' ? segmentName : `${parent}/${segmentName}`;
}

function node(kind: number, path: string, fixed: boolean): SchemaNode {
	return {
		kind,
		bulk: 0,
		children: null,
		dynamic: null,
		init: undefined,
		derive: null,
		action: null,
		task: null,
		resource: null,
		fixed,
		path,
		proto: null,
		arity: 0,
		transient: false,
	};
}

/**
 * Fold a shape into a static schema. The shape carries NO implementations —
 * those arrive through `installImpls` from `.with()`, which is the only place
 * TypeScript can see the resolved shape (see the S1 spike).
 */
export function compileSchema(shape: unknown, path = '', fixed = true): SchemaNode {
	if (isDef(shape)) {
		switch (shape.kind) {
			case 'cell': {
				const n = node(CELL, path, fixed);
				n.init = (shape as CellDef<unknown>).init;
				return n;
			}
			case 'derived':
				return node(DERIVED, path, fixed);
			case 'resource': {
				const n = node(RESOURCE, path, fixed);
				n.arity = (shape as { arity: number }).arity;
				return n;
			}
			case 'action':
				return node(ACTION, path, fixed);
			case 'task': {
				const n = node(TASK, path, fixed);
				// A task exposes its own run state, so a caller never has to write
				// status/result/error by hand in every task it declares.
				n.children = new Map();
				for (const [child, init] of [
					['status', 'idle'],
					['result', undefined],
					['error', undefined],
				] as const) {
					const c = node(CELL, join(path, child), fixed);
					c.init = init;
					c.transient = true;
					n.children.set(child, c);
				}
				return n;
			}
			case 'list':
			case 'segment': {
				const n = node(BULK, path, fixed);
				n.bulk = shape.kind === 'list' ? BULK_LIST : BULK_SEGMENT;
				const inner = (shape as ListDef<unknown> | SegmentDef<string, unknown>).shape;
				// Everything under a bulk holder is unbounded, so it stops being
				// eagerly materialized here.
				n.dynamic = compileSchema(inner, join(path, '*'), false);
				return n;
			}
			default:
				return fail(
					`unknown marker "${String((shape as { kind: unknown }).kind)}" at "${path || '<root>'}"`,
				);
		}
	}

	// A bare function is almost always a mistake: the author meant `action()` or
	// `task()`. It would otherwise become a cell holding a function, which works at
	// runtime but vanishes silently from a dehydrated payload. `cell(fn)` remains
	// available for someone who really does want to store one.
	if (typeof shape === 'function') {
		fail(
			`"${path || '<root>'}" is a function. Did you mean action() for one commit, ` +
				'or task() for an async flow? To store a function as a value, wrap it in ' +
				'cell(), and note that it will not survive dehydrate().',
		);
	}

	// A raw value IS the declaration: it names the cell and supplies its initial
	// value, so the common case needs no marker at all.
	if (isValue(shape)) {
		const n = node(CELL, path, fixed);
		n.init = shape;
		return n;
	}

	const n = node(BRANCH, path, fixed);
	n.children = new Map();
	for (const [key, child] of Object.entries(shape as Record<string, unknown>)) {
		for (const prefix of RESERVED_PREFIXES) {
			if (key.startsWith(prefix)) fail(`"${join(path, key)}" uses the reserved "${prefix}" prefix`);
		}
		// The accessor tree puts these on every node, so a shape key of the same name
		// would shadow one and break addressing silently.
		if (RESERVED_KEYS.has(key)) {
			fail(`"${join(path, key)}" is a reserved key; the accessor tree uses it`);
		}
		n.children.set(key, compileSchema(child, join(path, key), fixed));
	}
	return n;
}

/**
 * Attach the implementations `.with()` returned.
 *
 * Deliberately silent about ABSENT implementations: reporting the first one here
 * would hide every other, and a list of all of them is far more useful than a
 * game of whack-a-mole. `missingImpls` produces that list. A PRESENT
 * implementation of the wrong shape still fails immediately, because that is a
 * typo rather than an omission.
 */
export function installImpls(schemaNode: SchemaNode, impls: unknown): void {
	switch (schemaNode.kind) {
		case DERIVED: {
			if (impls === undefined) return;
			if (typeof impls !== 'function') {
				fail(`derived "${schemaNode.path || '<root>'}" must be a function of (get)`);
			}
			schemaNode.derive = impls as SchemaNode['derive'];
			return;
		}
		case TASK: {
			if (impls === undefined) return;
			if (typeof impls !== 'function') {
				fail(`task "${schemaNode.path || '<root>'}" must be a function of (ctx, ...args)`);
			}
			schemaNode.task = impls as SchemaNode['task'];
			return;
		}
		case ACTION: {
			if (impls === undefined) return;
			if (typeof impls !== 'function') {
				fail(`action "${schemaNode.path || '<root>'}" must be a function of (tx, ...args)`);
			}
			schemaNode.action = impls as SchemaNode['action'];
			return;
		}
		case RESOURCE: {
			if (impls === undefined) return;
			schemaNode.resource = normalizeResource(impls, schemaNode.path);
			return;
		}
		case BULK:
			// One implementation serves every key of a bulk holder.
			installImpls(schemaNode.dynamic!, impls);
			return;
		case CELL:
			return;
		default: {
			if (schemaNode.children === null) return;
			const record = (typeof impls === 'object' && impls !== null ? impls : {}) as Record<
				string,
				unknown
			>;
			for (const [key, child] of schemaNode.children) installImpls(child, record[key]);
		}
	}
}

/** Every declared slot that still has no implementation, for a single clear error. */
export function missingImpls(schemaNode: SchemaNode, out: string[] = []): string[] {
	switch (schemaNode.kind) {
		case DERIVED:
			if (schemaNode.derive === null) out.push(schemaNode.path);
			return out;
		case ACTION:
			if (schemaNode.action === null) out.push(schemaNode.path);
			return out;
		case TASK:
			if (schemaNode.task === null) out.push(schemaNode.path);
			return out;
		case RESOURCE:
			if (schemaNode.resource === null) out.push(schemaNode.path);
			return out;
		case BULK:
			return missingImpls(schemaNode.dynamic!, out);
		case CELL:
			return out;
		default:
			if (schemaNode.children !== null) {
				for (const child of schemaNode.children.values()) missingImpls(child, out);
			}
			return out;
	}
}

/**
 * Resolve a path against the schema. Dynamic segments are consumed by the bulk
 * holder above them, so `users/42/name` resolves through `users` → `*` → `name`.
 * Returns null for a path the schema does not describe.
 */
export function resolveSchema(root: SchemaNode, segments: readonly string[]): SchemaNode | null {
	let current = root;
	for (let i = 0; i < segments.length; i++) {
		if (current.kind === BULK) {
			current = current.dynamic!;
			continue;
		}
		// A parameterized resource swallows its argument segments: they identify WHICH
		// fetch, not a deeper address.
		if (current.kind === RESOURCE && current.arity > 0) return current;
		const child = current.children === null ? undefined : current.children.get(segments[i]);
		if (child === undefined) return null;
		current = child;
	}
	return current;
}
