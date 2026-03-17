import {
  PreferenceContribution,
  PreferenceProxy,
  PreferenceSchema,
  PreferenceService,
  createPreferenceProxy,
} from '@theia/core/lib/browser/preferences';
import { interfaces } from '@theia/core/shared/inversify';
import type { AiProviderType } from '../../common/protocol/ai-assistant-service';

export const aiAssistantPreferenceSchema: PreferenceSchema = {
  type: 'object',
  properties: {
    'arduino.ai.provider': {
      type: 'string',
      enum: ['github-models', 'openai', 'anthropic', 'ollama'],
      default: 'github-models',
      description:
        'LLM provider for the AI Assistant. "github-models" is free with a GitHub account.',
    },
    'arduino.ai.githubToken': {
      type: 'string',
      default: '',
      description:
        'GitHub Personal Access Token (models:read scope) for GitHub Models provider.',
    },
    'arduino.ai.anthropicKey': {
      type: 'string',
      default: '',
      description: 'Anthropic API key for the Claude provider.',
    },
    'arduino.ai.openaiKey': {
      type: 'string',
      default: '',
      description: 'OpenAI API key for the OpenAI provider.',
    },
    'arduino.ai.ollamaUrl': {
      type: 'string',
      default: 'http://localhost:11434/v1',
      description: 'Base URL for a local Ollama server.',
    },
    'arduino.ai.model': {
      type: 'string',
      default: 'gpt-4o',
      description:
        'Model name to use with the selected provider (e.g. gpt-4o, claude-sonnet-4-5, llama3).',
    },
  },
};

export interface AiAssistantConfiguration {
  'arduino.ai.provider': AiProviderType;
  'arduino.ai.githubToken': string;
  'arduino.ai.anthropicKey': string;
  'arduino.ai.openaiKey': string;
  'arduino.ai.ollamaUrl': string;
  'arduino.ai.model': string;
}

export const AiAssistantPreferences = Symbol('AiAssistantPreferences');
export type AiAssistantPreferences = PreferenceProxy<AiAssistantConfiguration>;

export function createAiAssistantPreferences(
  preferences: PreferenceService
): AiAssistantPreferences {
  return createPreferenceProxy(preferences, aiAssistantPreferenceSchema);
}

export function bindAiAssistantPreferences(bind: interfaces.Bind): void {
  bind(AiAssistantPreferences).toDynamicValue((ctx) => {
    const preferences = ctx.container.get<PreferenceService>(PreferenceService);
    return createAiAssistantPreferences(preferences);
  });
  bind(PreferenceContribution).toConstantValue({
    schema: aiAssistantPreferenceSchema,
  });
}
