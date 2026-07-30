# Segment against the other stores

Compares `@webeferen/segment` with four popular stores pinned as development
dependencies: jotai, zustand, valtio, and redux. All five are driven the way their
own documentation says to subscribe to one field, with no extra machinery the
library does not ship.

```bash
pnpm benchmark       # full comparison
pnpm benchmark:hot   # Segment's own hot paths

# A/B a candidate change without editing the package:
cp -R src /tmp/variant/src                    # edit /tmp/variant/src, then
node benchmarks/segment-state/build.mjs --src /tmp/variant/src --out /tmp/variant/core.js
node benchmarks/segment-state/ab.mjs /tmp/variant/core.js
```

**Do not judge a change by comparing a fresh run against a number written down earlier.**
Run against a variant built from IDENTICAL source, a single pass per build reported six
cases faster and six slower, with deltas up to 42%. `ab.mjs` exists for this: it measures
both builds per case with the order alternating, repeats each five times, and prints the
noise floor it observed so a delta smaller than that floor is reported as unresolved
rather than as a win.

The comparison libraries are pinned development dependencies of this repository
and resolved through its root `package.json`, so every run uses the versions in
the lockfile.

## What is measured, and why in this order

**A and B are exact counts.** They do not move with the machine, the Node version,
or the thermal state, and they are what the designs actually differ in. Treat them
as the result.

**C, D, and E are wall time and heap.** They are real but secondary, and each is
measured in a way the section below explains, because the obvious way to measure
each of them is wrong.

### A. One targeted write among 1,000 independent subscribers

A thousand subscribers each care about one distinct key. Write ONE of them. Count
the subscriber callbacks that fire, and the selector evaluations that run to decide
whether to fire.

### B. Per-key bookkeeping after observer churn

A scrolling list: 200 rounds, each detaching a 200-observer window and attaching a
disjoint one. 40,200 subscriptions are made over 19,800 distinct keys (the window
starts cycle, so keys repeat); 200 are live at the end. Count what the library
still holds.

### E. What the first paint pays

Subscribe one observer per visible row and read each row once, for a 200-row window
over a 20,000-record dataset. Reported three ways, because they answer different
questions: the **cold** mount is the first one in the process, which is what a page
load pays; **unmount** is the other half of a route change; and the warm
**mount+unmount cycle** is what scrolling costs once the code is hot.

## Results

Recorded on one machine. A and B are exact and will reproduce anywhere.

### A. One targeted write, 1,000 subscribers

| library | callbacks woken | selector runs |
| ------- | --------------- | ------------- |
| segment | 1               | 0             |
| jotai   | 1               | 0             |
| valtio  | 1               | 0             |
| zustand | 1               | **1,000**     |
| redux   | 1               | **1,000**     |

Segment, jotai, and valtio are addressed, so a write reaches only what changed.
Zustand and redux notify every listener on every write, so each subscriber runs its
own selector to find out whether it cared: that is O(subscribers) of work to
deliver one notification.

Valtio is measured with `subscribe(proxy, cb, true)`. Without the third argument it
batches to a microtask and this table would read 0 callbacks, which would credit it
for being asynchronous rather than for doing less work.

### B. After 200 rounds of churn, 200 observers live

| library | baseline | one window | after churn |                                       |
| ------- | -------- | ---------- | ----------- | ------------------------------------- |
| segment | 2        | 202        | **202**     | released what it stopped observing    |
| jotai   | 0        | 200        | **19,800**  | retains every atom ever created (x99) |
| zustand | 0        | 0          | 0           | keeps no per-key state                |
| valtio  | 0        | 0          | 0           | keeps no per-key state                |
| redux   | 0        | 0          | 0           | keeps no per-key state                |

This is the one axis where the designs separate cleanly, and it is a **trade-off,
not a ranking**:

- The snapshot libraries keep no per-key bookkeeping at all, which is why they have
  nothing to leak. They pay for it in A instead.
- Jotai is atomic like Segment, so it wins A. But an atom family is a memo table
  with no eviction: 19,800 distinct keys observed leaves 19,800 atoms alive for
  200 live subscribers. Calling `family.remove(key)` by hand fixes it, and
  forgetting to is the accident.
- Segment is the only one good at **both**, because materialization is reversible:
  a node is pruned when its last observer detaches.

### C, D, E. Write time, memory, and mount cost

20,000 records loaded; 2,000 targeted writes; a 200-row window.

| library     | 2,000 writes | memory the layer adds | cold mount | unmount      | warm cycle | per mounted row |
| ----------- | ------------ | --------------------- | ---------- | ------------ | ---------- | --------------- |
| **segment** | **0.3 ms**   | 0.77 MB               | 0.084 ms   | **0.032 ms** | 0.0155 ms  | 308 B           |
| valtio      | 0.5 ms       | 25.92 MB              | 0.192 ms   | 0.043 ms     | 0.0535 ms  | 392 B           |
| jotai       | 2.1 ms       | 4.84 MB               | 1.013 ms   | 0.131 ms     | 0.1458 ms  | 1234 B          |
| redux       | 6,687 ms     | 0.76 MB               | 0.103 ms   | 0.048 ms     | 0.0137 ms  | 229 B           |
| zustand     | 7,637 ms     | 0.76 MB               | 0.080 ms   | 0.033 ms     | 0.0144 ms  | 198 B           |

The cold-mount and unmount columns are the headline: across interleaved runs
segment and zustand are within each other's noise on both, with redux behind on
each. An addressed
store used to pay 0.956 ms on cold mount, 14x the no-bookkeeping stores; the
whole gap turned out to be lazy compilation, fixture garbage, a luck-dependent
scavenge, and a per-key trie node that a cell-shaped list never needed, not the
addressing itself.

The segment adapter subscribes through `rows.observe(key, cb)`, the keyed form the
view ships for exactly this pattern (`store.observe(rows.at(key), cb)` is the
equivalent ref-building spelling), and reads through `snapshot()[key]`, which is
the same read shape the zustand, redux, and valtio adapters use.

Treat differences under about 2x as noise; the four-orders-of-magnitude gap in the
write column is not noise.

Read these with the caveats:

- **Zustand and redux are slow to write here because of the fixture, not only the
  library.** An immutable snapshot copies the state object on every write, so a
  single flat object of 20,000 keys makes each write O(keys). A real application
  splits state across slices and never sees this. The shape was chosen to match the
  others, not to embarrass these two, and the honest reading is that the
  immutable-snapshot model does not want one large flat map.
- **Memory excludes the raw data**, which all five hold identically, and excludes the
  library's own compiled code. What is left is what the state layer adds: for zustand
  and redux that is essentially the dataset's own hash table, and Segment matches it.
- **Valtio's 25.92 MB is the cost of its addressing model, not a fixture accident.**
  Valtio can only subscribe to an OBJECT, so per-row subscription requires a record
  per key, and a record per key means a proxy per key. An earlier version of this
  file dismissed that number as a fixture artifact and measured valtio on flat
  strings instead, but the flat fixture cannot do per-row subscription at all (see
  flaw 9), so the proxies are the price of the feature the E axis measures.
- **The mount column is the mirror image of column A, and that is the whole trade.**
  Zustand and redux mount fastest precisely because subscribing costs them nothing
  per key: they keep no per-key bookkeeping, so there is nothing to set up, and they
  pay for it on every write instead. Segment sets up an address per row, which is
  what makes a write reach only what changed. No implementation of column A can also
  win column E.
- **The first cold mount used to be dominated by JIT warm-up**, not by steady-state
  cost: per-row timing showed row 0 at ~130 µs (lazy parsing the whole subscribe
  path) and rows 1 to 9 at 5 to 8 µs (first-call inline caches) before settling
  under 1 µs. V8 shares bytecode across every closure made from one function
  literal, so `createStore` now exercises a throwaway store once per process,
  covering the subscribe, read, unsubscribe, notify, and transaction paths, and
  the first mount and first interaction no longer pay any of it. Together with
  the keyed `rows.observe(key, cb)` entry point, which skips the per-row
  descriptor that a third of the mount went to, and `snapshot()` serving reads
  from the holder's own node, that moved Segment's cold mount from the 0.956 ms
  this file once reported to the ~0.08 ms above, and the first teardown from
  ~0.10 ms to ~0.036 ms, for ~0.6 ms paid once inside the first `createStore`,
  at app boot, where it displaces nothing.

### Nine measurement flaws found and fixed while writing this

Every one of them had the comparison reading in a direction the code had not earned,
and all six are worth stating rather than quietly correcting.

1. **Segment was holding more data than the others.** Its adapter stored a record per
   key while zustand and redux stored a bare string, so its memory number was
   inflated. Every adapter now holds exactly one string per key. This is also why an
   earlier version of this file reported valtio at 26.9 MB: with a record per key
   valtio allocates a proxy per record. That number was a fixture artifact, not a
   property of valtio.
2. **Jotai was not holding the dataset at all.** An atom exists only once something
   asks for it, so with 200 observers its footprint measured 200 values while the
   other four measured 20,000. Its adapter now creates every atom before the
   measurement, which is what "the dataset is loaded" means for an atom-per-key
   design.
3. **Memory was measured in one process, which does not work.** Five `heapUsed`
   deltas in one process reported 1.9 MB for the first library and 0.00 to 0.01 MB
   for the rest, for identical work: V8 grows the heap once and later allocations fit
   in space it already committed. The store under test demonstrably held its data
   (202 nodes, 200 live observers, correct reads) while the measurement said it held
   nothing. Every memory and mount figure now comes from a **fresh process per
   library**, in `isolated.mjs`.
4. **The memory measurement included things it should not.** The library was imported
   AFTER the baseline was taken, so its compiled code counted as "heap held by the
   state layer" and the library that ships more code lost for shipping it. The raw
   20,000 values counted too, adding the same constant to everyone and hiding the
   thing being compared. And the footprint was taken after the timing passes had each
   pushed another window of handles, so it reported 1,000 live subscriptions while
   calling it a 200-row window: 2.19 MB where one window holds 1.46 MB.
5. **Per-row memory over 200 rows was not reproducible**, swinging between 545 and
   2201 bytes for identical code, because whatever a `heapUsed` delta picks up that is
   not the window divides by only 200. Measured over 5,000 rows the same figure
   repeats to the byte.
6. **Mount cost was measured on a hot machine.** Interleaving the forked measurement
   with the in-process axes meant each library's mount was timed just after the
   previous library's seven-second write pass: 2.0 ms against the 1.0 ms the same fork
   reports on a quiet machine. All forked measurements now run first.
7. **Cold mount was billing one library for the fixture's garbage.** The adapter
   builds the 20,000-record dataset moments before the window opens, so several
   megabytes of live data sit in V8's nursery when timing starts, and the next
   scavenge evacuates them at ~0.5 ms. Whichever library's mount allocated enough
   to trigger that scavenge inside the window ate the whole bill (the per-key
   libraries; Segment's reported 0.956 ms was ~0.55 ms of it), while the others
   deferred it to just after their window closed, purely as a step function of
   window size. Forced `global.gc()` before the window would be its own
   distortion: repeated full GCs age and flush lazily-compiled bytecode, which
   taxed the small-mount libraries 15 to 100 µs of recompilation. The fix is a
   plain transient-allocation loop after setup: natural scavenges promote the
   dataset out of the nursery with no forced-GC side effects, and they also evict
   it from the CPU cache, which is the realistic state, because a real mount does
   not run within microseconds of parsing the payload. The L2-warm dataset had
   been flattering the read half of the no-bookkeeping libraries by ~20 µs. One
   refinement came later: the filler leaves the semispace at whatever fill level
   its last iteration reached, so whether the window's own allocations crossed the
   scavenge threshold INSIDE the timed region was luck, worth ~30 µs of
   run-to-run swing. A single `global.gc({ type: 'minor' })` after the filler
   pins the nursery phase for everyone; a minor collection has none of the
   code-flushing side effects that rule out the full-GC settle.
8. **Memory was measured in a process the timing pass had made hot.** Once a
   timing loop has run a library's function literals hot, V8 allocates feedback
   vectors eagerly for every closure the NEXT store creates, and the store built
   for the memory measurement was carrying that as if it were state: ~200 KB for
   the library that defines the most closures, on identical data. Timing and
   memory now run in separate processes (`isolated.mjs <library> timing|memory`),
   and the memory process builds one throwaway store first so each library's
   one-time compile residue sits outside the measurement, the same way the import
   already does.
9. **Valtio's results row was quietly built from two incompatible fixtures.** The
   in-process axes measured it on a record per key with per-record subscriptions,
   the way its documentation subscribes to one row; the forked memory and mount
   axes measured it on flat strings, where per-row subscription is impossible, so
   its "mount" subscribed every row to the ROOT proxy and its memory number
   omitted the proxies its addressing needs. One library, one row, two different
   designs. Both forks now use the record fixture, which is also a correction of
   an earlier correction: flaw 1 called valtio's record-fixture memory "a fixture
   artifact, not a property of valtio", and that judgment was wrong. The proxies
   ARE the property, because they are what per-row subscription costs in valtio's
   model; the artifact was the flat fixture that hid them.

The sibling `hot.mjs` needed three corrections of its own, all of the same family:

- Its calibration loop built a key string per iteration, so every case was compared
  against a baseline doing strictly more work than the case. That is where the claim
  "a read is cheaper than a `Map.get`" came from; with an allocation-free baseline a
  held-ref read is **1.2x** a `Map.get`, not 0.3x.
- Allocation was read from a byte delta across 200,000 operations, which measures
  whichever collection happened to land inside the window. The same `store.set`
  reported 4 B/op or 56 B/op depending only on what had run before it. Allocation now
  gets its own process and runs first in it, and below roughly 100 B/op the column is
  an indicator rather than a result.
- Measuring every case in one process made the results depend on their ORDER in the
  file, because each case leaves a 20,000-key store behind: a case near the bottom
  read 2x slower than the same code measured first. Each case now runs in its own
  process, and reports its cost as a multiple of one `Map.get` over the same keys, so
  a number from a busy machine stays comparable.

This suite has earned its keep several times over. It caught a 12x write regression
the day it was written: automatic commit naming read `process.env.NODE_ENV` per write,
and `process.env` is not a plain object in Node, so every access reads the real
environment. Nothing in the test suite would have noticed. It is what turned the write
column from 6.1 ms into 0.4 ms. And it is what rejected three optimizations that
looked obviously right: a bounded descriptor cache (no measurable gain, and the
unbounded variant made a 20,000-key scan 2x slower), an array write set (the Map wins
at one write and only loses from three), and interning a descriptor at subscribe time
(+250 bytes per row, because the observer then held a second one). Chasing the cold
mount produced its two largest findings: flaw 7 above (0.55 ms of the reported
0.956 ms was the fixture's own garbage) and the `createStore` warm-up (most of the
rest was V8 lazily compiling the subscribe path on the first row). It also rejected
`segments.concat(key)` in `.at()` in favor of the spread it already used (90 ns
against 137 ns for the same call), and a per-store warm-up of each segment view's
own closures, which bought 6 µs of cold mount for 1.7 µs on every warm cycle and
forty lines: feedback vectors are per store, but the price of warming them is paid
by the steady state. The last structural win came from asking what a mounted row
of a cell-shaped list actually needs: a 12-field trie node carried mostly nulls
for it, so such holders now keep a compact leaf record per observed key on their
own pinned node (`SchemaNode.flat`). That record doubles as the first observer;
only additional observers allocate a Set. In paired fresh-process measurements
the combined change cut cold mount by 5.3%, the warm cycle by 2.7%, and memory per
row by 9.4%, while isolated teardown moved 1.9% in the other direction. The full
lifecycle still wins, and `revision()` exactness is pinned by a test that fails if
the record's stamp is dropped.

## The tally

Ranked per axis, out of five:

| library     | A: work per write | B: releases what it drops | C: write time | D: memory      | E: mount       | worst axis |
| ----------- | ----------------- | ------------------------- | ------------- | -------------- | -------------- | ---------- |
| **segment** | **1st** (tied)    | **1st**                   | **1st**       | **1st** (tied) | **2nd** (tied) | **2nd**    |
| valtio      | **1st** (tied)    | n/a                       | 2nd           | 5th            | 4th            | 5th        |
| redux       | 4th (tied)        | n/a                       | 4th           | **1st** (tied) | **2nd** (tied) | 4th        |
| zustand     | 4th (tied)        | n/a                       | 5th           | **1st** (tied) | **1st**        | 5th        |
| jotai       | **1st** (tied)    | 5th                       | 3rd           | 4th            | 5th            | 5th        |

On D the three libraries at 0.76 to 0.77 MB hold the dataset's own hash table plus
noise, a tie under this file's own under-2x rule; jotai's 4.84 MB and valtio's
25.92 MB separate.

Segment is first or tied first on four of the five axes and tied SECOND on the
fifth, so its worst axis is a second place; every other library has a fourth or
fifth somewhere. On E it splits the runner-up spot with redux (segment takes cold
mount 0.084 vs 0.103 and unmount 0.032 vs 0.048; redux takes warm cycle 0.0137 vs
0.0155 and bytes per row 229 vs 308), beats valtio and jotai on every column, and
on cold mount and unmount it sits inside zustand's noise band. What remains
unwon is the steady-state churn cost of the design: setting up an address per row
is what makes a write reach only what changed (A) and what lets the bookkeeping
be released again (B). A store that keeps no per-key state has nothing to set up
or tear down per row, so it cycles faster and then re-runs every subscriber's
selector on every write. That trade cannot be won on both sides at once, and this
table is the shape of it.

Two things this deliberately does not measure, because they have no counterpart in
the other four and a benchmark against nothing proves nothing: reading a whole
subtree through one integer compare, and adopting a server payload without
refetching.
