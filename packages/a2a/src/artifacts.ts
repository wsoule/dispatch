import type { JsonValue, Message } from '@dispatch/protocol';

import type { WorkArtifactV1 } from './ext.js';
import type { TaskFacts } from './port.js';
import type { ProjectionView } from './projection.js';
import { WORK_URI } from './uris.js';
import type { ArtifactJson, PartJson } from './wire.js';

type ArtifactView = Pick<ProjectionView, 'textMediaType' | 'extensions'>;

// An ask's answer as the `answer` artifact: its text, and its choice as data.
export function answerArtifact(
  answer: Message,
  view: ArtifactView
): ArtifactJson {
  const parts: PartJson[] = [
    { text: answer.body, mediaType: view.textMediaType },
  ];
  if (answer.choice !== undefined) {
    parts.push({
      data: { choice: answer.choice },
      mediaType: 'application/json',
    });
  }
  const artifact: ArtifactJson = {
    artifactId: 'answer',
    name: 'answer',
    parts,
  };
  if (view.extensions.has(WORK_URI)) {
    const ext: WorkArtifactV1 = {
      kind: 'answer',
      messageId: answer.id,
      ...(answer.choice === undefined ? {} : { choice: answer.choice }),
    };
    artifact.metadata = { [WORK_URI]: ext as unknown as JsonValue };
    artifact.extensions = [WORK_URI];
  }
  return artifact;
}

// A handoff's pr, diffstat and evidence artifacts; none are produced yet.
export function workArtifacts(
  _work: TaskFacts['work'],
  _view: ArtifactView
): ArtifactJson[] {
  return [];
}
