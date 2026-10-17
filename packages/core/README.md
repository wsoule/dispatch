# @dispatch-foo/core

The shared model behind [Dispatch](https://dispatch.foo), under the MIT license:
the task, run, comment, memory and finding types, their statuses and kinds, the
markdown and SQLite task stores, id generation, write-conflict checks, git and
config helpers. Dispatch's daemon, CLI, MCP server and protocol engine all build
on it, so anything that reads or writes a Dispatch project the way Dispatch does
can too.

```bash
npm install @dispatch-foo/core
```

It runs on Node 22.13 or later, and on Bun. Its entry points:

- `@dispatch-foo/core`: everything, including the stores and the `node:*`
  helpers;
- `@dispatch-foo/core/browser`: the types, statuses, kinds and other pure
  helpers alone, with no `node:*` import, for code that runs in a browser;
- `@dispatch-foo/core/graph`: the dependency graph and scheduling order of a
  task list, also browser-safe;
- `@dispatch-foo/core/carto`: the bridge to
  [Carto](https://github.com/theanshsonkar/carto), which maps a repo's imports
  for the dependency graph.

Most people want
[`@dispatch-foo/mcp`](https://www.npmjs.com/package/@dispatch-foo/mcp), which
puts a Dispatch board in front of any coding agent, rather than this library.

## License

MIT. The Dispatch app and daemon are source-available under FSL-1.1-ALv2; see
[LICENSING.md](https://github.com/wsoule/dispatch/blob/main/LICENSING.md).
