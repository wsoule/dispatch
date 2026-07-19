---
name: performance
description:
  Use when changing loops, collection processing, invalidation logic, path
  scanning, virtualized rendering calculations, cache updates, or any code where
  repeated scans or boolean control flow affect performance or correctness.
---

# Performance

Avoid nested loops and O(n^2) operations unless there is a clear reason.

- Calculate expensive values once before a loop, not inside it.
- Prefer precomputed maps, sets, indexes, or a single backward scan over nested
  repeated scans.
- If you need to know whether meaningful elements remain, compute that boundary
  once before the main loop.

Example of the preferred pattern:

```typescript
let lastMeaningfulIndex = items.length - 1;
for (let i = items.length - 1; i >= 0; i--) {
  if (items[i].someCondition) {
    lastMeaningfulIndex = i;
    break;
  }
}

for (let i = 0; i <= lastMeaningfulIndex; i++) {
  const isLast = i === lastMeaningfulIndex;
  // ...
}
```

After changing boolean logic or invalidation paths, simplify the final control
flow before calling the work done. If code is already inside `if (foo)`, do not
keep `|| foo` in assignments inside that block.

When performance-sensitive code is already covered by benchmarks or profiling
scripts, run the smallest relevant one before and after the change. If no such
script exists, prefer a focused regression test for the behavior and call out
the remaining performance risk.
