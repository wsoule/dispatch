import type { JsonValue } from '@dispatch/protocol';

import type { WireTaskState } from './states.js';

// The ProtoJSON shapes this package writes (a2a.proto v1.0.1).

export interface PartJson {
  text?: string;
  data?: JsonValue;
  url?: string;
  // File bytes, base64 as ProtoJSON writes a bytes field.
  raw?: string;
  mediaType?: string;
  filename?: string;
  metadata?: Record<string, JsonValue>;
}

export interface MessageJson {
  messageId: string;
  contextId?: string;
  taskId?: string;
  role: 'ROLE_USER' | 'ROLE_AGENT';
  parts: PartJson[];
  metadata?: Record<string, JsonValue>;
  extensions?: string[];
}

export interface TaskStatusJson {
  state: WireTaskState;
  message?: MessageJson;
  timestamp?: string;
}

export interface ArtifactJson {
  artifactId: string;
  name?: string;
  parts: PartJson[];
  metadata?: Record<string, JsonValue>;
  extensions?: string[];
}

export interface TaskJson {
  id: string;
  contextId: string;
  status: TaskStatusJson;
  artifacts?: ArtifactJson[];
  history?: MessageJson[];
  metadata?: Record<string, JsonValue>;
}

export type StreamResponseJson =
  | { task: TaskJson }
  | { message: MessageJson }
  | {
      statusUpdate: {
        taskId: string;
        contextId: string;
        status: TaskStatusJson;
        metadata?: Record<string, JsonValue>;
      };
    }
  | {
      artifactUpdate: {
        taskId: string;
        contextId: string;
        artifact: ArtifactJson;
        append: false;
        lastChunk: true;
      };
    };
