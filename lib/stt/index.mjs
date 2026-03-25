// STT Factory — mirrors lib/llm/index.mjs pattern
// Creates STT provider based on configuration

import { OpenAISTTProvider } from './openai.mjs';
import { OllamaSTTProvider } from './ollama.mjs';

export { STTProvider } from './provider.mjs';
export { OpenAISTTProvider } from './openai.mjs';
export { OllamaSTTProvider } from './ollama.mjs';
export { extractCallInfo, extractCallInfoRegex } from './extractor.mjs';
export { scoreCall, PRIORITY_LEVELS } from './scorer.mjs';

/**
 * Create an STT provider based on config
 * @param {object} sttConfig - { provider, apiKey, model, baseUrl }
 * @returns {import('./provider.mjs').STTProvider|null}
 */
export function createSTTProvider(sttConfig) {
  if (!sttConfig?.provider) return null;

  const provider = sttConfig.provider.toLowerCase().trim();

  switch (provider) {
    case 'openai':
    case 'openai-whisper':
    case 'whisper':
      return new OpenAISTTProvider({
        apiKey: sttConfig.apiKey,
        model: sttConfig.model,
        baseUrl: sttConfig.baseUrl,
      });

    case 'ollama':
    case 'ollama-whisper':
    case 'local':
      return new OllamaSTTProvider({
        model: sttConfig.model,
        baseUrl: sttConfig.baseUrl,
      });

    default:
      console.warn(`[STT] Unknown provider "${sttConfig.provider}". STT disabled.`);
      return null;
  }
}
