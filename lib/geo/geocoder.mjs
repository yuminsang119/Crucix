// Korean Address Geocoder — Address → Coordinates
// 3-tier fallback: Kakao → VWorld → Naver
// All providers optional, uses safeFetch pattern

import { safeFetch } from '../../apis/utils/fetch.mjs';

// In-memory cache to avoid redundant API calls
const geocodeCache = new Map();
const CACHE_MAX_SIZE = 1000;

/**
 * Score address confidence based on specificity
 * @param {string} address
 * @param {object} [parts] - parsed address parts
 * @returns {number} 0.0 - 1.0
 */
export function scoreAddressConfidence(address, parts = {}) {
  if (!address) return 0.0;

  // Road name + building number → highest confidence
  if (/[가-힣]+(?:로|길)\s*\d+/.test(address)) return 1.0;

  // Dong + jibun number
  if (/[가-힣]+동\s*\d+/.test(address)) return 0.9;

  // Has sigungu + dong
  if (parts.sigungu && parts.dong) return 0.7;

  // Dong name only
  if (/[가-힣]+동/.test(address)) return 0.6;

  // Building/landmark name
  if (/[가-힣]+(?:빌딩|아파트|타워|센터|상가|공장|학교|병원)/.test(address)) return 0.5;

  // Sigungu only
  if (parts.sigungu) return 0.4;

  // Sido only
  if (parts.sido) return 0.3;

  // Vague description
  if (/근처|쪽|부근|앞|뒤|옆/.test(address)) return 0.2;

  return 0.15;
}

/**
 * Geocode address via Kakao Local API
 */
async function geocodeKakao(address, apiKey) {
  const url = `https://dapi.kakao.com/v2/local/search/address.json?query=${encodeURIComponent(address)}`;

  const res = await safeFetch(url, {
    timeout: 10000,
    headers: { Authorization: `KakaoAK ${apiKey}` },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const doc = data?.documents?.[0];
  if (!doc) return null;

  return {
    provider: 'kakao',
    lat: parseFloat(doc.y),
    lon: parseFloat(doc.x),
    roadAddress: doc.road_address?.address_name || null,
    jibunAddress: doc.address?.address_name || null,
    addressType: doc.address_type,
  };
}

/**
 * Geocode address via VWorld API
 */
async function geocodeVWorld(address, apiKey) {
  const url = `https://api.vworld.kr/req/address?service=address&request=getcoord&version=2.0&crs=epsg:4326&refine=true&simple=false&format=json&type=ROAD&key=${apiKey}&address=${encodeURIComponent(address)}`;

  const res = await safeFetch(url, { timeout: 10000 });
  if (!res.ok) return null;

  const data = await res.json();
  const result = data?.response?.result;
  if (!result?.point) return null;

  return {
    provider: 'vworld',
    lat: parseFloat(result.point.y),
    lon: parseFloat(result.point.x),
    roadAddress: address,
    jibunAddress: null,
    addressType: 'ROAD',
  };
}

/**
 * Geocode address via Naver Map API
 */
async function geocodeNaver(address, clientId, clientSecret) {
  const url = `https://naveropenapi.apigw.ntruss.com/map-geocode/v2/geocode?query=${encodeURIComponent(address)}`;

  const res = await safeFetch(url, {
    timeout: 10000,
    headers: {
      'X-NCP-APIGW-API-KEY-ID': clientId,
      'X-NCP-APIGW-API-KEY': clientSecret,
    },
  });

  if (!res.ok) return null;

  const data = await res.json();
  const addr = data?.addresses?.[0];
  if (!addr) return null;

  return {
    provider: 'naver',
    lat: parseFloat(addr.y),
    lon: parseFloat(addr.x),
    roadAddress: addr.roadAddress || null,
    jibunAddress: addr.jibunAddress || null,
    addressType: 'ROAD',
  };
}

/**
 * Geocode a Korean address — tries Kakao → VWorld → Naver
 * @param {string} address - Korean address string
 * @param {object} [geoConfig] - { kakaoApiKey, vworldApiKey, naverMapClientId, naverMapClientSecret }
 * @returns {Promise<{lat, lon, confidence, provider, roadAddress, jibunAddress}|null>}
 */
export async function geocodeAddress(address, geoConfig = {}) {
  if (!address) return null;

  // Check cache
  const cacheKey = address.trim().toLowerCase();
  if (geocodeCache.has(cacheKey)) {
    return geocodeCache.get(cacheKey);
  }

  let result = null;

  // Try Kakao
  if (!result && geoConfig.kakaoApiKey) {
    try {
      result = await geocodeKakao(address, geoConfig.kakaoApiKey);
    } catch (e) {
      console.error('[Geocoder] Kakao failed:', e.message);
    }
  }

  // Try VWorld
  if (!result && geoConfig.vworldApiKey) {
    try {
      result = await geocodeVWorld(address, geoConfig.vworldApiKey);
    } catch (e) {
      console.error('[Geocoder] VWorld failed:', e.message);
    }
  }

  // Try Naver
  if (!result && geoConfig.naverMapClientId && geoConfig.naverMapClientSecret) {
    try {
      result = await geocodeNaver(address, geoConfig.naverMapClientId, geoConfig.naverMapClientSecret);
    } catch (e) {
      console.error('[Geocoder] Naver failed:', e.message);
    }
  }

  if (!result) return null;

  // Add confidence score
  const confidence = scoreAddressConfidence(address);
  const enriched = { ...result, confidence, originalAddress: address };

  // Cache result (with size limit)
  if (geocodeCache.size >= CACHE_MAX_SIZE) {
    const firstKey = geocodeCache.keys().next().value;
    geocodeCache.delete(firstKey);
  }
  geocodeCache.set(cacheKey, enriched);

  return enriched;
}

/**
 * Check if any geocoding provider is configured
 */
export function isGeocoderConfigured(geoConfig = {}) {
  return !!(geoConfig.kakaoApiKey || geoConfig.vworldApiKey ||
    (geoConfig.naverMapClientId && geoConfig.naverMapClientSecret));
}
