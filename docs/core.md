# The Segment core

`segment-state` (also available as `segment-state/core`) is the whole state
engine with no renderer attached. It
imports neither Octane nor the DOM, and that claim is machine-checked: the core has
its own `tsconfig.core.json` with no `dom` lib, so a DOM reference that creeps in
fails typecheck.

This document is the detailed implementation reference. Start with the
[getting-started guide](./guide/getting-started.md) for the public model or the
[advanced guide](./advanced.md) for resources, SSR, and ports.

---

## 1. Two measurements that constrain the implementation

Both were run as throwaway spikes before any of this package was written, and
neither is a preference. They are the reason the design looks the way it does.

### Memory is O(observed), not O(data)

Bulk data lives on a **Segment** as one opaque value with a single version stamp.
Nodes below it materialize only while something observes them.

Measured at three sizes, 200 observed leaves throughout:

| design         | rows      | live nodes | structure     | overhead over the raw data |
| -------------- | --------- | ---------- | ------------- | -------------------------- |
| node per field | 10,000    | 110,002    | 17.3 MB       | 14.2 MB                    |
| node per field | 100,000   | 1,100,002  | 171.4 MB      | 138.0 MB                   |
| node per field | 1,000,000 | 11,000,002 | **1706.6 MB** | 1383.9 MB                  |
| Segment        | 10,000    | 402        | 3.3 MB        | 0.2 MB                     |
| Segment        | 100,000   | 402        | 33.7 MB       | 0.2 MB                     |
| Segment        | 1,000,000 | **402**    | **322.8 MB**  | 0.2 MB                     |

Rows times 100 gives nodes times 100 in one design and times 1.00 in the other.

This does not make the data free. 322 MB of raw records is still 322 MB, and the
answer to that is windowing, not a state library. What it makes free is the **state
layer** on top.

### Materialization has to be reversible, and that forces write-through

Holding the observer set still hides the real problem. A scrolling list replaces
observers by the hundred, and if materialization were one-way, "observed" would
quietly mean "ever observed":

|                 | live observers | distinct leaves touched | live nodes |
| --------------- | -------------- | ----------------------- | ---------- |
| without pruning | 200            | 20,200                  | **40,402** |
| with pruning    | 200            | 200,200                 | **402**    |

Pruning on last-observer-detach is what keeps the property. And pruning is only
sound because **writes go through to the bulk value**, so a materialized node is
never the sole authority for anything. A copy-on-write variant would have to pin
written nodes and would lose the memory property. The write strategy is therefore
not a free choice.

### A consequence worth knowing

Reads always resolve through the bulk value, never through a materialized node's
cached copy. That removes any possibility of a stale materialized read, and it is
why a **branch read returns the record as stored** (possibly `undefined`) rather
than an object of defaults. Per-field defaults are a leaf-read guarantee.

---

## 2. Data structures

### The trie

```
Node {
  seg        the path segment this node is reached by
  parent     upward link, so a stamp reaches the root in O(depth)
  children   Map<string, Node> | null   lazily allocated
  value      only meaningful on a cell, a segment, or a cached derivation
  ver        bumped when anything AT OR UNDER this node is written
  obs1       Observer | null            the first, held directly
  obs        Set<Observer> | null       allocated only on a second
  deepCount  how many observers here are deep, for early exit
  pinned     schema-bounded nodes are never pruned
  view       the `.at(key)` descriptor for this address, interned
}
```

Observers past the first live in a **Set, not an array**: detaching is O(1) instead of
an `indexOf` plus a `splice`, which turns tearing down a widely-observed address from
quadratic into linear. Iteration order is still insertion order. The first observer is
held directly because an empty V8 Set costs about 128 bytes and almost every observed
address has exactly one observer.

### Flat leaf records

A cell-shaped Segment does not materialize a full trie node for each observed key.
Its pinned holder owns a `Map<string, LeafRec>`, and each compact record carries the
key revision, optional interned view, and the first observer directly. Only a second
observer allocates a Set. Removing the last observer deletes one map entry instead of
walking and pruning a child node.

This specialization preserves the same notification and `revision()` contract while
removing fields a flat leaf can never use: children, derived cache, bulk value, schema,
parent linkage, and deep-observer bookkeeping.

`ver` is read back through `store.revision(ref)`. That is how a consumer reading a
whole subtree decides staleness with **one integer compare** instead of diffing a
value it never wanted to hold.

### Eager versus lazy materialization

Nodes above every bulk holder are bounded by the schema, so they are materialized
once at construction and pinned. Everything below a bulk holder is unbounded, so it
materializes only on observation; flat cell leaves use the lighter records described
above instead of nodes.

That split has an observable consequence: a **schema-bounded derivation caches even
with no observer** (its node is pinned, so there is somewhere to cache), while a
derivation under a segment recomputes on each read until something observes it.
Materializing one per read is exactly the O(data) growth the design refuses.

### Complexity

| operation                        | cost                                           |
| -------------------------------- | ---------------------------------------------- |
| read through a ref               | O(depth), allocation-free                      |
| write a leaf                     | O(depth) stamp plus O(woken)                   |
| "did anything under here change" | **O(1)**                                       |
| replace a whole segment          | O(1) at the node, descendants re-seeded lazily |
| read a clean derivation          | O(1)                                           |
| read a dirty derivation          | O(deps) pull, recursive                        |
| commit                           | O(writes x depth + woken)                      |
| observers woken by a write       | only those whose address actually moved        |

The baseline this improves on: any store built on `useSyncExternalStore` pays
O(all subscribers x selector) per write, because every subscriber re-runs its
selector to find out whether it cared.

---

### What the hot paths cost

`benchmarks/segment-state/hot.mjs`, best of 5 over 200,000 operations, one process
per case. The multiplier is against one `Map.get` over the same 20,000 keys, which
came out at 11.7 ns here; read the multiplier rather than the nanoseconds, because
absolute time moves 2-3x with machine load while the multiplier holds.

| operation                                  | ns    | x Map.get |
| ------------------------------------------ | ----- | --------- |
| read a cell through a held ref             | 13.2  | 1.1x      |
| read a segment leaf through a held ref     | 11.5  | 1.1x      |
| read a clean derivation                    | 17.1  | 1.5x      |
| read `.at(key)` on an observed key         | 28.0  | 2.4x      |
| read `.at(key).field` on an observed key   | 42.5  | 3.6x      |
| read `.at(key)`, key not observed          | 45.9  | 3.9x      |
| write a cell, nobody observing             | 40.4  | 3.5x      |
| write a cell, one observer                 | 40.7  | 3.3x      |
| write a cell, a commit subscriber attached | 59.4  | 5.3x      |
| write a segment leaf through a held ref    | 44.5  | 3.9x      |
| write `.at(key)` on an observed key        | 71.0  | 5.8x      |
| write one cell inside `act()`              | 68.5  | 6.0x      |
| write three cells in one `act()`           | 131.1 | 11.2x     |

Five properties are worth stating, because each is a decision rather than a happy
accident:

- **A held-ref read costs about one Map lookup.** It is a walk down already-resolved
  node references with the schema and the bulk holder memoized on the ref, and it
  resolves the ref's internals once rather than three times. There is no hashing and
  no allocation.
- **A write nobody observes allocates nothing beyond the value.** Whether anyone is
  listening is answered by an O(depth) walk that allocates no Set, and the per-write
  commit record is built only when a commit subscriber or a watch pattern exists.
- **A one-write transaction allocates nothing at all.** It never touches the write
  Map: staging goes into a reused record on the transaction frame. Routing it through
  the Map cost 26 ns and 152 bytes, because V8's ordered hash table churns its backing
  store on an insert-then-reset cycle whether you clear it or delete the entry.
- **A one-write commit needs no dedup Set**, because an observer is registered at
  exactly one node and each node on the wake walk is visited once, so a duplicate is
  unrepresentable. An ordinary action is therefore as cheap as a direct `set`.
- **`.at(key)` interns its descriptor on the materialized address** while it is
  observed: a flat leaf record for a cell-shaped Segment, or a trie node for a
  structured record. Detach drops either representation, so memory stays O(observed).
  Ref identity is unspecified by contract precisely so this is allowed.

### Why a group under a segment builds its fields lazily

A group's accessor view used to build a ref for every field. That made reading ONE
field cost as much as the record is wide:

| fields in the record | ns to read one field |
| -------------------- | -------------------- |
| 1                    | 218                  |
| 2                    | 271                  |
| 4                    | 368                  |
| 8                    | 521                  |
| 16                   | **1112**             |

A caller that wants `user.name` should not pay for `user.email`. A group under a bulk
holder is built once per KEY, so its view is now one allocation over a prototype
shared by every key of that segment, with one accessor per field that builds its child
on first use and caches it as an own property. The same read is 251 ns at every width.

A schema-bounded group keeps the eager form: it is built once per store, so eager
children cost nothing per access afterwards, and moving that work into a shared
prototype measured 16% slower in `createStore` for a 400-leaf schema.

### What a mounted row costs

In the flat 20,000-row comparison workload, one mounted row adds **308 bytes**, and a
warm mount-and-unmount cycle for 200 rows costs 0.0155 ms, about 78 ns per row. Four
decisions keep that path small:

- **A flat leaf record doubles as its first observer.** It does not allocate a
  separate observer object, a child trie node, or a parent-map entry.
- **Overflow observers live in a Set only when needed.** An empty V8 Set costs about
  128 bytes, so the common one-observer address pays for none.
- **The disposer closes over one variable.** The node lives on the observer, and
  `live` doubles as the already-disposed flag, so V8 allocates no context object for
  the closure and every subscription's disposer is the same compiled function.
- **The observer holds no address.** Only the resource bookkeeping needs a path, and
  holding the ref kept a second descriptor alive per row while holding its path made
  `segments.join('/')` 13.9% of a mount-and-unmount cycle. A store with resources
  rebuilds the path from the node on the one path that needs it.

This is also the axis Segment cannot win outright. A store that keeps no per-key
bookkeeping has nothing to set up at mount, which is exactly why it has to re-run
every subscriber's selector on every write. The cost here buys the cost there.

## 3. The commit protocol

Writes never mutate the trie directly. They are staged into a write set and applied
in one pass.

1. `act(fn)` builds a write set. Reads inside see staged values (read-your-writes).
2. A **throw escapes with the trie untouched**, so the rollback is the absence of
   work rather than an undo log.
3. On commit the version counter advances once, the write set is applied, the
   notification set is computed once, and observers are woken once.
4. An `Object.is`-equal write contributes nothing and is not reported.

### Who gets woken

A write at an address wakes the observers registered **exactly there**, plus the
**deep** observers on each ancestor. Observers on unrelated subtrees are never
visited, so the cost is O(depth + woken).

A leaf is observed exactly; a **container is always observed deeply**. Observing a
branch or a segment means observing its contents, because a write goes through to
the bulk value in place and never replaces the container object.

### Naming a commit

`commit.source` answers "what caused this". It matters for devtools and for an audit
log; persistence and replication want the paths, not the name.

Three ways to get one, in order of what they cost:

|                                | how                             | cost            | works in production                   |
| ------------------------------ | ------------------------------- | --------------- | ------------------------------------- |
| declared `action()` / `task()` | its schema path is the source   | none            | **yes**, and it survives minification |
| explicit string                | `store.set(ref, v, 'mySource')` | none            | yes                                   |
| automatic                      | the calling function's name     | a stack capture | **no**, reports `'action'`            |

The automatic form is guarded twice: development only, and only while something is
subscribed to commits or watching a pattern. Capturing a stack is one of the most
expensive things V8 does and a write is the hottest path there is, so if nobody is
watching, nothing is derived. A generated id or symbol was considered and rejected:
neither is human-readable or stable across builds, and the schema path already is
both.

### Re-entrancy

A write made from inside a notification cannot be applied during that pass, or an
observer would see a state nobody committed. It joins the next commit instead. A
chain that never settles throws after 50 re-entries rather than spinning.

### Derivations

Push marks nothing; evaluation pulls. A cached value is trusted outright while the
global version has not moved, and only after a commit are its dependencies
re-read. A diamond therefore computes once and cannot observe a mix of two
generations.

An **observed** derivation is the only thing that has to be pushed, because its
readers subscribed to a value nobody wrote directly. At the end of each commit
every observed derivation is re-evaluated and its observers are woken only if the
value actually moved.

---

## 4. Resources

A resource's settled **value** travels the ordinary commit path, so observers,
ports, and `revision` treat it exactly like a cell. Only the transient part
(in flight, failed, stale) lives in a side map, which is why that map is bounded by
**activity** rather than by how much has ever been fetched:

An entry is retained while the resource is pending, failed, stale, observed, has a
live channel, or has a save in flight. Otherwise it is dropped at the end of the
commit that settled it, and only the value remains, in the bulk, where the caller
asked for it.

```ts
resource<T>(); //                        no arguments
resource<T, [q: string, page: number]>(); // arguments become path segments
```

The full implementation form:

```ts
{
  load: ({ get, args, key, path, signal }) => Promise<T> | T,
  save?: ({ value, key, path, signal }) => Promise<void> | void,
  live?: ({ key, path, emit, fail }) => (() => void) | void,
}
```

- `get` records dependencies. When one moves, the resource is marked **stale** and
  its observers are woken. Staleness is advice, not a reset: the value stays.
- `load` is superseded by a `refresh`, and a superseded response cannot publish
  over a newer one (each load carries a generation).
- `save` is the write-back. `store.save()` applies the value immediately and
  restores the previous one if `save` rejects, which makes an optimistic update
  literally a transaction that has not confirmed remotely yet.
- `live` is an outside push channel. `emit` publishes as a normal commit.

### Why arguments are path segments

The cache **is** the address. If a resource took arguments outside its address, two
callers passing different arguments would contend for one cache slot and nothing
would know when to refetch. Making the arguments part of the path gives per
argument-set caching, staleness, dehydration, and port addressing with no extra
machinery. The cost is that arguments must be primitives.

---

## 5. Server rendering

`dehydrate()` produces a **flat map** from path to value. That flatness is what
makes plain SSR, partial prerendering, and incremental regeneration one mechanism:
slicing by pattern and merging two payloads are both trivial on a flat map.

```ts
interface Payload {
	v: 1; //     format version, so a stored payload can be migrated
	at?: number; // production time, for a revalidation window
	data: Record<string, unknown>;
}
```

Derivations and actions never appear: one is recomputed on arrival, the other is
code. A resource **does** appear, because seeding its settled value is how a
server-rendered payload is adopted without the client refetching.

`hydrate()` applies a payload as **one commit**, so observers and ports see a single
transition rather than a storm. A path the current schema no longer describes is
skipped, so a deploy can roll forward instead of failing the render.

### The one-way door

The **path format** is the part that becomes hard to change once something persists
it. Three mitigations are in place from the start: every payload carries `v`,
persistence is an opt-in port rather than a default, and the segment separator is
reserved.

### Untrusted payloads

`hydrate(payload, { allow })` drops any path the allowlist does not cover and
reports what it dropped. Pass it for anything that came off the wire. Without it a
server response can write any address in the store, including local UI state the
server has no business touching.

---

## 6. Ports

```ts
interface PortContext {
	read(path: string): unknown;
	write(path: string, value: unknown): void;
	watch(pattern: string, cb: (path: string) => void): () => void;
	commits(cb: (commit: Commit) => void): () => void;
}
```

Watch patterns are indexed by their first literal segment, plus one bucket for
patterns starting with a wildcard. Without that index a commit would cost
O(patterns x writes); with it each write consults only the patterns that could
possibly match its root.

A port's callbacks cannot break the host: a throwing port is isolated, reported,
and **detached**, because leaving a broken port subscribed means every future
commit throws in the same place.

---

## 7. Deliberate design decisions, and what they cost

| Decision                                               | Why                                                                               | What it costs                                      |
| ------------------------------------------------------ | --------------------------------------------------------------------------------- | -------------------------------------------------- |
| write-through, not copy-on-write                       | pruning is only sound this way                                                    | no structural sharing, no free immutable snapshots |
| implementations in `.with()`                           | a callback inside the shape literal collapses `S` to `never`                      | the definition is two calls instead of one         |
| arguments as path segments                             | the cache is the address                                                          | arguments must be primitives                       |
| ref identity not interned through a dynamic segment    | interning an unbounded key space is the `atomFamily` leak                         | compare `ref.path`, never `===`                    |
| a group read returns the record as stored              | synthesizing defaults would allocate per read and still not fill a partial record | a group read can be `undefined`                    |
| reserved keys (`path`, `at`, `replaceAll`, `snapshot`) | the accessor tree occupies them on every node                                     | those four names are unavailable in a shape        |
| a bare function in a shape is rejected                 | it would become a cell holding a function and vanish from a payload               | `cell(fn)` is required to mean it                  |

## 8. Errors are loud on purpose

Every one of these is a thrown error with the offending path named, not a silent
`undefined`:

- a path the schema does not describe, including a typo in a path string
- writing a derivation, a resource, an action, or a task
- writing a group with `set` instead of `patch`, or a segment with `set` instead of
  `replaceAll`
- reading a resource through the plain value hook
- a derivation that depends on itself
- `.with()` leaving a declared slot unimplemented, listing **all** of them at once
- a non-primitive resource argument, or the wrong argument count
- a bare function where a marker belongs, naming `action()` and `task()`
