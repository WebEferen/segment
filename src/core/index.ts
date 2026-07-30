// @webeferen/segment — path-addressed state, with no dependency on Octane,
// the DOM, or any renderer. It runs in a browser, in Node, and in a worker.
//
// The design is constrained by two spikes that were run before any of this was
// written, and every constraint below is load-bearing:
//
//  1. Memory is O(observed), not O(data). Bulk data lives on a Segment as one
//     opaque value with a single version stamp, and nodes below it materialize
//     only while something observes them. Materialization is REVERSIBLE — nodes
//     are pruned when the last observer leaves — which is what makes the
//     property survive a scrolling list rather than degrading to
//     O(ever-observed).
//  2. Writes go THROUGH to the bulk value rather than shadowing it in a
//     copy-on-write node. That is what makes pruning sound, so it is not a free
//     choice: a copy-on-write variant would have to pin written nodes and would
//     lose (1).
//  3. Implementations live in `.with()`, not in the shape literal. A callback
//     inside the literal cannot see the type being inferred from it —
//     TypeScript collapses it to `never`.
//
// The Octane adapter is a separate entry point. Nothing here imports it, and
// nothing here may.

export { createStore } from './store.js';
export type { Store, StoreStats } from './store.js';

// Shape markers. A primitive, array, Date, Map, or Set needs none of these: the
// value itself declares a cell and supplies its initial value.
export { action, cell, derived, list, resource, segment, task } from './schema.js';

export type {
	Act,
	ActionDef,
	AddressKind,
	AnyDef,
	BranchValueOf,
	BranchView,
	CellDef,
	Commit,
	DehydrateOptions,
	DerivedDef,
	Dispose,
	Get,
	HydrateOptions,
	HydrateResult,
	Impl,
	ListDef,
	ListView,
	LiveContext,
	LoadContext,
	NeedsImpl,
	ObserveOptions,
	Payload,
	Port,
	PortContext,
	Ref,
	ResourceDef,
	ResourceImpl,
	ResourceSnapshot,
	ResourceStatus,
	SaveContext,
	SegmentDef,
	SegmentView,
	Setter,
	Snapshot,
	TaskContext,
	TaskDef,
	Tx,
	ValueTuple,
	View,
	Write,
} from './types.js';
