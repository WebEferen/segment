// The adapter runs on the SAME octane runtime instance the fixtures compile
// against, so octane's own harness is reused verbatim rather than standing up a
// parallel one.
export { mount, act, flushEffects, nextPaint, createLog } from '../../../octane/tests/_helpers.js';
