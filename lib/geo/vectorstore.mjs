// Address Vector Store — Lightweight fuzzy matching for Korean addresses
// Uses character n-gram frequency vectors + cosine similarity
// No external dependencies — pure JavaScript implementation

/**
 * Build character n-gram frequency vector from Korean text
 * @param {string} text - address or location name
 * @param {number[]} [ngramSizes=[2,3]] - n-gram sizes to use
 * @returns {Map<string, number>} frequency map
 */
export function buildNgramVector(text, ngramSizes = [2, 3]) {
  const vec = new Map();
  if (!text) return vec;

  // Normalize: lowercase, remove spaces/punctuation, keep Korean + digits
  const normalized = text.replace(/\s+/g, '').replace(/[^\uAC00-\uD7AF\u3131-\u3163\u1100-\u11FF0-9a-zA-Z]/g, '');

  for (const n of ngramSizes) {
    for (let i = 0; i <= normalized.length - n; i++) {
      const gram = normalized.substring(i, i + n);
      vec.set(gram, (vec.get(gram) || 0) + 1);
    }
  }

  return vec;
}

/**
 * Cosine similarity between two n-gram vectors
 * @param {Map<string, number>} vecA
 * @param {Map<string, number>} vecB
 * @returns {number} 0.0 - 1.0
 */
export function cosineSimilarity(vecA, vecB) {
  if (!vecA.size || !vecB.size) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (const [key, valA] of vecA) {
    normA += valA * valA;
    const valB = vecB.get(key) || 0;
    dotProduct += valA * valB;
  }

  for (const [, valB] of vecB) {
    normB += valB * valB;
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom > 0 ? dotProduct / denom : 0;
}

/**
 * Address Vector Store for fuzzy matching
 * Indexes known locations and finds nearest matches for caller descriptions
 */
export class AddressVectorStore {
  constructor() {
    this.locations = [];    // { name, address, lat, lon, type, vector }
    this.loaded = false;
  }

  /**
   * Load known locations into the vector store
   * @param {Array<{name: string, address: string, lat: number, lon: number, type: string}>} locations
   */
  load(locations) {
    this.locations = locations
      .filter(loc => loc.address || loc.name)
      .map(loc => ({
        ...loc,
        // Build vector from combined name + address for best matching
        vector: buildNgramVector(`${loc.name || ''} ${loc.address || ''}`),
      }));
    this.loaded = true;
    return this.locations.length;
  }

  /**
   * Find nearest matching locations for a query address
   * @param {string} queryAddress - caller's address description
   * @param {number} [topK=5] - max results
   * @param {number} [threshold=0.3] - minimum similarity
   * @returns {Array<{name, address, lat, lon, type, similarity}>}
   */
  findNearest(queryAddress, topK = 5, threshold = 0.3) {
    if (!this.loaded || !queryAddress) return [];

    const queryVec = buildNgramVector(queryAddress);
    if (!queryVec.size) return [];

    const scored = this.locations
      .map(loc => ({
        name: loc.name,
        address: loc.address,
        lat: loc.lat,
        lon: loc.lon,
        type: loc.type,
        similarity: cosineSimilarity(queryVec, loc.vector),
      }))
      .filter(s => s.similarity >= threshold)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    return scored;
  }

  /**
   * Get the best match above threshold
   * @param {string} queryAddress
   * @param {number} [threshold=0.5]
   * @returns {object|null}
   */
  bestMatch(queryAddress, threshold = 0.5) {
    const results = this.findNearest(queryAddress, 1, threshold);
    return results.length > 0 ? results[0] : null;
  }

  /**
   * Get store statistics
   */
  get stats() {
    const byType = {};
    for (const loc of this.locations) {
      const type = loc.type || 'unknown';
      byType[type] = (byType[type] || 0) + 1;
    }
    return {
      totalLocations: this.locations.length,
      byType,
      loaded: this.loaded,
    };
  }
}
