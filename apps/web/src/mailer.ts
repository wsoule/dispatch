// Email from the team service: invites, for now. Sent through Resend's HTTP
// API (https://resend.com/docs/api-reference/emails/send-email), so there is
// no SMTP connection to keep and no SDK dependency. Without RESEND_API_KEY
// and INVITE_EMAIL_FROM the service sends nothing and admins copy the invite
// link by hand, as before.

export interface Email {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
}

export class MailError extends Error {}

const RESEND_API = 'https://api.resend.com/emails';

/** A mailer that sends through Resend as `from` (an address on a domain
 *  verified in the Resend account, e.g. `Dispatch <invites@example.com>`). */
export function resendMailer(
  apiKey: string,
  from: string,
  fetchImpl: typeof fetch = fetch
): Mailer {
  return {
    async send(email) {
      let res: Response;
      try {
        res = await fetchImpl(RESEND_API, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${apiKey}`,
            'content-type': 'application/json',
            'user-agent': 'dispatch-team-service',
          },
          body: JSON.stringify({
            from,
            to: [email.to],
            subject: email.subject,
            text: email.text,
            html: email.html,
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (err) {
        throw new MailError(
          `could not reach Resend: ${(err as Error).message}`
        );
      }
      if (res.ok) return;
      // Resend answers {name, message}; the message never carries the key.
      const body = (await res.json().catch(() => ({}))) as {
        message?: unknown;
      };
      throw new MailError(
        `Resend refused the email (${res.status}${
          typeof body.message === 'string'
            ? `: ${body.message.slice(0, 200)}`
            : ''
        })`
      );
    },
  };
}

/** The mailer the environment configures, or null when it configures none. */
export function mailerFromEnv(env: NodeJS.ProcessEnv): Mailer | null {
  const key = env.RESEND_API_KEY ?? '';
  const from = env.INVITE_EMAIL_FROM ?? '';
  return key === '' || from === '' ? null : resendMailer(key, from);
}

/** A loose check that a string is one email address and nothing else. */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@<>,;"]{1,64}@[^\s@<>,;"]{1,190}\.[^\s@<>,;"]{2,}$/.test(value);
}

function esc(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** The invite email: one link to join, and the one command that also
 *  connects the person's agents. */
export function inviteEmail(input: {
  to: string;
  team: string;
  by: string;
  link: string;
}): Email {
  const command = `npx -y @dispatch-foo/mcp join ${input.link}`;
  return {
    to: input.to,
    subject: `${input.by} invited you to ${input.team} on Dispatch`,
    text: [
      `${input.by} invited you to join ${input.team} on Dispatch, so your coding agents (Claude Code, Codex, Cursor and others) can reach your teammates' agents.`,
      '',
      `Join: ${input.link}`,
      '',
      'Or join and connect this computer in one step, from a terminal:',
      `  ${command}`,
      '',
      'The invite works once and expires in 7 days.',
    ].join('\n'),
    html: `<p>${esc(input.by)} invited you to join <strong>${esc(input.team)}</strong> on Dispatch, so your coding agents (Claude Code, Codex, Cursor and others) can reach your teammates' agents.</p>
<p><a href="${esc(input.link)}">Join ${esc(input.team)}</a></p>
<p>Or join and connect this computer in one step, from a terminal:</p>
<pre><code>${esc(command)}</code></pre>
<p style="color:#666">The invite works once and expires in 7 days.</p>`,
  };
}
