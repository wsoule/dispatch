# Dispatch (working title)

Open-source, git-native task tracking and AI-agent orchestration. Tasks are
markdown files in your repo (`.dispatch/tasks/*.md`) — synced by git, readable
by humans and agents alike.

**Status:** Phase 1 (tracker core + CLI). Roadmap: `docs/superpowers/plans/2026-07-13-dispatch-roadmap.md`.

## Quickstart

    pnpm install && pnpm -r build
    node packages/cli/dist/cli.js init
    node packages/cli/dist/cli.js task create "My first task" --priority high
    node packages/cli/dist/cli.js task list
    node packages/cli/dist/cli.js task next
    node packages/cli/dist/cli.js doctor

Every read command accepts `--json` for agent/script consumption.

## Design docs

- Spec: `docs/superpowers/specs/2026-07-13-agent-orchestration-platform-design.md`
- Research: `docs/research/2026-07-13-landscape-research.md`

## License

Apache-2.0
