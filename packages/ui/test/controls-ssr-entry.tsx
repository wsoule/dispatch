import { renderToString } from 'react-dom/server';

import {
  Button,
  Field,
  Menu,
  RadioGroup,
  Select,
  TextArea,
  TextField,
} from '../src/index';

// Run by controls-ssr.test.tsx in a child `bun run` with no happy-dom
// preload: no window or document. Every control renders closed.

const noop = () => undefined;

const html = renderToString(
  <>
    <Field label="Email" hint="For commits" error="Required">
      <TextField start={<span>@</span>} />
    </Field>
    <TextArea aria-label="Prompt" defaultValue="Hello" />
    <RadioGroup
      label="Scope"
      value="team"
      onChange={noop}
      options={[{ value: 'team', label: 'Team' }]}
    />
    <RadioGroup
      label="Answer"
      variant="cards"
      activation="manual"
      name="answer"
      value="deny"
      onChange={noop}
      data-testid="answer"
      options={[
        {
          value: 'deny',
          label: 'Deny and tell it why',
          children: <span>Reason box</span>,
        },
        {
          value: 'session',
          label: 'Allow Bash for this run',
          hint: 'Ends with the run',
          aside: <Button>Edit scope</Button>,
        },
        {
          value: 'once',
          label: 'Approve once',
          badge: <span>Recommended</span>,
          children: <span>Never shown</span>,
        },
      ]}
    />
    <Select
      label="Tier"
      value="admin"
      onChange={noop}
      options={[{ value: 'admin', label: 'Admin' }]}
    />
    <Menu
      label="Project"
      items={[{ id: 'a', label: 'Settings', onSelect: noop }]}
      trigger={(props) => <Button {...props}>Project</Button>}
    />
  </>
);

process.stdout.write(
  JSON.stringify({
    hasWindow: typeof window !== 'undefined',
    hasDocument: typeof document !== 'undefined',
    html,
  })
);
