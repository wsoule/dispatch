// Shims for the runtime APIs our dependency tree calls but WebKit older than
// Safari 15.4/16.4 does not have. `build.target` lowers *syntax*; it never adds
// missing APIs, so these have to be installed by hand.
//
// Injected as the literal first bytes of every entry chunk (and of the worker
// bundle, which has its own global scope) via the banner in vite.config.ts —
// not imported as a module, because an import only orders itself against other
// imports, and dependency code runs at module scope.
//
// Plain JS on purpose: this file is read verbatim off disk at config time and
// prepended to the build output, so it must be valid ES5-parseable script text.
// Each shim is feature-detected, so on a current WebKit this whole file is a
// handful of falsy checks. Every property is defined non-enumerable, or a
// `for...in` over an array would start yielding the shim names.
//
// The set is deliberately narrow: only what the built bundle actually calls,
// re-derived from the artifact rather than from source. `structuredClone` is
// absent on purpose — the one caller already feature-detects it and carries its
// own fallback.
(function () {
  function define(target, name, value) {
    if (target[name]) return;
    Object.defineProperty(target, name, {
      value: value,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }

  // Array.prototype.at / String.prototype.at — Safari 15.4.
  function at(index) {
    var length = this.length;
    var i = Math.trunc(index) || 0;
    if (i < 0) i += length;
    if (i < 0 || i >= length) return undefined;
    return this[i];
  }
  define(Array.prototype, 'at', at);
  define(String.prototype, 'at', at);

  // Array.prototype.findLast / findLastIndex — Safari 15.4. findLastIndex is
  // included because the two share this loop and callers routinely pair them.
  function findLastIndex(predicate, thisArg) {
    if (typeof predicate !== 'function') {
      throw new TypeError('predicate must be a function');
    }
    for (var i = this.length - 1; i >= 0; i--) {
      if (predicate.call(thisArg, this[i], i, this)) return i;
    }
    return -1;
  }
  define(Array.prototype, 'findLastIndex', findLastIndex);
  define(Array.prototype, 'findLast', function findLast(predicate, thisArg) {
    var index = findLastIndex.call(this, predicate, thisArg);
    return index === -1 ? undefined : this[index];
  });

  // Object.hasOwn — Safari 15.4.
  define(Object, 'hasOwn', function hasOwn(target, key) {
    return Object.prototype.hasOwnProperty.call(target, key);
  });

  // Array.prototype.toSorted — Safari 16.4. Sorts a copy, so unlike `sort` the
  // receiver is left alone.
  define(Array.prototype, 'toSorted', function toSorted(compare) {
    if (compare !== undefined && typeof compare !== 'function') {
      throw new TypeError('comparator must be a function');
    }
    return Array.prototype.slice.call(this).sort(compare);
  });
})();
