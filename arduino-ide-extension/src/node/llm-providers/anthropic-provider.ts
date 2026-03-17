import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  LlmTool,
} from './llm-provider';

// Minimal local types so this file compiles without `@anthropic-ai/sdk` installed.
interface AnthropicTool {
  name: string;
  description?: string;
  input_schema: { type: 'object'; properties?: Record<string, unknown>; required?: string[] };
}
interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}
interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}
type AnthropicMessageContent = string | AnthropicContentBlock[] | AnthropicToolResultBlock[];
interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: AnthropicMessageContent;
}

export class AnthropicProvider implements LlmProvider {
  constructor(private readonly apiKey: string) {}

  async *streamChat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    model: string,
    signal: AbortSignal
  ): AsyncIterableIterator<LlmStreamChunk> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Anthropic = (require('@anthropic-ai/sdk') as { default: new (opts: { apiKey: string }) => any }).default;
    const client = new Anthropic({ apiKey: this.apiKey });

    const anthropicTools: AnthropicTool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as AnthropicTool['input_schema'],
    }));

    const anthropicMessages: AnthropicMessageParam[] =
      messages.map((m) => this.toAnthropicMessage(m));

    const stream = client.messages.stream(
      {
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: anthropicTools,
        messages: anthropicMessages,
      },
      { signal }
    );

    let currentToolId: string | undefined;
    let currentToolName: string | undefined;
    let currentToolArgBuffer = '';

    for await (const event of stream) {
      const ev = event as {
        type: string;
        content_block?: { type: string; id?: string; name?: string };
        delta?: { type: string; text?: string; partial_json?: string };
      };

      if (
        ev.type === 'content_block_start' &&
        ev.content_block?.type === 'tool_use'
      ) {
        currentToolId = ev.content_block.id;
        currentToolName = ev.content_block.name;
        currentToolArgBuffer = '';
        yield {
          type: 'tool_use_start',
          toolName: currentToolName,
          toolId: currentToolId,
          toolInput: {},
        };
      } else if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta'
      ) {
        yield { type: 'text_delta', textDelta: ev.delta.text ?? '' };
      } else if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'input_json_delta'
      ) {
        currentToolArgBuffer += ev.delta.partial_json ?? '';
      } else if (ev.type === 'content_block_stop' && currentToolId) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(currentToolArgBuffer);
        } catch {
          // ignore
        }
        yield {
          type: 'tool_use_end',
          toolName: currentToolName,
          toolId: currentToolId,
          toolInput: input,
        };
        currentToolId = undefined;
        currentToolName = undefined;
        currentToolArgBuffer = '';
      } else if (ev.type === 'message_stop') {
        const finalMessage = await stream.finalMessage();
        const stopReason = (finalMessage as { stop_reason?: string }).stop_reason ?? 'end_turn';
        yield { type: 'message_done', stopReason };
      }
    }
  }

  private toAnthropicMessage(msg: LlmMessage): AnthropicMessageParam {
    if (typeof msg.content === 'string') {
      return {
        role: msg.role === 'tool' ? 'user' : (msg.role as 'user' | 'assistant'),
        content: msg.content,
      };
    }

    if (Array.isArray(msg.content)) {
      // Tool result blocks from our internal format
      if (
        msg.role === 'tool' &&
        msg.content.length > 0 &&
        (msg.content[0] as { type: string }).type === 'tool_result'
      ) {
        return {
          role: 'user',
          content: msg.content.map((b) => {
            const block = b as { type: string; tool_use_id: string; content: string };
            return {
              type: 'tool_result' as const,
              tool_use_id: block.tool_use_id,
              content: block.content,
            };
          }),
        };
      }

      // Assistant blocks (text + tool_use)
      return {
        role: 'assistant',
        content: (
          msg.content as Array<{
            type: string;
            text?: string;
            id?: string;
            name?: string;
            input?: Record<string, unknown>;
          }>
        ).map((b) => {
          if (b.type === 'text') {
            return { type: 'text' as const, text: b.text ?? '' };
          }
          return {
            type: 'tool_use' as const,
            id: b.id ?? '',
            name: b.name ?? '',
            input: b.input ?? {},
          };
        }),
      };
    }

    return { role: 'user', content: '' };
  }
}
