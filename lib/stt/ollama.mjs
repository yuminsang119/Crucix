// Ollama Local Whisper STT Provider
// Uses Ollama's audio transcription endpoint (local, no API key needed)

import { STTProvider } from './provider.mjs';

export class OllamaSTTProvider extends STTProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'ollama-whisper';
    this.model = config.model || 'whisper:large-v3';
    this.baseUrl = (config.baseUrl || 'http://localhost:11434').replace(/\/$/, '');
  }

  get isConfigured() {
    return !!this.baseUrl;
  }

  async transcribe(audioData, opts = {}) {
    if (!this.isConfigured) throw new Error('Ollama STT not configured');

    const language = opts.language || 'ko';
    const timeout = opts.timeout || 120000; // longer timeout for local processing
    const format = opts.format || 'wav';

    // Try Ollama's OpenAI-compatible endpoint first
    const formData = new FormData();
    const blob = audioData instanceof Blob
      ? audioData
      : new Blob([audioData], { type: `audio/${format}` });

    formData.append('file', blob, `audio.${format}`);
    formData.append('model', this.model);
    formData.append('language', language);
    formData.append('response_format', 'verbose_json');

    try {
      const res = await fetch(`${this.baseUrl}/v1/audio/transcriptions`, {
        method: 'POST',
        body: formData,
        signal: AbortSignal.timeout(timeout),
      });

      if (res.ok) {
        const data = await res.json();
        return {
          text: data.text || '',
          language: data.language || language,
          duration: data.duration || 0,
          segments: (data.segments || []).map(s => ({
            start: s.start,
            end: s.end,
            text: s.text,
          })),
        };
      }
    } catch {
      // OpenAI-compatible endpoint not available, try native Ollama
    }

    // Fallback: Ollama native API with base64 audio
    const buffer = audioData instanceof Buffer ? audioData
      : audioData instanceof ArrayBuffer ? Buffer.from(audioData)
      : Buffer.from(await audioData.arrayBuffer());

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt: `Transcribe the following audio in Korean (${language}):`,
        images: [buffer.toString('base64')], // Ollama uses 'images' field for binary data
        stream: false,
      }),
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Ollama STT error ${res.status}: ${errText.substring(0, 200)}`);
    }

    const data = await res.json();
    return {
      text: data.response || '',
      language,
      duration: 0,
      segments: [],
    };
  }
}
