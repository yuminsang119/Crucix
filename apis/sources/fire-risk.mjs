#!/usr/bin/env node
// Korean Fire Risk Index & Forest Fire Information
// Sources: Korea Forest Service (산림청) wildfire data, public disaster alerts
// Uses data.go.kr open APIs + fallback to public RSS

import { safeFetch } from '../utils/fetch.mjs';

// Korean provinces with forest fire risk monitoring
const PROVINCES = [
  { code: '11', name: '서울', lat: 37.5665, lon: 126.978 },
  { code: '26', name: '부산', lat: 35.1796, lon: 129.076 },
  { code: '27', name: '대구', lat: 35.8714, lon: 128.601 },
  { code: '28', name: '인천', lat: 37.4563, lon: 126.705 },
  { code: '29', name: '광주', lat: 35.1595, lon: 126.853 },
  { code: '30', name: '대전', lat: 36.3504, lon: 127.385 },
  { code: '31', name: '울산', lat: 35.5384, lon: 129.311 },
  { code: '36', name: '세종', lat: 36.48, lon: 127.289 },
  { code: '41', name: '경기', lat: 37.275, lon: 127.01 },
  { code: '42', name: '강원', lat: 37.885, lon: 127.73 },
  { code: '43', name: '충북', lat: 36.635, lon: 127.49 },
  { code: '44', name: '충남', lat: 36.559, lon: 126.8 },
  { code: '45', name: '전북', lat: 35.82, lon: 127.108 },
  { code: '46', name: '전남', lat: 34.816, lon: 126.463 },
  { code: '47', name: '경북', lat: 36.248, lon: 128.664 },
  { code: '48', name: '경남', lat: 35.46, lon: 128.216 },
  { code: '50', name: '제주', lat: 33.489, lon: 126.498 },
];

// Disaster alert types relevant to fire
const FIRE_ALERT_KEYWORDS = [
  '화재', '산불', '폭발', '위험물', '가스누출',
  'fire', 'wildfire', 'explosion', 'hazmat', 'gas leak'
];

/**
 * Fetch Korean disaster safety alerts (재난안전 알림)
 * Uses public disaster message API
 */
async function fetchDisasterAlerts() {
  const alerts = [];

  // Try disaster message RSS
  try {
    const url = 'https://www.safekorea.go.kr/idsiSFK/sfk/cs/sfc/rss/emergRss.do';
    const res = await safeFetch(url, { timeout: 10000 });
    if (res.ok) {
      const xml = await res.text();
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const block = match[1];
        const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
        const description = (block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1] || '').trim();
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';

        const isFireRelated = FIRE_ALERT_KEYWORDS.some(k =>
          title.includes(k) || description.includes(k)
        );

        if (title) {
          alerts.push({
            title,
            description: description.substring(0, 300),
            date: pubDate,
            fireRelated: isFireRelated,
            severity: isFireRelated ? 'HIGH' : 'NORMAL',
          });
        }
      }
    }
  } catch (e) {
    // SafeKorea RSS may be intermittent
  }

  return alerts;
}

/**
 * Fetch forest fire danger index from Korea Forest Service
 */
async function fetchForestFireRisk() {
  const apiKey = process.env.FOREST_FIRE_API_KEY || process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'FOREST_FIRE_API_KEY or DATA_GO_KR_API_KEY not set' };
  }

  try {
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const url = `http://apis.data.go.kr/1400000/forestFireDangerInfoService/forestFireDangerInfo?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=20&pageNo=1&dataType=JSON&date=${today}`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      const items = data?.response?.body?.items?.item || [];

      return {
        available: true,
        date: today,
        regions: items.map(item => ({
          province: item.doNm || item.sidoNm || '알 수 없음',
          riskIndex: item.dngGrd || item.dangerGrade || null,
          riskLevel: item.dngGrdNm || item.dangerGradeNm || null,
        })),
        highRiskCount: items.filter(i =>
          (i.dngGrd || i.dangerGrade || 0) >= 66
        ).length,
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

/**
 * Fetch fire station locations and basic info
 * Uses public data portal API
 */
async function fetchFireStations() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'DATA_GO_KR_API_KEY not set' };
  }

  try {
    const url = `http://apis.data.go.kr/1160000/service/GetFireStationInfoService/getFireStationList?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=100&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      const items = data?.response?.body?.items?.item || [];

      return {
        available: true,
        totalStations: items.length,
        stations: items.slice(0, 50).map(s => ({
          name: s.fireStationNm || s.name || '알 수 없음',
          address: s.addr || s.address || '',
          tel: s.telNo || s.tel || '',
          lat: parseFloat(s.lat) || null,
          lon: parseFloat(s.lon || s.lng) || null,
        })).filter(s => s.lat && s.lon),
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

export async function briefing() {
  const results = {
    source: 'FireRisk',
    description: 'Korean fire risk index, disaster alerts, and fire station data',
    timestamp: new Date().toISOString(),
    disasterAlerts: [],
    forestFireRisk: {},
    fireStations: {},
    provinces: PROVINCES,
    summary: {},
  };

  // Run all fetches in parallel
  const [alerts, forestRisk, stations] = await Promise.allSettled([
    fetchDisasterAlerts(),
    fetchForestFireRisk(),
    fetchFireStations(),
  ]);

  // Disaster alerts
  if (alerts.status === 'fulfilled') {
    results.disasterAlerts = alerts.value;
    results.summary.totalAlerts = alerts.value.length;
    results.summary.fireRelatedAlerts = alerts.value.filter(a => a.fireRelated).length;
  }

  // Forest fire risk
  if (forestRisk.status === 'fulfilled') {
    results.forestFireRisk = forestRisk.value;
    if (forestRisk.value.available) {
      results.summary.highFireRiskRegions = forestRisk.value.highRiskCount;
    }
  }

  // Fire stations
  if (stations.status === 'fulfilled') {
    results.fireStations = stations.value;
    if (stations.value.available) {
      results.summary.totalFireStations = stations.value.totalStations;
    }
  }

  // Overall fire risk assessment
  const fireAlertCount = results.summary.fireRelatedAlerts || 0;
  const highRiskRegions = results.summary.highFireRiskRegions || 0;

  if (fireAlertCount > 3 || highRiskRegions > 5) {
    results.summary.overallRisk = 'HIGH';
  } else if (fireAlertCount > 0 || highRiskRegions > 2) {
    results.summary.overallRisk = 'MODERATE';
  } else {
    results.summary.overallRisk = 'LOW';
  }

  return results;
}
