import * as fs from 'fs';
import { injectable, inject, optional } from '@theia/core/shared/inversify';
import { ILogger } from '@theia/core/lib/common/logger';
import { FileUri } from '@theia/core/lib/common/file-uri';
import type {
  AiAssistantClient,
  AiAssistantService,
  AiChatRequest,
  AiSketchContext,
  AiStreamChunk,
} from '../common/protocol/ai-assistant-service';
import { LibraryService } from '../common/protocol/library-service';
import type {
  LlmMessage,
  LlmProvider,
  LlmTool,
  LlmToolResultBlock,
  LlmContentBlock,
} from './llm-providers/llm-provider';
import { OpenAICompatibleProvider } from './llm-providers/openai-compatible-provider';
import { AnthropicProvider } from './llm-providers/anthropic-provider';

const MAX_AGENT_ROUNDS = 10;

const AGENT_TOOLS: LlmTool[] = [
  {
    name: 'read_sketch',
    description:
      'Read the current Arduino sketch source code. Use this to understand what the user already has before making changes.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'write_sketch',
    description:
      'Replace the entire Arduino sketch with new code. Always write complete, valid Arduino C++ with setup() and loop().',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'Complete Arduino sketch code to write.',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'get_compiler_output',
    description:
      'Get the most recent compiler error or warning output. Use this to diagnose and fix compilation errors.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'install_library',
    description:
      'Install an Arduino library by name. Searches the library registry and installs the best match.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Name of the library to install (e.g. "Adafruit NeoPixel").',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'verify_sketch',
    description:
      'Request that the IDE compile (verify) the current sketch. The result will be returned as the next message.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_board_info',
    description:
      'Get information about the currently selected board and serial port.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

@injectable()
export class AiAssistantServiceImpl implements AiAssistantService {
  @inject(LibraryService) @optional()
  private readonly libraryService: LibraryService | undefined;

  @inject(ILogger)
  private readonly logger: ILogger;

  private client: AiAssistantClient | undefined;
  private readonly activeCancellations = new Map<string, AbortController>();

  setClient(client: AiAssistantClient | undefined): void {
    this.client = client;
  }

  getClient(): AiAssistantClient | undefined {
    return this.client;
  }

  dispose(): void {
    // Cancel all in-flight agent loops
    for (const [, abort] of this.activeCancellations) {
      abort.abort();
    }
    this.activeCancellations.clear();
    this.client = undefined;
  }

  disposeClient(client: AiAssistantClient): void {
    if (this.client === client) {
      this.client = undefined;
    }
  }

  async sendMessage(request: AiChatRequest): Promise<void> {
    const { sessionId, userMessage, context } = request;
    const abort = new AbortController();
    this.activeCancellations.set(sessionId, abort);

    try {
      const provider = this.buildProvider(request);
      const systemPrompt = buildSystemPrompt(context);

      // Seed conversation history so the model remembers prior turns
      const messages: LlmMessage[] = [
        ...(request.history ?? []).map((h) => ({
          role: h.role as 'user' | 'assistant',
          content: h.content,
        })),
        { role: 'user', content: userMessage },
      ];

      let round = 0;
      while (round++ < MAX_AGENT_ROUNDS) {
        if (abort.signal.aborted) break;

        const assistantContentBlocks: LlmContentBlock[] = [];
        let hasToolUse = false;

        for await (const chunk of provider.streamChat(
          systemPrompt,
          messages,
          AGENT_TOOLS,
          request.model,
          abort.signal
        )) {
          if (abort.signal.aborted) break;

          if (chunk.type === 'text_delta' && chunk.textDelta) {
            this.emit(sessionId, { type: 'text', content: chunk.textDelta });
            // Accumulate for message history
            const last = assistantContentBlocks[assistantContentBlocks.length - 1];
            if (last?.type === 'text') {
              last.text += chunk.textDelta;
            } else {
              assistantContentBlocks.push({ type: 'text', text: chunk.textDelta });
            }
          } else if (chunk.type === 'tool_use_start') {
            hasToolUse = true;
            this.emit(sessionId, {
              type: 'tool_start',
              content: '',
              toolName: chunk.toolName,
            });
            assistantContentBlocks.push({
              type: 'tool_use',
              id: chunk.toolId ?? `tool-${Date.now()}`,
              name: chunk.toolName ?? '',
              input: chunk.toolInput ?? {},
            });
          } else if (chunk.type === 'tool_use_end' && chunk.toolInput) {
            // Update the last tool_use block with complete input
            const last = assistantContentBlocks[assistantContentBlocks.length - 1];
            if (last?.type === 'tool_use') {
              last.input = chunk.toolInput;
            }
          }
        }

        if (abort.signal.aborted) break;

        // Push assistant turn to history
        messages.push({ role: 'assistant', content: assistantContentBlocks });

        if (!hasToolUse) {
          this.emit(sessionId, { type: 'done', content: '' });
          break;
        }

        // Execute tool calls and gather results
        const toolResults: LlmToolResultBlock[] = [];
        for (const block of assistantContentBlocks) {
          if (block.type !== 'tool_use') continue;

          let result: string;
          try {
            result = await this.executeTool(
              block.name,
              block.input,
              context,
              sessionId
            );
          } catch (err) {
            result = `Error executing tool ${block.name}: ${err instanceof Error ? err.message : String(err)}`;
          }

          this.emit(sessionId, { type: 'tool_result', content: result });
          toolResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: result,
          });
        }

        // Push tool results as user turn
        messages.push({ role: 'tool', content: toolResults });

        // If any tool requested verify, we pause here — the frontend will
        // resume with the compiler output via a follow-up sendMessage call.
        const hasVerifyRequest = toolResults.some(
          (r) => r.content === '__VERIFY_REQUESTED__'
        );
        if (hasVerifyRequest) break;
      }

      if (round > MAX_AGENT_ROUNDS) {
        this.emit(sessionId, {
          type: 'error',
          content: 'Maximum agent steps reached. Please continue in a new message.',
        });
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        const message =
          err instanceof Error ? err.message : 'An unexpected error occurred.';
        this.emit(sessionId, { type: 'error', content: message });
        this.logger.error('[AiAssistant] sendMessage error', err);
      }
    } finally {
      this.activeCancellations.delete(sessionId);
    }
  }

  async cancelRequest(sessionId: string): Promise<void> {
    const abort = this.activeCancellations.get(sessionId);
    if (abort) {
      abort.abort();
      this.activeCancellations.delete(sessionId);
    }
  }

  private emit(sessionId: string, partial: Omit<AiStreamChunk, 'sessionId'>): void {
    this.client?.onStreamChunk({ sessionId, ...partial });
  }

  private buildProvider(request: AiChatRequest): LlmProvider {
    const { provider, apiKey, ollamaUrl } = request;
    switch (provider) {
      case 'github-models':
        return new OpenAICompatibleProvider(
          apiKey,
          'https://models.inference.ai.azure.com'
        );
      case 'openai':
        return new OpenAICompatibleProvider(apiKey);
      case 'ollama':
        return new OpenAICompatibleProvider(
          'ollama',
          ollamaUrl ?? 'http://localhost:11434/v1'
        );
      case 'anthropic':
        return new AnthropicProvider(apiKey);
      default:
        return new OpenAICompatibleProvider(
          apiKey,
          'https://models.inference.ai.azure.com'
        );
    }
  }

  private async executeTool(
    name: string,
    input: Record<string, unknown>,
    context: AiSketchContext,
    sessionId: string
  ): Promise<string> {
    switch (name) {
      case 'read_sketch':
        return context.sketchContent || '(empty sketch)';

      case 'write_sketch': {
        const code = input['code'] as string;
        if (!code || !context.sketchMainFilePath) {
          return 'Error: no sketch path available.';
        }
        const fsPath = FileUri.fsPath(context.sketchMainFilePath);
        await fs.promises.writeFile(fsPath, code, 'utf-8');
        // Notify frontend to reload the editor
        this.emit(sessionId, { type: 'sketch_updated', content: '' });
        return 'Sketch updated successfully.';
      }

      case 'get_compiler_output':
        return context.recentCompilerErrors || '(no recent compiler output)';

      case 'install_library': {
        const libName = input['name'] as string;
        if (!this.libraryService) {
          return 'Library installation is not available in this context.';
        }
        const results = await this.libraryService.search({ query: libName });
        if (!results.length) {
          return `Library "${libName}" not found in the registry.`;
        }
        // Pick the best match (exact name match first, then first result)
        const exact = results.find(
          (r) => r.name.toLowerCase() === libName.toLowerCase()
        );
        const pkg = exact ?? results[0];
        const version = pkg.availableVersions?.[0];
        await this.libraryService.install({ item: pkg, version });
        return `Library "${pkg.name}" ${version ?? ''} installed successfully.`;
      }

      case 'verify_sketch':
        // Signal to the frontend to run the verify command.
        // The frontend will send the compiler output back as a follow-up.
        return '__VERIFY_REQUESTED__';

      case 'get_board_info':
        return JSON.stringify({
          board: context.boardName ?? 'not selected',
          fqbn: context.boardFqbn ?? 'none',
          port: context.portAddress ?? 'not connected',
        });

      default:
        return `Unknown tool: ${name}`;
    }
  }
}

function buildSystemPrompt(ctx: AiSketchContext): string {
  const boardLine = ctx.boardName
    ? `Board: ${ctx.boardName} (FQBN: ${ctx.boardFqbn ?? 'unknown'})`
    : 'Board: not selected';
  const portLine = ctx.portAddress
    ? `Port: ${ctx.portAddress}`
    : 'Port: not connected';
  const sketchLine = ctx.sketchName
    ? `Sketch: ${ctx.sketchName}`
    : 'Sketch: unnamed';

  const sketchBlock = ctx.sketchContent
    ? `\`\`\`cpp\n${ctx.sketchContent}\n\`\`\``
    : '(empty sketch)';

  const errorsBlock = ctx.recentCompilerErrors
    ? `\nRecent compiler errors:\n\`\`\`\n${ctx.recentCompilerErrors}\n\`\`\``
    : '';

  return `You are an expert Arduino programming assistant embedded in the Arduino IDE 2.x desktop app.
You help users write, fix, and understand Arduino sketches.

Current context:
- ${sketchLine}
- ${boardLine}
- ${portLine}

Current sketch content:
${sketchBlock}
${errorsBlock}

You have tools available:
- read_sketch: read the current sketch
- write_sketch: replace the entire sketch with new code
- get_compiler_output: get recent compiler errors/warnings
- install_library: install a library by name
- verify_sketch: request compilation (compiler output returned in next message)
- get_board_info: get selected board and port info

Guidelines:
- Always write complete, valid Arduino C++ with setup() and loop() functions
- Include all required #include directives at the top
- When fixing errors, call get_compiler_output first to read the exact error messages
- When writing code that uses external libraries, call install_library first
- Be concise and explain what you changed
- Use standard Arduino API (pinMode, digitalWrite, analogRead, Serial, Wire, SPI, etc.)`;
}
