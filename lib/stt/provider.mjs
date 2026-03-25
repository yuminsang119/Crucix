// STT Provider — Base Class (mirrors lib/llm/provider.mjs pattern)
// Abstract interface for Speech-to-Text providers

export class STTProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = 'base';
  }

  /**
   * Transcribe audio to text
   * @param {Buffer|ArrayBuffer|Blob} audioData - raw audio bytes
   * @param {object} opts
   * @param {string} [opts.language='ko'] - language code
   * @param {number} [opts.timeout=90000] - timeout in ms
   * @param {string} [opts.format='wav'] - audio format hint
   * @returns {Promise<{ text: string, language: string, duration: number, segments: Array<{start:number,end:number,text:string}> }>}
   */
  async transcribe(audioData, opts = {}) {
    throw new Error(`${this.name}: transcribe() not implemented`);
  }

  get isConfigured() {
    return false;
  }
}
