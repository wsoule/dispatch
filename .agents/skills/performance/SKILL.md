---
name: performance
description:
  Use when changing loops, collection processing, invalidation logic, path
  scanning, virtualized rendering calculations, cache updates, or any code where
  repeated scans or boolean control flow affect performance or correctness.
---

# Performance

Precompute lookups (maps, sets, indexes) once instead of rescanning inside a
loop, and once boolean or invalidation logic works, simplify it so redundant
conditions don't survive.

This repo has no benchmark or profiling suite. When a change touches a path that
scales with project size, cover the behavior with a focused regression test and
state the remaining performance risk in your summary.
