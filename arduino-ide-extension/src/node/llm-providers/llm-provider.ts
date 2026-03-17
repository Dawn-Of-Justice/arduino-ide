export interface LlmMessage {
  role: 'user' | 'assistant' | 'tool';
  content:
    | string
    | LlmContentBlock[]
    | LlmToolResultBlock[];
}

export interface LlmTextBlock {
  type: 'text';
  text: string;
}

export interface LlmToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface LlmToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock;

export interface LlmTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface LlmStreamChunk {
  type: 'text_delta' | 'tool_use_start' | 'tool_use_end' | 'message_done';
  textDelta?: string;
  toolName?: string;
  toolId?: string;
  toolInput?: Record<string, unknown>;
  stopReason?: string;
}

export interface LlmProvider {
  streamChat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    model: string,
    signal: AbortSignal
  ): AsyncIterableIterator<LlmStreamChunk>;
}
