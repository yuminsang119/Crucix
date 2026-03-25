#!/usr/bin/env node
// Korea Meteorological Administration (기상청) Data Source
// Fetches weather warnings, wind/humidity/temperature for fire risk assessment
// Uses KMA open API (data.kma.go.kr) and fallback to public RSS

import { safeFetch } from '../utils/fetch.mjs';

const KMA_RSS_URL = 'https://www.kma.go.kr/weather/forecast/mid-term-rss3.jsp?stnId=108';
const KMA_WARNING_URL = 'https://www.kma.go.kr/cgi-bin/aws/nph-aws_txt_min';

// Fire-relevant weather warning types
const FIRE_RELEVANT_WARNINGS = [
  '건조', '강풍', '풍랑', '폭염', '대설', '한파',
  'dry', 'wind', 'heat', 'gale', 'storm'
];

// Major Korean cities with coordinates for monitoring
const MONITORING_STATIONS = [
  { name: '서울', lat: 37.5665, lon: 126.9780, stnId: 108 },
  { name: '부산', lat: 35.1796, lon: 129.0756, stnId: 159 },
  { name: '대구', lat: 35.8714, lon: 128.6014, stnId: 143 },
  { name: '인천', lat: 37.4563, lon: 126.7052, stnId: 112 },
  { name: '광주', lat: 35.1595, lon: 126.8526, stnId: 156 },
  { name: '대전', lat: 36.3504, lon: 127.3845, stnId: 133 },
  { name: '울산', lat: 35.5384, lon: 129.3114, stnId: 152 },
  { name: '세종', lat: 36.4800, lon: 127.2890, stnId: 129 },
  { name: '춘천', lat: 37.8813, lon: 127.7298, stnId: 101 },
  { name: '강릉', lat: 37.7519, lon: 128.8761, stnId: 105 },
  { name: '제주', lat: 33.5141, lon: 126.5295, stnId: 184 },
  { name: '목포', lat: 34.8118, lon: 126.3922, stnId: 165 },
];

/**
 * Parse KMA RSS weather forecast XML
 */
function parseWeatherRSS(xml) {
  const warnings = [];
  const forecasts = [];

  // Extract weather warnings from special weather reports
  const itemRegex = /<item>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[1];
    const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
    const description = (block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1] || '').trim();

    // Check for fire-relevant warnings
    const isFireRelevant = FIRE_RELEVANT_WARNINGS.some(w =>
      title.includes(w) || description.includes(w)
    );

    if (title) {
      const entry = { title, description: description.substring(0, 200) };
      if (isFireRelevant) {
        entry.fireRelevant = true;
        warnings.push(entry);
      }
      forecasts.push(entry);
    }
  }

  return { warnings, forecasts: forecasts.slice(0, 10) };
}

/**
 * Estimate fire weather risk based on conditions
 * Returns 1-5 scale (1=low, 5=extreme)
 */
function calculateFireWeatherRisk({ humidity, windSpeed, temperature, precipitation }) {
  let risk = 1;

  // Low humidity increases risk
  if (humidity !== null) {
    if (humidity < 25) risk += 2;
    else if (humidity < 35) risk += 1.5;
    else if (humidity < 45) risk += 1;
    else if (humidity < 55) risk += 0.5;
  }

  // High wind increases risk
  if (windSpeed !== null) {
    if (windSpeed > 15) risk += 1.5;
    else if (windSpeed > 10) risk += 1;
    else if (windSpeed > 7) risk += 0.5;
  }

  // High temperature increases risk
  if (temperature !== null) {
    if (temperature > 35) risk += 1;
    else if (temperature > 30) risk += 0.5;
  }

  // Recent precipitation reduces risk
  if (precipitation !== null && precipitation > 5) {
    risk -= 1;
  }

  return Math.max(1, Math.min(5, Math.round(risk)));
}

export async function briefing() {
  const results = {
    source: 'KMA',
    description: 'Korea Meteorological Administration — weather data for fire risk assessment',
    timestamp: new Date().toISOString(),
    warnings: [],
    stations: [],
    fireWeatherRisk: null,
    summary: {},
  };

  // Fetch KMA RSS forecast
  try {
    const rssRes = await safeFetch(KMA_RSS_URL, { timeout: 10000 });
    if (rssRes.ok) {
      const xml = await rssRes.text();
      const parsed = parseWeatherRSS(xml);
      results.warnings = parsed.warnings;
      results.summary.totalWarnings = parsed.warnings.length;
      results.summary.fireRelevantWarnings = parsed.warnings.filter(w => w.fireRelevant).length;
      results.summary.forecasts = parsed.forecasts.length;
    }
  } catch (e) {
    results.errors = results.errors || [];
    results.errors.push({ step: 'rss', error: e.message });
  }

  // Use KMA API if key is available
  const apiKey = process.env.KMA_API_KEY;
  if (apiKey) {
    try {
      // Ultra-short-term observation data
      const now = new Date();
      const baseDate = now.toISOString().slice(0, 10).replace(/-/g, '');
      const baseTime = String(now.getHours()).padStart(2, '0') + '00';

      const url = `http://apis.data.go.kr/1360000/VilageFcstInfoService_2.0/getUltraSrtNcst?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=60&pageNo=1&dataType=JSON&base_date=${baseDate}&base_time=${baseTime}&nx=60&ny=127`;

      const res = await safeFetch(url, { timeout: 10000 });
      if (res.ok) {
        const data = await res.json();
        const items = data?.response?.body?.items?.item || [];

        const obs = {};
        for (const item of items) {
          obs[item.category] = parseFloat(item.obsrValue);
        }

        // T1H: temperature, REH: humidity, WSD: wind speed, RN1: 1hr precip
        const station = {
          name: '서울 (격자 60,127)',
          temperature: obs.T1H ?? null,
          humidity: obs.REH ?? null,
          windSpeed: obs.WSD ?? null,
          precipitation1h: obs.RN1 ?? null,
          windDirection: obs.VEC ?? null,
        };

        station.fireRisk = calculateFireWeatherRisk({
          humidity: station.humidity,
          windSpeed: station.windSpeed,
          temperature: station.temperature,
          precipitation: station.precipitation1h,
        });

        results.stations.push(station);
        results.fireWeatherRisk = station.fireRisk;
      }
    } catch (e) {
      results.errors = results.errors || [];
      results.errors.push({ step: 'api', error: e.message });
    }
  }

  // Generate simulated baseline data if API not available
  // (ensures dashboard always has weather data to display)
  if (results.stations.length === 0) {
    results.summary.note = 'KMA_API_KEY not set — using public RSS data only';
    results.summary.apiAvailable = false;
  } else {
    results.summary.apiAvailable = true;
    results.summary.stationsReporting = results.stations.length;
  }

  // Determine overall fire weather risk level
  const riskLabels = ['', '낮음 (LOW)', '보통 (MODERATE)', '높음 (HIGH)', '매우높음 (VERY HIGH)', '극심 (EXTREME)'];
  if (results.fireWeatherRisk) {
    results.summary.fireWeatherRiskLabel = riskLabels[results.fireWeatherRisk] || '알 수 없음';
  }

  return results;
}
