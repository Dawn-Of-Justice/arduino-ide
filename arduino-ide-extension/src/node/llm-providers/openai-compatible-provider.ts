import type {
  LlmMessage,
  LlmProvider,
  LlmStreamChunk,
  LlmTool,
} from './llm-provider';

// Minimal local types so this file compiles without `openai` package installed.
// The actual runtime objects come from `require('openai')`.
type OaiRole = 'system' | 'user' | 'assistant' | 'tool';
interface OaiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
interface OaiMessage {
  role: OaiRole;
  content?: string | null;
  tool_call_id?: string;
  tool_calls?: OaiToolCall[];
  name?: string;
}

/**
 * Covers GitHub Models, OpenAI, and Ollama — all use the OpenAI chat completions API format.
 *
 * GitHub Models: baseURL = 'https://models.inference.ai.azure.com', apiKey = GitHub PAT
 * OpenAI:        baseURL = undefined (default), apiKey = OpenAI key
 * Ollama:        baseURL = 'http://localhost:11434/v1', apiKey = 'ollama' (dummy)
 */
export class OpenAICompatibleProvider implements LlmProvider {
  constructor(
    private readonly apiKey: string,
    private readonly baseURL?: string
  ) {}

  async *streamChat(
    systemPrompt: string,
    messages: LlmMessage[],
    tools: LlmTool[],
    model: string,
    signal: AbortSignal
  ): AsyncIterableIterator<LlmStreamChunk> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OpenAI } = require('openai') as { OpenAI: new (opts: { apiKey: string; baseURL?: string }) => any };

    const client = new OpenAI({
      apiKey: this.apiKey || 'no-key',
      baseURL: this.baseURL,
    });

    const openAiMessages: OaiMessage[] = [
      { role: 'system', content: systemPrompt },
      ...messages.map((m) => this.toOpenAiMessage(m)),
    ];

    const openAiTools = tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.inputSchema as Record<string, unknown>,
      },
    }));

    const stream = await client.chat.completions.create(
      {
        model,
        messages: openAiMessages,
        tools: openAiTools.length > 0 ? openAiTools : undefined,
        tool_choice: openAiTools.length > 0 ? 'auto' : undefined,
        stream: true,
      },
      { signal }
    );

    // Accumulate tool call deltas
    const toolCallAccumulator: Map<
      number,
      { id: string; name: string; argBuffer: string }
    > = new Map();

    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      if (!choice) continue;

      const delta = choice.delta as {
        content?: string | null;
        tool_calls?: Array<{
          index: number;
          id?: string;
          function?: { name?: string; arguments?: string };
        }>;
      };

      if (delta.content) {
        yield { type: 'text_delta', textDelta: delta.content };
      }

      if (delta.tool_calls) {
        for (const tcDelta of delta.tool_calls) {
          const idx = tcDelta.index;
          if (!toolCallAccumulator.has(idx)) {
            toolCallAccumulator.set(idx, {
              id: tcDelta.id ?? '',
              name: tcDelta.function?.name ?? '',
              argBuffer: '',
            });
          }
          const acc = toolCallAccumulator.get(idx)!;
          if (tcDelta.id) acc.id = tcDelta.id;
          if (tcDelta.function?.name) acc.name += tcDelta.function.name;
          if (tcDelta.function?.arguments)
            acc.argBuffer += tcDelta.function.arguments;
        }
      }

      const finishReason = (choice as { finish_reason?: string }).finish_reason;
      if (finishReason === 'tool_calls' || finishReason === 'stop') {
        // Emit completed tool calls
        for (const [, acc] of toolCallAccumulator) {
          let input: Record<string, unknown> = {};
          try {
            input = JSON.parse(acc.argBuffer);
          } catch {
            // ignore parse errors
          }
          yield {
            type: 'tool_use_start',
            toolName: acc.name,
            toolId: acc.id,
            toolInput: input,
          };
          yield { type: 'tool_use_end', toolName: acc.name, toolId: acc.id };
        }
        toolCallAccumulator.clear();
        yield { type: 'message_done', stopReason: finishReason };
      }
    }
  }

  private toOpenAiMessage(msg: LlmMessage): OaiMessage {
    if (typeof msg.content === 'string') {
      return { role: msg.role as OaiRole, content: msg.content };
    }

    if (Array.isArray(msg.content)) {
      // Tool result messages
      if (
        msg.role === 'tool' &&
        msg.content.length > 0 &&
        (msg.content[0] as { type: string }).type === 'tool_result'
      ) {
        const tr = msg.content[0] as {
          type: string;
          tool_use_id: string;
          content: string;
        };
        return {
          role: 'tool',
          tool_call_id: tr.tool_use_id,
          content: tr.content,
        };
      }

      // Assistant message with tool_use blocks → convert to OpenAI tool_calls
      const textParts: string[] = [];
      const toolCalls: OaiToolCall[] = [];
      for (const block of msg.content as Array<{
        type: string;
        text?: string;
        id?: string;
        name?: string;
        input?: Record<string, unknown>;
      }>) {
        if (block.type === 'text' && block.text) {
          textParts.push(block.text);
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id ?? '',
            type: 'function',
            function: {
              name: block.name ?? '',
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
      }
      return {
        role: 'assistant',
        content: textParts.join('') || null,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      };
    }

    return { role: 'user', content: '' };
  }
}
