// OpenAI Whisper STT Provider
// Uses OpenAI Audio API: POST /v1/audio/transcriptions
// Node 22 native FormData + Blob (no external dependencies)

import { STTProvider } from './provider.mjs';

export class OpenAISTTProvider extends STTProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai-whisper';
    this.apiKey = config.apiKey;
    this.model = config.model || 'whisper-1';
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  }

  get isConfigured() {
    return !!this.apiKey;
  }

  async transcribe(audioData, opts = {}) {
    if (!this.isConfigured) throw new Error('OpenAI STT not configured — STT_API_KEY missing');

    const language = opts.language || 'ko';
    const timeout = opts.timeout || 90000;
    const format = opts.format || 'wav';

    // Build multipart/form-data using Node 22 native FormData
    const formData = new FormData();

    // Convert Buffer to Blob if needed
    const blob = audioData instanceof Blob
      ? audioData
      : new Blob([audioData], { type: `audio/${format}` });

    formData.append('file', blob, `audio.${format}`);
    formData.append('model', this.model);
    formData.append('language', language);
    formData.append('response_format', 'verbose_json'); // includes timestamps

    const res = await fetch(`${this.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: formData,
      signal: AbortSignal.timeout(timeout),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`Whisper API error ${res.status}: ${errText.substring(0, 200)}`);
    }

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
}
