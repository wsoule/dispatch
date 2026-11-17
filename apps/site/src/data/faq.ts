// Every question /faq answers, grouped. The page renders them and its FAQPage
// structured data restates them, so search and AI answers quote the same words.
export interface FaqSection {
  // Anchor on /faq, so one group can be linked on its own.
  id: string;
  title: string;
  items: [string, string][];
}

export const pricingFaq: [string, string][] = [
  [
    'How much does Dispatch cost?',
    'Solo is free: your machine, your agents and every local feature. Team is $10 per seat per month on the hosted team server, billed through Stripe.',
  ],
  [
    'Is there a free tier for teams?',
    'No. Every seat on Team is paid. Working alone stays free for as long as you like.',
  ],
  [
    'Do I pay for my agents through Dispatch?',
    'No. Claude Code and Codex run with your own sign-in or API key, so their usage is billed by their makers, as it is today.',
  ],
  [
    'Is Dispatch open source?',
    'Partly. The core (the background process, its CLI and its protocol) is Apache-2.0. The desktop app is FSL-1.1-ALv2: source-available, and each release becomes Apache-2.0 two years after it ships. The team server is under the Elastic License 2.0.',
  ],
  [
    'What does the FSL allow?',
    'Reading, building, changing and running the app for any purpose except offering a competing product or service. Two years after each release, that release is Apache-2.0 with no such limit.',
  ],
];

export const faqSections: FaqSection[] = [
  {
    id: 'basics',
    title: 'The basics',
    items: [
      [
        'What is Dispatch?',
        'A board, docs and an Overseer for your coding agents, on your Mac. In the Dispatch app you talk to your own Overseer: it plans the work, creates tasks and sends coding agents to do them on your machine, then flags you down only when a task needs you. Finished work lands as a GitHub pull request.',
      ],
      [
        'Do I have to use the Dispatch app?',
        'No. You can keep the agent you already use, such as Claude Desktop, Cursor, Claude Code, OpenCode, Codex or T3 Code, and connect it to the Dispatch core as an MCP server. It can then read the board, comment on tasks, message your Overseer and ask you for approvals. The app and connected agents use the same core, so you can use both.',
      ],
      [
        'Which coding agents does it run?',
        'Claude Code and Codex. Each runs as its own command line program on your machine, signed in with your own account or API key.',
      ],
      [
        'When does the Overseer interrupt me?',
        'Only when a task needs your input: an agent’s question, a tool it wants your approval to run, checks that failed, or a pull request ready to merge. Each shows under Needs you with a button per answer.',
      ],
      [
        'Does Dispatch block agents for cost or for the files they touch?',
        'No. A task can declare the files it expects to change, and that only warns other Overseers about likely merge conflicts. Nothing is denied for cost or for declared files.',
      ],
      [
        'Does my code leave my machine?',
        'Your agents run on your machine and send what they read to their own provider, as they do without Dispatch. Pull requests go to GitHub. If you join a team, the team server stores only end-to-end encrypted data it cannot read.',
      ],
    ],
  },
  {
    id: 'landing',
    title: 'Landing work',
    items: [
      [
        'How does finished work land?',
        'As a GitHub pull request. Your project’s own checks run first, then the pull request opens with a description of the change. GitHub merges it, and review comments left on the pull request go back to the agent.',
      ],
      [
        'Is there a merge queue or a required review?',
        'No. GitHub does the merging. You can ask a reviewer agent to read a change; its verdict goes in the pull request’s description and never blocks.',
      ],
      [
        'What happens when checks fail?',
        'The run shows under Needs you. You can send the agent back with a note; it resumes its session with what failed, and its new commits go through the checks again and update the pull request.',
      ],
    ],
  },
  {
    id: 'app',
    title: 'The app',
    items: [
      [
        'What does Dispatch run on?',
        'macOS, as one universal build for Apple silicon and Intel. The app is native, built with GPUI.',
      ],
      [
        'What views does it have?',
        'The Overseer with Needs you, the board, sessions, a run view to talk to an agent about its task, the task page, a terminal, Going out for pull requests, and planning: My week, Allocation, Projects, Timeline and Graph. Each comes in light and dark.',
      ],
      [
        'Can I change how the app looks and works?',
        'Yes. Every panel is a small JavaScript file in your app folder and every theme is a file, so you can edit them yourself or ask Claude to. The window picks up a saved change at once.',
      ],
    ],
  },
  {
    id: 'teams',
    title: 'Teams',
    items: [
      [
        'How do teams work?',
        'A team uses the hosted team server at team.dispatch.foo. Teammates share projects and their boards stay in sync, you see your teammates’ agents beside your own, and one person’s core is named lead for each project.',
      ],
      [
        'What can the team server read?',
        'Nothing of your work. It stores only sealed, end-to-end encrypted bytes, so it cannot read task titles or code.',
      ],
      [
        'How do I sign in to the team server?',
        'With Linear. Sign-in with GitHub is coming.',
      ],
      [
        'Does Dispatch sync with Linear?',
        'Yes, both ways. Connect a project to a Linear team and its tasks and their states stay in step with Linear’s issues.',
      ],
    ],
  },
  { id: 'pricing', title: 'Pricing and licensing', items: pricingFaq },
];
