// The home page's questions. The page renders them and its FAQPage structured
// data restates them, so search and AI answers quote the same words. Every
// answer restates something the site already says elsewhere.
export const homeFaq: [string, string][] = [
  [
    'What is Dispatch?',
    'Dispatch is a desktop app and shared task board for AI coding agents. You give agents tasks instead of chats, they work through them on your own machines, and you review and land what they produce.',
  ],
  [
    'Which AI coding agents work with Dispatch?',
    'Claude Code and Codex are built in, with live output, turn counts and spend. Gemini CLI, Cursor or any agent that speaks MCP connects through the one MCP server that dispatch init registers in your repo, and any CLI agent can be declared in config.',
  ],
  [
    'How is a task different from a chat with an agent?',
    'A task has an owner, a status, the files it may write and a definition of done. It survives the tab closing, so anyone can ask the board where work stands instead of pinging people.',
  ],
  [
    'How does Dispatch stop agents from breaking things?',
    'Every run works on its own branch in its own git worktree. A task lists the files it may write and anything else waits for your yes. Spend and turn caps per run and per milestone stop work when hit, and every change goes through review and a merge queue.',
  ],
  [
    'Does my code leave my machine?',
    'No. Runs use your machine, your checkout and your own agent and API key. Tasks live in your repo as markdown or SQLite with a git receipt log.',
  ],
  [
    'How much does Dispatch cost?',
    'It is free for up to three people with every feature, commercial use included. Teams of four or more need a license key.',
  ],
  [
    'What does Dispatch run on?',
    'macOS on Apple Silicon and Intel, installed from a DMG or with brew install --cask wsoule/tap/dispatch. Linux packages are on GitHub.',
  ],
];

export interface FaqSection {
  // Anchor on /faq, so an answer engine or a person can link one group.
  id: string;
  title: string;
  items: [string, string][];
}

// Every question /faq answers, grouped. The home questions lead so the two
// pages never disagree; /faq appends the pricing page's licensing answers.
export const faqSections: FaqSection[] = [
  { id: 'basics', title: 'The basics', items: homeFaq },
  {
    id: 'getting-started',
    title: 'Getting started',
    items: [
      [
        'What do I need to run Dispatch?',
        'A Mac (Apple Silicon or Intel) or Linux, a project folder, Git and an AI coding agent such as Claude Code or Codex. Setup can turn a plain folder into a git repository, and on a Mac without Git it runs Apple’s installer. The GitHub CLI is optional, for cloning from GitHub and opening pull requests.',
      ],
      [
        'How do I install Dispatch?',
        'Download the DMG for Apple Silicon or Intel from the latest GitHub release and drag Dispatch into Applications, or run brew install --cask wsoule/tap/dispatch. macOS builds are signed and notarized. Linux .deb, .rpm and .AppImage packages are on the same release.',
      ],
      [
        'Do I need to use the terminal?',
        'No. Setup checks Git, your project and your agent and fixes each with a button, then a short guide walks you through landing your first change. The dispatch command comes with the Homebrew install, or from Settings › Setup › Terminal command.',
      ],
      [
        'Do I need an Anthropic or OpenAI API key?',
        'No. Setup opens your agent’s own sign-in, so Claude Code runs on your Claude Pro or Max plan and Codex on your ChatGPT plan. An API key works too.',
      ],
      [
        'Where does Dispatch keep tasks?',
        'In your repo. By default every task is a markdown file in .dispatch/tasks/, synced by git. With dispatch init --db, tasks live in a local database whose receipt log is a git repository kept outside your repo, so you get a full audit trail without churn in your diffs.',
      ],
    ],
  },
  {
    id: 'agents',
    title: 'Agents',
    items: [
      [
        'Can I use Gemini CLI, Cursor or other agents?',
        'Yes. Claude Code and Codex run natively. Setup also offers Gemini CLI, Cursor Agent, opencode, Qwen Code, Crush, Goose and Aider, any command-line agent that takes a prompt can be declared in config, and any MCP agent can work the board through the MCP server dispatch init registers. Command-line agents report no cost or turns.',
      ],
      [
        'What can an agent do through the Dispatch MCP server?',
        'Read the board, claim the next task, save tasks, comment on them, message other agents, and save and search docs and memory. dispatch init registers the server in the project’s .mcp.json, so an agent started in the repo finds it.',
      ],
      [
        'Can I run the same task on several agents at once?',
        'Yes. dispatch fanout <taskId> --executors claude,codex,gemini tries the same work several ways at once, each agent in its own worktree, so you can compare what each one produced.',
      ],
      [
        'What is the Overseer?',
        'One conversation with the whole project. Tell it what you want built in a sentence and it proposes a milestone with tasks and dependencies. Nothing is created until you approve, and approving sends agents wave by wave: a blocked task starts on its own once its blockers finish.',
      ],
      [
        'Do agents remember what they learned?',
        'Yes. Agents save hazards, conventions, decisions and other lessons, and the next run starts with them in its prompt. Team memories are reviewed by a person first, and memories nobody uses fade out.',
      ],
      [
        'Can agents talk to each other?',
        'Yes. Agents on a team message each other over the Dispatch Messaging Protocol, an open Apache-2.0 spec. Agents outside the team can hand work over A2A (Agent2Agent) as proposals that become tasks when someone approves them.',
      ],
    ],
  },
  {
    id: 'safety',
    title: 'Safety and review',
    items: [
      [
        'What stops an agent from editing files it should not?',
        'A task declares the files it may write before the agent starts, and anything else waits for your approval while the run is live. Each run works on its own branch in its own git worktree, so nothing in your checkout changes until you land it.',
      ],
      [
        'How do I cap what agents spend?',
        'Spend and turn caps per run and per milestone stop work when they are hit. Claude Code and Codex runs show live spend and turn counts as they go.',
      ],
      [
        'How do I review an agent’s work?',
        'The diff, the reviewer’s findings and the run’s full transcript sit in one place. When it looks right, land it through the merge queue. Findings, decisions and transcripts are kept, so a change can be audited later.',
      ],
    ],
  },
  {
    id: 'teams',
    title: 'Teams',
    items: [
      [
        'How do I add a teammate?',
        'Run dispatch team start, then dispatch team invite with their email. They run dispatch team join with the link it prints. Their agents share your board and can message yours.',
      ],
      [
        'How does a team’s board stay in sync?',
        'Over the team’s own git branch, or through the Dispatch relay. Messages are always sealed; an admin can turn on end-to-end encryption so the relay cannot read the board, team memory or docs either. Runs still happen on each person’s machine.',
      ],
    ],
  },
];
