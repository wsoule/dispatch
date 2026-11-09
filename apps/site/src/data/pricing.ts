// The pricing page's licensing questions; the page renders them and its FAQPage
// structured data restates them, so the two never drift.
export const faq: [string, string][] = [
  [
    'Is Dispatch open source?',
    'It is open core. The pieces other tools integrate with (the core library, CLI, API client and MCP server) are MIT. The messaging protocol spec is Apache-2.0. The desktop app and daemon are source-available under FSL-1.1, and every release becomes Apache-2.0 two years after it ships. The team features are under the Elastic License 2.0.',
  ],
  [
    'Can I use it at work for free?',
    'Yes. Up to three people, every feature, commercial use included.',
  ],
  [
    'What does the FSL allow?',
    'Reading, building, modifying, self-hosting and redistributing the code for any purpose except shipping a competing product or service.',
  ],
  [
    'Does the web planner count seats?',
    'No. Planning a Linear workspace at app.dispatch.foo is free for everyone in it, with no seat count. Seats cover agents and team features.',
  ],
  [
    'What happens past three people?',
    'A fourth invite is refused and says why. On a synced board, anyone past the seats keeps working locally and catches up when seats are added. Nothing is deleted, and an expired key falls back to the free plan instead of locking anyone out.',
  ],
  [
    'Does my code go anywhere?',
    'No. Runs use your machine, your checkout and your own agent and API key. The license key is checked on your machine with no phone-home. A team can sync over its own git branch instead of the relay.',
  ],
  [
    'What if Dispatch goes away?',
    'Your tasks are markdown in your repo, or a git receipt log you can copy into any repo to get a working board back. And each release turns Apache-2.0 two years on.',
  ],
];
