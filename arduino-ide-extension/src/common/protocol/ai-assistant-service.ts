import type { JsonRpcServer } from '@theia/core/lib/common/messaging/proxy-factory';

export interface AiStreamChunk {
  readonly sessionId: string;
  readonly type:
    | 'text'
    | 'tool_start'
    | 'tool_result'
    | 'done'
    | 'error'
    | 'sketch_updated'
    | 'verify_request';
  readonly content: string;
  readonly toolName?: string;
}

export interface AiSketchContext {
  readonly sketchContent: string;
  readonly sketchName: string;
  readonly sketchMainFilePath: string;
  readonly boardFqbn: string | undefined;
  readonly boardName: string | undefined;
  readonly portAddress: string | undefined;
  readonly recentCompilerErrors: string;
}

export type AiProviderType = 'github-models' | 'openai' | 'anthropic' | 'ollama';
export type AiChatMode = 'agent' | 'ask' | 'plan';

/** A single past turn included in the request so the backend has full context. */
export interface AiHistoryMessage {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface AiChatRequest {
  readonly sessionId: string;
  readonly userMessage: string;
  readonly history: readonly AiHistoryMessage[];
  readonly context: AiSketchContext;
  readonly provider: AiProviderType;
  readonly apiKey: string;
  readonly model: string;
  readonly ollamaUrl?: string;
  readonly mode?: AiChatMode;
}

export interface AiAssistantClient {
  onStreamChunk(chunk: AiStreamChunk): void;
}

export const AiAssistantServicePath = '/services/ai-assistant-service';
export const AiAssistantService = Symbol('AiAssistantService');
export interface AiAssistantService extends JsonRpcServer<AiAssistantClient> {
  sendMessage(request: AiChatRequest): Promise<void>;
  cancelRequest(sessionId: string): Promise<void>;
  disposeClient(client: AiAssistantClient): void;
}
