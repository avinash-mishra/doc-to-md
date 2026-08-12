/* ============================================================================
   Compatibility polyfills for the vendored pdf.js build.

   The modern pdf.js bundle assumes a set of very recent JS features, and a
   browser missing any one of them fails at a load- or convert-time call site
   deep inside minified code. What each engine actually lacks (as of writing):

     Chromium (incl. 141)   Map/WeakMap getOrInsert / getOrInsertComputed
     Safari  ≤ current      ReadableStream async iteration — pdf.js does
                            `for await (const chunk of stream)` in
                            getTextContent, so without this every text
                            extraction dies with "undefined is not a function"
     Safari  < 18.4         the Iterator global (pdf.js touches
                            Iterator.prototype at startup to add its own
                            .join helper) and the iterator-helper methods
     Safari  < 18.2         Promise.try (used on every main<->worker
                            message), Uint8Array to/fromBase64 + toHex
                            (document fingerprints, at load), Math.sumPrecise
                            (font/width math in the worker)
     Safari  < 17.4         Promise.withResolvers (worker messaging)

   Everything else new that pdf.js uses (Float16Array, ImageDecoder) it
   feature-detects itself.

   Imported for its side effects, and imported *before* pdf.js in both the
   page (pdf-loader.js) and the worker (pdf-worker-shim.mjs) — a module
   worker has its own global scope, so the page's copy does not reach it.
   Static imports evaluate in source order, so the methods exist by the time
   pdf.js runs. Globals only, no `window`/`document`: this file must run in
   both scopes. Each shim installs only when the native is missing, so
   engines that catch up simply stop using it.
   ========================================================================== */

const define = (obj, name, value) =>
  Object.defineProperty(obj, name, { value, writable: true, configurable: true, enumerable: false });

/* ── Map/WeakMap upsert (TC39 proposal-upsert; no engine ships it yet) ──── */

for (const proto of [Map.prototype, WeakMap.prototype]) {
  if (typeof proto.getOrInsert !== "function") {
    define(proto, "getOrInsert", function getOrInsert(key, value) {
      if (!this.has(key)) this.set(key, value);
      return this.get(key);
    });
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    define(proto, "getOrInsertComputed", function getOrInsertComputed(key, callback) {
      if (!this.has(key)) this.set(key, callback(key));
      return this.get(key);
    });
  }
}

/* ── ReadableStream async iteration (Safari) ────────────────────────────── */

if (typeof ReadableStream !== "undefined" &&
    typeof ReadableStream.prototype[Symbol.asyncIterator] !== "function") {
  const values = function values({ preventCancel = false } = {}) {
    const reader = this.getReader();
    return {
      async next() {
        try {
          const result = await reader.read();
          if (result.done) reader.releaseLock();
          return result;
        } catch (err) {
          reader.releaseLock();
          throw err;
        }
      },
      async return(value) {
        if (preventCancel) {
          reader.releaseLock();
        } else {
          const cancel = reader.cancel(value);
          reader.releaseLock();
          await cancel;
        }
        return { done: true, value };
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  if (typeof ReadableStream.prototype.values !== "function") {
    define(ReadableStream.prototype, "values", values);
  }
  define(ReadableStream.prototype, Symbol.asyncIterator, values);
}

/* ── Promise statics ────────────────────────────────────────────────────── */

if (typeof Promise.withResolvers !== "function") {
  define(Promise, "withResolvers", function withResolvers() {
    let resolve, reject;
    const promise = new this((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  });
}

if (typeof Promise.try !== "function") {
  // new Promise(...) turns a synchronous throw in fn into a rejection,
  // which is exactly Promise.try's contract.
  define(Promise, "try", function (fn, ...args) {
    return new this((resolve) => resolve(fn(...args)));
  });
}

/* ── Uint8Array base64/hex codecs ───────────────────────────────────────── */

if (typeof Uint8Array.prototype.toBase64 !== "function") {
  define(Uint8Array.prototype, "toBase64", function toBase64() {
    let binary = "";
    const CHUNK = 0x8000;   // fromCharCode.apply on the whole array can blow the stack
    for (let i = 0; i < this.length; i += CHUNK) {
      binary += String.fromCharCode.apply(null, this.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  });
}

if (typeof Uint8Array.fromBase64 !== "function") {
  define(Uint8Array, "fromBase64", function fromBase64(string) {
    const binary = atob(string);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  });
}

if (typeof Uint8Array.prototype.toHex !== "function") {
  define(Uint8Array.prototype, "toHex", function toHex() {
    let hex = "";
    for (let i = 0; i < this.length; i++) hex += this[i].toString(16).padStart(2, "0");
    return hex;
  });
}

/* ── Math.sumPrecise ────────────────────────────────────────────────────── */

if (typeof Math.sumPrecise !== "function") {
  // Neumaier compensated summation — not the spec's perfectly rounded
  // result, but far past sufficient for the font metrics and layout math
  // pdf.js feeds it.
  define(Math, "sumPrecise", function sumPrecise(values) {
    let sum = 0, compensation = 0;
    for (const raw of values) {
      const v = Number(raw);
      const t = sum + v;
      compensation += Math.abs(sum) >= Math.abs(v) ? (sum - t) + v : (v - t) + sum;
      sum = t;
    }
    return sum + compensation;
  });
}

/* ── Iterator global + helper methods ───────────────────────────────────── */

// The shared prototype every built-in iterator inherits from — the same
// object the real Iterator.prototype is.
const IteratorProto = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]()));

if (typeof globalThis.Iterator === "undefined") {
  // Enough of the global for `Iterator.prototype.xyz` reads and assignments
  // (pdf.js installs its own .join through exactly that path) to land on
  // the real shared prototype.
  define(globalThis, "Iterator", { prototype: IteratorProto });
}

{
  // Generator objects inherit from IteratorProto, so helpers returning
  // generators stay chainable, exactly like the native ones.
  const helpers = {
    map: function* map(fn) { let i = 0; for (const v of this) yield fn(v, i++); },
    filter: function* filter(fn) { let i = 0; for (const v of this) if (fn(v, i++)) yield v; },
    take: function* take(n) { let left = n; for (const v of this) { if (left-- <= 0) return; yield v; } },
    drop: function* drop(n) { let left = n; for (const v of this) { if (left-- > 0) continue; yield v; } },
    flatMap: function* flatMap(fn) { let i = 0; for (const v of this) yield* fn(v, i++); },
    reduce: function reduce(fn, ...initial) {
      let acc = initial[0], has = initial.length > 0, i = 0;
      for (const v of this) { acc = has ? fn(acc, v, i) : (has = true, v); i++; }
      if (!has) throw new TypeError("Reduce of empty iterator with no initial value");
      return acc;
    },
    toArray: function toArray() { return [...this]; },
    forEach: function forEach(fn) { let i = 0; for (const v of this) fn(v, i++); },
    some: function some(fn) { let i = 0; for (const v of this) if (fn(v, i++)) return true; return false; },
    every: function every(fn) { let i = 0; for (const v of this) if (!fn(v, i++)) return false; return true; },
    find: function find(fn) { let i = 0; for (const v of this) if (fn(v, i++)) return v; },
  };
  for (const [name, fn] of Object.entries(helpers)) {
    if (typeof IteratorProto[name] !== "function") define(IteratorProto, name, fn);
  }
}
