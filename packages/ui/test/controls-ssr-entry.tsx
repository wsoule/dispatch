import { renderToString } from 'react-dom/server';

import {
  Button,
  ConfirmDialog,
  Dialog,
  Disclosure,
  Field,
  Menu,
  Popover,
  RadioGroup,
  Select,
  Spinner,
  TextArea,
  TextField,
  Tooltip,
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
    <Popover
      label="Options"
      trigger={(props) => <Button {...props}>Options</Button>}
    >
      <p>Panel</p>
    </Popover>
    <Tooltip content="Open the plan">
      <Button>Plan</Button>
    </Tooltip>
    <Disclosure summary="Details">
      <p>Hidden body</p>
    </Disclosure>
    <Spinner />
    <Dialog open={false} onClose={noop} title="Closed dialog" />
    <ConfirmDialog
      open={false}
      onCancel={noop}
      onConfirm={noop}
      title="Closed confirm"
      confirmLabel="Go"
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
