import { DMG, RELEASES, VERSION } from './downloads';

export const SITE = 'https://dispatch.foo';
export const REPO = 'https://github.com/wsoule/dispatch';
export const DESCRIPTION =
  'Talk to your Overseer: it plans the work, sends Claude Code and Codex to do it on your machine, and flags you only when a task needs you. Finished work lands as a GitHub pull request.';

// Every page the site links and wants indexed, for the sitemap and llms.txt.
// The old protocol and A2A pages still build but are left out: they describe
// the previous system.
export function indexablePaths(): string[] {
  return [
    '/',
    '/download',
    '/docs',
    '/hub',
    '/pricing',
    '/faq',
    '/changelog',
    '/privacy',
  ];
}

const ORG_ID = `${SITE}/#organization`;

export const organization = {
  '@type': 'Organization',
  '@id': ORG_ID,
  name: 'Dispatch',
  url: SITE,
  logo: `${SITE}/favicon.svg`,
  email: 'hello@dispatch.foo',
  sameAs: [REPO],
};

export const website = {
  '@type': 'WebSite',
  '@id': `${SITE}/#website`,
  name: 'Dispatch',
  url: SITE,
  description: DESCRIPTION,
  inLanguage: 'en',
  publisher: { '@id': ORG_ID },
};

// The app itself, for the home page: what it is, what it runs on, what it
// costs and where to get it.
export function softwareApplication() {
  return {
    '@type': 'SoftwareApplication',
    '@id': `${SITE}/#app`,
    name: 'Dispatch',
    url: SITE,
    description: DESCRIPTION,
    applicationCategory: 'DeveloperApplication',
    applicationSubCategory: 'AI coding agent orchestration',
    operatingSystem: 'macOS',
    softwareVersion: VERSION,
    downloadUrl: [DMG, RELEASES],
    installUrl: `${SITE}/download`,
    screenshot: `${SITE}/shots/overseer-light-1600.webp`,
    image: `${SITE}/og.png`,
    offers: [
      {
        '@type': 'Offer',
        name: 'Solo',
        price: '0',
        priceCurrency: 'USD',
        description: 'Your machine, your agents, every local feature.',
        url: `${SITE}/pricing`,
      },
      {
        '@type': 'Offer',
        name: 'Team',
        price: '10',
        priceCurrency: 'USD',
        description: 'Per seat per month, on the hosted team server.',
        url: `${SITE}/pricing`,
      },
    ],
    featureList: [
      'An Overseer per person that plans work, creates tasks and sends coding agents',
      'Runs Claude Code and Codex as their own CLIs, with your own sign-in',
      'Connects to the agent you already use, such as Claude Desktop, Cursor, Claude Code, Codex or OpenCode, over MCP',
      'Flags you only for questions, tool approvals, failed checks and pull requests to merge',
      'Finished work lands as a GitHub pull request',
      'A native macOS app whose panels are JavaScript mods and whose themes are files',
      'Planning views: My week, Allocation, Projects, Timeline and Graph',
      'Teams on a hosted server that stores only end-to-end encrypted data',
      'Two-way Linear sync',
    ],
    publisher: { '@id': ORG_ID },
  };
}

export function faqPage(faq: [string, string][]) {
  return {
    '@type': 'FAQPage',
    mainEntity: faq.map(([q, a]) => ({
      '@type': 'Question',
      name: q,
      acceptedAnswer: { '@type': 'Answer', text: a },
    })),
  };
}

export function breadcrumbs(trail: [string, string][]) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: trail.map(([name, path], i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name,
      item: `${SITE}${path}`,
    })),
  };
}

// One JSON-LD graph for a page. `<` is escaped so no string inside can close
// the script element early.
export function ldJson(nodes: object[]): string {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@graph': nodes,
  }).replace(/</g, '\\u003c');
}
