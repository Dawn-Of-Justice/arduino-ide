import React from '@theia/core/shared/react';
import {
  injectable,
  inject,
  postConstruct,
} from '@theia/core/shared/inversify';
import { ReactWidget, Message } from '@theia/core/lib/browser/widgets';
import { DisposableCollection } from '@theia/core/lib/common/disposable';
import { JsonRpcProxy } from '@theia/core/lib/common/messaging/proxy-factory';
import { EditorManager } from '@theia/editor/lib/browser';
import {
  AiAssistantService,
  AiStreamChunk,
  AiSketchContext,
  AiChatRequest,
  AiProviderType,
  AiHistoryMessage,
} from '../../common/protocol/ai-assistant-service';
import {
  CurrentSketch,
  SketchesServiceClientImpl,
} from '../sketches-service-client-impl';
import { BoardsServiceProvider } from '../boards/boards-service-provider';
import {
  AiAssistantPreferences,
} from './ai-assistant-preferences';
import { PreferenceService } from '@theia/core/lib/browser/preferences';
import { AiAssistantClientImpl } from './ai-assistant-client-impl';

/**
 * Minimal markdown → React elements renderer.
 * Handles fenced code blocks, inline code, bold, italic, lists, and paragraphs.
 * Pure React/CJS — no external markdown library needed.
 */
function MarkdownContent({ children, className }: { children: string; className?: string }): React.ReactElement {
  const lines = children.split('\n');
  const elements: React.ReactElement[] = [];
  let i = 0;
  let keyCounter = 0;
  const nextKey = (): string => `md-${keyCounter++}`;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      elements.push(
        <pre key={nextKey()}>
          <code className={lang ? `language-${lang}` : undefined}>
            {codeLines.join('\n')}
          </code>
        </pre>
      );
      i++; // skip closing ```
      continue;
    }

    // Unordered list item
    if (/^[-*+]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*+]\s/.test(lines[i])) {
        items.push(lines[i].slice(2));
        i++;
      }
      elements.push(
        <ul key={nextKey()}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Ordered list item
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\d+\.\s/, ''));
        i++;
      }
      elements.push(
        <ol key={nextKey()}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Headings
    const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
    if (headingMatch) {
      const level = headingMatch[1].length as 1 | 2 | 3;
      const text = headingMatch[2];
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3';
      elements.push(<Tag key={nextKey()}>{renderInline(text)}</Tag>);
      i++;
      continue;
    }

    // Blank line — skip
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') && !/^[-*+]\s/.test(lines[i]) && !/^\d+\.\s/.test(lines[i])) {
      paraLines.push(lines[i]);
      i++;
    }
    elements.push(
      <p key={nextKey()}>{renderInline(paraLines.join(' '))}</p>
    );
  }

  return <div className={className}>{elements}</div>;
}

/** Convert inline markdown (bold, italic, inline code) to React nodes */
function renderInline(text: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  // Split on inline code, bold, italic in one pass
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      parts.push(text.slice(last, match.index));
    }
    const token = match[0];
    if (token.startsWith('`')) {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<em key={key++}>{token.slice(1, -1)}</em>);
    }
    last = match.index + token.length;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts.length === 1 ? parts[0] : parts;
}

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

@injectable()
export class AiAssistantWidget extends ReactWidget {
  static readonly ID = 'ai-assistant';
  static readonly LABEL = 'AI Assistant';

  @inject(AiAssistantService)
  private readonly aiService: JsonRpcProxy<AiAssistantService>;

  @inject(AiAssistantClientImpl)
  private readonly aiClient: AiAssistantClientImpl;

  @inject(SketchesServiceClientImpl)
  private readonly sketchServiceClient: SketchesServiceClientImpl;

  @inject(EditorManager)
  private readonly editorManager: EditorManager;

  @inject(BoardsServiceProvider)
  private readonly boardsServiceProvider: BoardsServiceProvider;

  @inject(AiAssistantPreferences)
  private readonly preferences: AiAssistantPreferences;

  @inject(PreferenceService)
  private readonly preferenceService: PreferenceService;

  private messages: ChatMessage[] = [];
  private streamingText = '';
  private toolCallText = '';
  private isStreaming = false;
  private currentSessionId = '';
  private inputValue = '';
  private lastCompilerErrorText = '';
  private currentMode: 'agent' | 'ask' | 'plan' = 'agent';

  private readonly toDisposeOnWidget = new DisposableCollection();
  private updateScheduled = false;
  private inputRef: HTMLTextAreaElement | null = null;
  private messagesEndRef: HTMLDivElement | null = null;

  constructor() {
    super();
    this.id = AiAssistantWidget.ID;
    this.title.label = AiAssistantWidget.LABEL;
    this.title.closable = true;
    this.scrollOptions = undefined;
  }

  @postConstruct()
  protected init(): void {
    console.log('[AiAssistant] postConstruct init called');
    this.toDispose.push(
      this.aiClient.onDidReceiveStreamChunk((chunk) =>
        this.handleChunk(chunk)
      )
    );
    this.update();
  }

  protected override onAfterAttach(msg: Message): void {
    super.onAfterAttach(msg);
    console.log('[AiAssistant] onAfterAttach — forcing update');
    this.update();
  }

  protected override onAfterShow(msg: Message): void {
    super.onAfterShow(msg);
    console.log('[AiAssistant] onAfterShow — forcing update');
    this.update();
  }

  protected override onActivateRequest(msg: Message): void {
    super.onActivateRequest(msg);
    this.inputRef?.focus();
  }

  protected override onCloseRequest(msg: Message): void {
    this.toDisposeOnWidget.dispose();
    super.onCloseRequest(msg);
  }

  /** Called by the view contribution to pass in fresh compiler errors */
  setLastCompilerErrors(text: string): void {
    this.lastCompilerErrorText = text;
  }

  /** Called by the view contribution when verify completes after AI requested it */
  reportVerifyResult(errors: string): void {
    if (!this.isStreaming) return;
    void this.continueWithVerifyResult(errors);
  }

  private async continueWithVerifyResult(errors: string): Promise<void> {
    const resultMessage = errors
      ? `Compiler output:\n\`\`\`\n${errors}\n\`\`\``
      : 'Compilation succeeded with no errors.';
    await this.doSendMessage(resultMessage);
  }

  private scrollToBottom(): void {
    this.messagesEndRef?.scrollIntoView({ behavior: 'smooth' });
  }

  private handleChunk(chunk: AiStreamChunk): void {
    if (chunk.sessionId !== this.currentSessionId) return;

    switch (chunk.type) {
      case 'text':
        this.streamingText += chunk.content;
        break;
      case 'tool_start':
        this.toolCallText = `⚙️ *Using tool: ${chunk.toolName}…*`;
        break;
      case 'tool_result':
        this.toolCallText = '';
        break;
      case 'done':
        this.messages.push({
          id: `${Date.now()}`,
          role: 'assistant',
          content: this.streamingText,
          timestamp: Date.now(),
        });
        this.streamingText = '';
        this.toolCallText = '';
        this.isStreaming = false;
        break;
      case 'error':
        this.messages.push({
          id: `${Date.now()}`,
          role: 'assistant',
          content: `⚠️ ${chunk.content}`,
          timestamp: Date.now(),
        });
        this.streamingText = '';
        this.toolCallText = '';
        this.isStreaming = false;
        break;
      case 'sketch_updated': {
        // Reload the active editor to reflect backend write
        const activeEditor = this.editorManager.currentEditor;
        if (activeEditor) {
          void activeEditor.editor.document.revert?.();
        }
        break;
      }
      case 'verify_request':
        // Handled by view contribution listening to this event
        break;
    }
    this.scheduleUpdate();
  }

  private scheduleUpdate(): void {
    if (this.updateScheduled) return;
    this.updateScheduled = true;
    requestAnimationFrame(() => {
      this.updateScheduled = false;
      this.update();
      // Scroll after React reconciles
      requestAnimationFrame(() => this.scrollToBottom());
    });
  }

  private async gatherContext(): Promise<AiSketchContext> {
    let sketchContent = '';
    let sketchName = '';
    let sketchMainFilePath = '';

    const sketch = await this.sketchServiceClient.currentSketch();
    if (CurrentSketch.isValid(sketch)) {
      sketchName = sketch.name;
      sketchMainFilePath = sketch.mainFileUri;
      // Get live editor content (includes unsaved changes)
      for (const editor of this.editorManager.all) {
        if (editor.editor.uri.toString() === sketch.mainFileUri) {
          sketchContent = editor.editor.document.getText();
          break;
        }
      }
      if (!sketchContent) {
        sketchContent = this.editorManager.currentEditor?.editor.document.getText() ?? '';
      }
    }

    const { selectedBoard, selectedPort } =
      this.boardsServiceProvider.boardsConfig;

    return {
      sketchContent,
      sketchName,
      sketchMainFilePath,
      boardFqbn: selectedBoard?.fqbn,
      boardName: selectedBoard?.name,
      portAddress: selectedPort?.address,
      recentCompilerErrors: this.lastCompilerErrorText,
    };
  }

  private getApiKey(): string {
    const provider = this.preferences['arduino.ai.provider'];
    switch (provider) {
      case 'github-models':
        return this.preferences['arduino.ai.githubToken'];
      case 'openai':
        return this.preferences['arduino.ai.openaiKey'];
      case 'anthropic':
        return this.preferences['arduino.ai.anthropicKey'];
      case 'ollama':
        return '';
      default:
        return '';
    }
  }

  private hasApiKey(): boolean {
    const provider = this.preferences['arduino.ai.provider'];
    if (provider === 'ollama') return true;
    return !!this.getApiKey();
  }

  /** Build the history array from the current messages list for multi-turn context. */
  private buildHistory(): AiHistoryMessage[] {
    // Keep last 20 turns (10 exchanges) to stay within token budgets
    const recent = this.messages.slice(-20);
    return recent.map((m) => ({ role: m.role, content: m.content }));
  }

  private async sendMessage(text: string): Promise<void> {
    if (!text.trim() || this.isStreaming) return;
    await this.doSendMessage(text);
  }

  private async doSendMessage(text: string): Promise<void> {
    this.currentSessionId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.messages.push({
      id: `${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now(),
    });
    this.streamingText = '';
    this.toolCallText = '';
    this.isStreaming = true;
    this.inputValue = '';
    this.scheduleUpdate();

    const context = await this.gatherContext();
    // Store for context chips in render
    (this as any)._lastSketchName = context.sketchName || undefined;
    (this as any)._lastBoardName = context.boardName || undefined;
    const request: AiChatRequest = {
      sessionId: this.currentSessionId,
      userMessage: text,
      history: this.buildHistory().slice(0, -1), // exclude the message we just pushed
      context,
      provider: this.preferences['arduino.ai.provider'] as AiProviderType,
      apiKey: this.getApiKey(),
      model: this.preferences['arduino.ai.model'],
      ollamaUrl: this.preferences['arduino.ai.ollamaUrl'],
      mode: this.currentMode,
    };

    await this.aiService.sendMessage(request);
  }

  private handleCancel(): void {
    if (this.currentSessionId) {
      void this.aiService.cancelRequest(this.currentSessionId);
      this.isStreaming = false;
      if (this.streamingText) {
        this.messages.push({
          id: `${Date.now()}`,
          role: 'assistant',
          content: this.streamingText + ' *(cancelled)*',
          timestamp: Date.now(),
        });
        this.streamingText = '';
        this.toolCallText = '';
      }
      this.scheduleUpdate();
    }
  }

  private handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void this.sendMessage(this.inputValue);
    }
  };

  private handleInputChange = (
    e: React.ChangeEvent<HTMLTextAreaElement>
  ): void => {
    this.inputValue = e.target.value;
    this.scheduleUpdate();
  };

  private handleSendClick = (): void => {
    if (this.isStreaming) {
      this.handleCancel();
    } else {
      void this.sendMessage(this.inputValue);
    }
  };

  private setInputRef = (el: HTMLTextAreaElement | null): void => {
    this.inputRef = el;
  };

  private setMessagesEndRef = (el: HTMLDivElement | null): void => {
    this.messagesEndRef = el;
  };

  private handleSuggestionClick = (text: string): void => {
    this.inputValue = text;
    void this.sendMessage(text);
  };

  private static readonly PROVIDER_MODELS: Record<string, string[]> = {
    'github-models': ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'DeepSeek-R1'],
    'openai': ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'gpt-4.1-mini', 'o3-mini', 'o4-mini'],
    'anthropic': ['claude-sonnet-4-5-20250514', 'claude-haiku-4-5-20251001', 'claude-sonnet-4-20250514'],
    'ollama': ['llama3.1', 'codellama', 'deepseek-coder-v2', 'qwen2.5-coder'],
  };

  private getModelsForProvider(prov: string): string[] {
    return AiAssistantWidget.PROVIDER_MODELS[prov] || ['gpt-4o'];
  }

  private handleModeChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    this.currentMode = e.target.value as 'agent' | 'ask' | 'plan';
    this.scheduleUpdate();
  };

  private handleModelChange = (e: React.ChangeEvent<HTMLSelectElement>): void => {
    void this.preferenceService.set('arduino.ai.model', e.target.value, undefined);
    this.scheduleUpdate();
  };

  private handleClearChat = (): void => {
    if (this.isStreaming) return;
    this.messages = [];
    this.streamingText = '';
    this.toolCallText = '';
    this.scheduleUpdate();
  };

  protected render(): React.ReactNode {
    console.log('[AiAssistant] render() called');
    try {
      return this.renderWidget();
    } catch (err) {
      return (
        <div style={{ padding: '16px', color: '#f44', fontFamily: 'monospace', fontSize: '12px', whiteSpace: 'pre-wrap' }}>
          {'AI Assistant render error:\n' + String(err)}
        </div>
      );
    }
  }

  private renderWidget(): React.ReactNode {
    const noKey = !this.hasApiKey();
    const provider = this.preferences['arduino.ai.provider'];

    // Gather chip info from last context (stored on send; approximate from sketch client)
    const currentSketchName = (this as any)._lastSketchName as string | undefined;
    const currentBoard = (this as any)._lastBoardName as string | undefined;

    const suggestions = [
      'Explain what this sketch does',
      'Fix any compile errors',
      'Add a button debounce function',
    ];

    return (
      <div className="ai-assistant-widget">
        {/* ── Header ── */}
        <div className="ai-assistant-header">
          <span className="ai-assistant-header-title">Arduino AI</span>
          <div className="ai-assistant-header-actions">
            <button
              className="ai-assistant-icon-btn"
              title="New chat"
              onClick={this.handleClearChat}
              disabled={this.isStreaming || this.messages.length === 0}
            >
              {/* pencil / new chat icon */}
              ✏
            </button>
          </div>
        </div>

        {/* ── Messages ── */}
        <div className="ai-assistant-messages">
          {this.messages.length === 0 && !this.isStreaming ? (
            <div className="ai-assistant-empty">
              <div className="ai-assistant-empty-icon">⚡</div>
              <div className="ai-assistant-empty-title">Arduino AI Assistant</div>
              <div className="ai-assistant-empty-subtitle">
                Ask me to write code, fix errors, explain your sketch, or install libraries.
              </div>
              {!noKey && (
                <div className="ai-assistant-suggestions">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      className="ai-assistant-suggestion"
                      onClick={() => this.handleSuggestionClick(s)}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
            <>
              {this.messages.map((msg) => (
                <div key={msg.id} className={`ai-assistant-message ${msg.role}`}>
                  {msg.role === 'user' ? (
                    <div className="ai-assistant-user-bubble">{msg.content}</div>
                  ) : (
                    <div className="ai-assistant-assistant-row">
                      <div className="ai-assistant-avatar">AI</div>
                      <div className="ai-assistant-assistant-body">
                        <MarkdownContent className="ai-assistant-markdown">
                          {msg.content}
                        </MarkdownContent>
                      </div>
                    </div>
                  )}
                </div>
              ))}

              {this.isStreaming && (
                <div className="ai-assistant-message assistant">
                  <div className="ai-assistant-assistant-row">
                    <div className="ai-assistant-avatar">AI</div>
                    <div className="ai-assistant-assistant-body">
                      {this.toolCallText && (
                        <div className="ai-assistant-tool-badge">
                          ⚙ {this.toolCallText.replace(/^⚙️ \*Using tool: /, '').replace(/…\*$/, '')}
                        </div>
                      )}
                      {this.streamingText ? (
                        <>
                          <MarkdownContent className="ai-assistant-markdown">
                            {this.streamingText}
                          </MarkdownContent>
                          <span className="ai-assistant-streaming-cursor" />
                        </>
                      ) : (
                        !this.toolCallText && <span className="ai-assistant-streaming-cursor" />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
          <div ref={this.setMessagesEndRef} />
        </div>

        {/* ── No key warning ── */}
        {noKey && (
          <div className="ai-assistant-no-key">
            No API key for <strong>{provider}</strong>. Open{' '}
            <em>File → Preferences → Settings</em> and configure{' '}
            <code>arduino.ai.*</code>.
          </div>
        )}

        {/* ── Context chips ── */}
        {(currentSketchName || currentBoard) && (
          <div className="ai-assistant-context-strip">
            {currentSketchName && (
              <span className="ai-assistant-context-chip" title={currentSketchName}>
                📄 {currentSketchName}
              </span>
            )}
            {currentBoard && (
              <span className="ai-assistant-context-chip" title={currentBoard}>
                🔌 {currentBoard}
              </span>
            )}
          </div>
        )}

        {/* ── Input ── */}
        <div className="ai-assistant-input-area">
          <div className="ai-assistant-input-box">
            <textarea
              ref={this.setInputRef}
              className="ai-assistant-input"
              placeholder={
                noKey
                  ? 'Configure API key in settings first…'
                  : this.currentMode === 'agent'
                  ? 'Ask to write code, fix errors, install libraries…'
                  : this.currentMode === 'ask'
                  ? 'Ask a question about your code…'
                  : 'Describe what you want to plan…'
              }
              value={this.inputValue}
              onChange={this.handleInputChange}
              onKeyDown={this.handleKeyDown}
              disabled={noKey}
              rows={2}
            />
            <div className="ai-assistant-input-toolbar">
              <div className="ai-assistant-model-selector">
                <select
                  className="ai-assistant-mode-select"
                  value={this.currentMode}
                  onChange={this.handleModeChange}
                  title="Mode"
                >
                  <option value="agent">⚡ Agent</option>
                  <option value="ask">💬 Ask</option>
                  <option value="plan">📋 Plan</option>
                </select>
                <select
                  className="ai-assistant-model-select"
                  value={this.preferences['arduino.ai.model'] || 'gpt-4o'}
                  onChange={this.handleModelChange}
                  title="Model"
                >
                  {this.getModelsForProvider(provider).map((m) => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
              <button
                className={`ai-assistant-send-btn${this.isStreaming ? ' cancel' : ''}`}
                onClick={this.handleSendClick}
                disabled={noKey && !this.isStreaming}
              >
                {this.isStreaming ? '⏹ Stop' : 'Send'}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }
}
