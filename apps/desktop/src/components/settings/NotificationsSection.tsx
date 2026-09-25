import type { DispatchConfig, NotificationKind } from '@dispatch/core/browser';
import { isMaskedSecretUrl, NOTIFICATION_KINDS } from '@dispatch/core/browser';
import { useEffect, useState } from 'react';

import { SettingsSwitch } from './fields';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { PillButton } from '@/ui/ai/pill';
import { Input } from '@/ui/input';

interface NotificationsSectionProps {
  config: DispatchConfig;
  /** The webhook sends data elsewhere, so only the owner may change it. */
  canOperate: boolean;
  onSave: (patch: {
    notifications?: {
      kinds?: Partial<Record<NotificationKind, boolean>>;
      webhook?: string | null;
    };
  }) => Promise<unknown>;
}

// One row per feed kind, worded as the thing that happened rather than the
// kind's name — see NotificationKind in packages/core for what each covers.
const KIND_INFO: Record<NotificationKind, { label: string; hint: string }> = {
  question: {
    label: 'An agent asks you a question',
    hint: 'The run waits until you answer.',
  },
  approval: {
    label: 'An agent needs permission',
    hint: 'A run is paused on a command it needs you to allow.',
  },
  'scope-request': {
    label: 'An agent asks to edit extra files',
    hint: 'Files outside the ones its task lists.',
  },
  'fix-loop-capped': {
    label: 'A fix loop gives up',
    hint: "Problems it couldn't fix in its rounds, waiting for your call.",
  },
  'run-stalled': {
    label: 'A run fails or gets stuck',
    hint: 'It failed, stopped with unsaved work, or its starting point is gone.',
  },
};

/** Delivery beyond the app: which kinds of thing awaiting you fire a native
 *  notification while the window is in the background, and the webhook that
 *  carries the same items out as JSON. Save feedback lives in the shell. */
export function NotificationsSection({
  config,
  onSave,
  canOperate,
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
      <SettingsGroup
        title="Notify me when"
        hint="A system notification when Dispatch is in the background, plus the webhook below. Your inbox keeps everything either way."
        keywords="alerts native"
      >
        {NOTIFICATION_KINDS.map((kind) => (
          <SettingsRow
            key={kind}
            title={KIND_INFO[kind].label}
            subtitle={KIND_INFO[kind].hint}
            htmlFor={`notify-${kind}`}
            control={
              <SettingsSwitch
                id={`notify-${kind}`}
                checked={config.notifications.kinds[kind]}
                onCheckedChange={(checked) =>
                  void onSave({
                    notifications: { kinds: { [kind]: checked } },
                  })
                }
              />
            }
          />
        ))}
      </SettingsGroup>

      <SettingsGroup title="Webhook" keywords="slack zapier http">
        {masked && !replacing ? (
          <SettingsRow
            title={
              <>
                Configured:{' '}
                <span className="text-(--text-secondary)">{stored}</span>
              </>
            }
            subtitle="Only the start of the address is shown, because the rest works like a password."
            locked={!canOperate}
            control={
              canOperate && (
                <>
                  <PillButton
                    onClick={() => {
                      setWebhook('');
                      setRefused(false);
                      setReplacing(true);
                    }}
                  >
                    Replace
                  </PillButton>
                  <PillButton
                    onClick={() =>
                      void onSave({ notifications: { webhook: null } })
                    }
                  >
                    Clear
                  </PillButton>
                </>
              )
            }
          />
        ) : (
          <SettingsRow
            title="Webhook URL"
            subtitle="Everything switched on above is also sent here as JSON: Slack, Zapier or your own server. Leave empty for none."
            htmlFor="webhook-url"
            locked={!canOperate}
            stacked
            control={
              <Input
                id="webhook-url"
                disabled={!canOperate}
                value={webhook}
                onChange={(e) => setWebhook(e.target.value)}
                onBlur={commitWebhook}
                placeholder="https://hooks.slack.com/services/…"
              />
            }
          >
            {refused && (
              <span className="text-state-failed text-[12px]">
                That&rsquo;s the shortened address shown for a saved webhook.
                Paste the full URL.
              </span>
            )}
          </SettingsRow>
        )}
      </SettingsGroup>
    </>
  );
}
