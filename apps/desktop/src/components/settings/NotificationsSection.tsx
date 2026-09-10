import type { DispatchConfig, NotificationKind } from '@dispatch/core/browser';
import { isMaskedSecretUrl, NOTIFICATION_KINDS } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { Button } from '@/ui/button';
import { Checkbox } from '@/ui/checkbox';
import { HintText, Panel, PanelHeader, PanelRow } from '@/ui/chrome';
import { Field, FieldDescription, FieldLabel } from '@/ui/field';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';

interface NotificationsSectionProps {
  config: DispatchConfig;
  onSave: (patch: {
    notifications?: {
      kinds?: Partial<Record<NotificationKind, boolean>>;
      webhook?: string | null;
    };
  }) => Promise<void>;
}

// One row per feed kind, worded as the thing that happened rather than the
// kind's name — see NotificationKind in packages/core for what each covers.
const KIND_INFO: Record<NotificationKind, { label: string; hint: string }> = {
  question: {
    label: 'An agent asks you a question',
    hint: 'ask_user — the run is blocked until you answer.',
  },
  approval: {
    label: 'An agent needs permission to use a tool',
    hint: 'A run parked on a permission gate.',
  },
  'scope-request': {
    label: 'An agent asks to edit outside its scope',
    hint: 'Files beyond the task’s declared writes.',
  },
  'fix-loop-capped': {
    label: 'A fix loop stops and needs a ruling',
    hint: 'Review or verify failures the loop could not fix within its rounds.',
  },
  'run-stalled': {
    label: 'A run fails or stalls',
    hint: 'Failed, interrupted with uncommitted work, or its base is gone.',
  },
};

/** Delivery beyond the app: which kinds of thing awaiting you fire a native
 *  notification while the window is in the background, and the webhook that
 *  carries the same items out as JSON. Save feedback lives in the shell. */
export function NotificationsSection({
  config,
  onSave,
}: NotificationsSectionProps) {
  const [webhook, setWebhook] = useState('');
  // The daemon masks a stored webhook to its origin (the path is the
  // credential), so what config carries is display text, not a URL. It stays
  // out of the input: `replacing` is the user having asked for an empty one.
  const [replacing, setReplacing] = useState(false);
  const [refused, setRefused] = useState(false);

  const stored = config.notifications.webhook ?? '';
  const masked = stored !== '' && isMaskedSecretUrl(stored);

  // Re-seeds when config changes underneath (another window, a hand edit).
  useEffect(() => {
    setWebhook(masked ? '' : stored);
    setReplacing(false);
    setRefused(false);
  }, [stored, masked]);

  // Blur commits the draft. A value ending in the mask suffix is the masked
  // display form, never something the daemon can POST to, so it is refused
  // rather than written to disk. While replacing a masked URL, an empty draft
  // is a change of mind: the stored URL stays and the read-only line returns.
  function commitWebhook(): void {
    const next = webhook.trim();
    if (next !== '' && isMaskedSecretUrl(next)) {
      setRefused(true);
      return;
    }
    setRefused(false);
    if (masked) {
      if (next === '') {
        setReplacing(false);
        return;
      }
      void onSave({ notifications: { webhook: next } });
      return;
    }
    if (next !== stored) {
      // Empty clears the key rather than storing an empty URL.
      void onSave({ notifications: { webhook: next === '' ? null : next } });
    }
  }

  return (
    <>
      <Panel>
        <PanelHeader>What interrupts you</PanelHeader>

        <PanelRow>
          <HintText>
            Each kind reaches beyond the app when it is on: a native
            notification while this window is in the background, and the webhook
            below. The inbox and the feed keep every item either way.
          </HintText>
        </PanelRow>

        {NOTIFICATION_KINDS.map((kind) => (
          <PanelRow key={kind} className="flex-col items-stretch gap-0.5">
            <Label className="flex items-center gap-2 font-normal">
              <Checkbox
                className="size-3.5"
                checked={config.notifications.kinds[kind]}
                onCheckedChange={(checked) =>
                  void onSave({
                    notifications: { kinds: { [kind]: checked === true } },
                  })
                }
              />
              <span className="text-[13px]">{KIND_INFO[kind].label}</span>
            </Label>
            <span className="dense-meta pl-5.5">{KIND_INFO[kind].hint}</span>
          </PanelRow>
        ))}
      </Panel>

      <Panel>
        <PanelHeader>Webhook</PanelHeader>

        <PanelRow className="flex-col items-stretch gap-1.5">
          {masked && !replacing ? (
            <div className="flex items-center gap-2">
              <span className="text-[13px]">
                Configured:{' '}
                <span className="font-mono text-[12.5px]">{stored}</span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                className="ml-auto"
                onClick={() => {
                  setWebhook('');
                  setRefused(false);
                  setReplacing(true);
                }}
              >
                Replace
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() =>
                  void onSave({ notifications: { webhook: null } })
                }
              >
                Clear
              </Button>
            </div>
          ) : (
            <Field className="gap-1.5">
              <FieldLabel
                htmlFor="webhook-url"
                className="text-[12px] font-normal"
              >
                Webhook URL
              </FieldLabel>
              <Input
                id="webhook-url"
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                onBlur={commitWebhook}
                placeholder="https://hooks.slack.com/services/…"
                className="font-mono text-[12.5px]"
              />
              {refused && (
                <span className="text-state-failed text-[12px]">
                  That is the masked form of a stored URL, not a URL. Paste the
                  full webhook URL.
                </span>
              )}
            </Field>
          )}
          <FieldDescription className="text-[11px]">
            Every newly-blocking item is POSTed here as JSON, subject to the
            toggles above. Point Slack, a Zap, or your own endpoint at it.
            {masked
              ? ' The stored URL is a credential and is only ever shown by its origin; Replace to enter a new one, Clear to remove it.'
              : ' Leave empty for no webhook.'}
          </FieldDescription>
        </PanelRow>
      </Panel>
    </>
  );
}
