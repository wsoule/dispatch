import { choice } from '@typesafe-ai/sdk';

import type { OverseerMessage } from '../orchestrator/overseer.js';
import type { JudgmentClient } from './client.js';
import { capText, warnOnce } from './client.js';

/** Below this, a "new topic" reading is not trusted to open a new conversation. */
const CONFIDENCE_FLOOR = 0.75;
const RECENT_LINES = 8;
const LINE_CAP = 1_500;

export interface TopicReading {
  /** True only on a confident "new subject" reading. */
  newTopic: boolean;
  /** The judgment's confidence, or null when nothing was judged. */
  confidence: number | null;
}

// "Same work" was too loose: a fresh ask about the same task list read as a follow-up.
function topicQuestions() {
  return {
    topic: choice(
      'The human is chatting with their coding agent. Does `next` carry on the exchange in `recent`, or is it a separate ask that deserves its own conversation?',
      {
        continues:
          'next reacts to the recent lines: it answers, corrects, pushes back on, retries or extends the request in progress, or points at something they mention (that, it, them, those, the fix, the first one)',
        new: 'next is its own ask: a different question or request that would make sense to someone who never saw the recent lines, such as asking what to work on next, asking for a status or summary, or starting other work, even in the same project',
      }
    ),
  };
}

/**
 * Whether `next` belongs in a fresh Overseer conversation. Fail-open: no
 * client, an empty conversation, or a failed call all read as "continues".
 */
export async function judgeTopic(
  client: JudgmentClient | null,
  messages: readonly OverseerMessage[],
  next: string
): Promise<TopicReading> {
  const recent = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .slice(-RECENT_LINES)
    .map((m) => ({ who: m.role, text: capText(m.text, LINE_CAP) }));
  if (client === null || recent.length === 0) {
    return { newTopic: false, confidence: null };
  }
  try {
    const result = await client.judge(
      { recent, next: capText(next, LINE_CAP) },
      topicQuestions()
    );
    const { choice: picked, confidence } = result.answers.topic;
    return {
      newTopic: picked === 'new' && confidence >= CONFIDENCE_FLOOR,
      confidence,
    };
  } catch (err) {
    warnOnce('overseer-topic', err);
    return { newTopic: false, confidence: null };
  }
}
