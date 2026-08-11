/* ============================================================================
   Map/WeakMap "upsert" polyfill.

   The vendored pdf.js build calls Map.prototype.getOrInsertComputed (TC39's
   upsert proposal, https://github.com/tc39/proposal-upsert) in both the main
   bundle and the worker. No shipping browser implements it yet — Chromium 141
   does not — so without this shim getDocument() throws
   "getOrInsertComputed is not a function" on every PDF.

   Imported for its side effect, and imported *before* pdf.js in both scopes:
   static imports are evaluated in source order, so the methods exist by the
   time pdf.js runs. Safe to delete once browsers ship the proposal.
   ========================================================================== */

for (const proto of [Map.prototype, WeakMap.prototype]) {
  if (typeof proto.getOrInsert !== "function") {
    Object.defineProperty(proto, "getOrInsert", {
      value: function getOrInsert(key, value) {
        if (!this.has(key)) this.set(key, value);
        return this.get(key);
      },
      writable: true, configurable: true, enumerable: false,
    });
  }
  if (typeof proto.getOrInsertComputed !== "function") {
    Object.defineProperty(proto, "getOrInsertComputed", {
      value: function getOrInsertComputed(key, callback) {
        if (!this.has(key)) this.set(key, callback(key));
        return this.get(key);
      },
      writable: true, configurable: true, enumerable: false,
    });
  }
}
