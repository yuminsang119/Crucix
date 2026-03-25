#!/usr/bin/env node
// Emergency 119 Dispatch & Fire Incident Data Source
// Aggregates Korean fire/rescue incident data from public sources
// Uses: data.go.kr APIs, SafeKorea, and public fire statistics

import { safeFetch } from '../utils/fetch.mjs';

// Fire incident severity classification
const SEVERITY = {
  LEVEL_1: { code: 1, label: '대응 1단계', description: '소규모 화재' },
  LEVEL_2: { code: 2, label: '대응 2단계', description: '중규모 화재' },
  LEVEL_3: { code: 3, label: '대응 3단계', description: '대형 화재' },
  SPECIAL: { code: 4, label: '특수대응', description: '위험물/폭발/다수사상자' },
};

// Korean fire type classifications
const FIRE_TYPES = {
  STRUCTURE: '건물화재',
  WILDFIRE: '산불',
  VEHICLE: '차량화재',
  SHIP: '선박화재',
  HAZMAT: '위험물사고',
  ELECTRICAL: '전기화재',
  GAS: '가스사고',
  OTHER: '기타화재',
};

/**
 * Fetch real-time fire incident data from public API
 */
async function fetchFireIncidents() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'DATA_GO_KR_API_KEY not set — using fallback data' };
  }

  try {
    // Fire incident statistics API
    const url = `http://apis.data.go.kr/1160000/service/GetFireIncidentService/getFireIncidentList?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=50&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      const items = data?.response?.body?.items?.item || [];

      return {
        available: true,
        incidents: items.map(item => ({
          date: item.occrrncDt || item.date || '',
          location: item.occrrncLctn || item.location || '알 수 없음',
          type: item.fireTypeNm || item.type || FIRE_TYPES.OTHER,
          casualties: {
            deaths: parseInt(item.dthDnv || item.deaths || 0),
            injuries: parseInt(item.injpsnDnv || item.injuries || 0),
          },
          propertyDamage: item.prptyDmge || item.damage || null,
          cause: item.fireCause || item.cause || '조사중',
        })),
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

/**
 * Fetch fire hydrant and water supply locations
 */
async function fetchFireWaterSupply() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'DATA_GO_KR_API_KEY not set' };
  }

  try {
    const url = `http://apis.data.go.kr/1160000/service/GetFireHydrantInfoService/getFireHydrantList?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=200&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      const items = data?.response?.body?.items?.item || [];

      return {
        available: true,
        total: items.length,
        hydrants: items.slice(0, 100).map(h => ({
          type: h.fireHydrantTypeNm || '소화전',
          address: h.addr || h.address || '',
          lat: parseFloat(h.lat) || null,
          lon: parseFloat(h.lon || h.lng) || null,
          status: h.statusNm || '정상',
        })).filter(h => h.lat && h.lon),
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

/**
 * Fetch hazardous materials facility locations
 */
async function fetchHazmatFacilities() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'DATA_GO_KR_API_KEY not set' };
  }

  try {
    const url = `http://apis.data.go.kr/1160000/service/GetHazmatFacilityService/getHazmatFacilityList?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=100&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const data = await res.json();
      const items = data?.response?.body?.items?.item || [];

      return {
        available: true,
        total: items.length,
        facilities: items.slice(0, 50).map(f => ({
          name: f.bplcNm || f.name || '알 수 없음',
          address: f.addr || f.address || '',
          hazmatType: f.hazmatTypeNm || f.type || '알 수 없음',
          lat: parseFloat(f.lat) || null,
          lon: parseFloat(f.lon || f.lng) || null,
        })).filter(f => f.lat && f.lon),
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

/**
 * Fetch hospital/ER availability
 */
async function fetchHospitalAvailability() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) {
    return { available: false, note: 'DATA_GO_KR_API_KEY not set' };
  }

  try {
    // National Emergency Medical Center real-time ER availability
    const url = `http://apis.data.go.kr/B552657/ErmctInfoInqireService/getEmrrmRltmUsefulSckbdInfoInqire?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=50&pageNo=1&STAGE1=서울&STAGE2=&pageNo=1&numOfRows=50`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (res.ok) {
      const text = await res.text();
      // Parse XML response
      const hospitals = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(text)) !== null) {
        const block = match[1];
        const name = block.match(/<dutyName>(.*?)<\/dutyName>/)?.[1] || '';
        const addr = block.match(/<dutyAddr>(.*?)<\/dutyAddr>/)?.[1] || '';
        const tel = block.match(/<dutyTel3>(.*?)<\/dutyTel3>/)?.[1] || '';
        const hvec = block.match(/<hvec>(.*?)<\/hvec>/)?.[1]; // ER available beds
        const lat = block.match(/<wgs84Lat>(.*?)<\/wgs84Lat>/)?.[1];
        const lon = block.match(/<wgs84Lon>(.*?)<\/wgs84Lon>/)?.[1];

        if (name) {
          hospitals.push({
            name,
            address: addr,
            tel,
            erAvailableBeds: hvec ? parseInt(hvec) : null,
            lat: lat ? parseFloat(lat) : null,
            lon: lon ? parseFloat(lon) : null,
          });
        }
      }

      return {
        available: true,
        total: hospitals.length,
        hospitals: hospitals.filter(h => h.lat && h.lon),
        totalAvailableBeds: hospitals.reduce((sum, h) => sum + (h.erAvailableBeds || 0), 0),
      };
    }
  } catch (e) {
    return { available: false, error: e.message };
  }

  return { available: false };
}

export async function briefing() {
  const results = {
    source: 'Emergency119',
    description: 'Korean 119 emergency dispatch — fire incidents, water supply, hazmat, hospitals',
    timestamp: new Date().toISOString(),
    incidents: {},
    waterSupply: {},
    hazmatFacilities: {},
    hospitals: {},
    severityLevels: SEVERITY,
    fireTypes: FIRE_TYPES,
    summary: {},
  };

  // Run all fetches in parallel
  const [incidents, waterSupply, hazmat, hospitals] = await Promise.allSettled([
    fetchFireIncidents(),
    fetchFireWaterSupply(),
    fetchHazmatFacilities(),
    fetchHospitalAvailability(),
  ]);

  // Fire incidents
  if (incidents.status === 'fulfilled') {
    results.incidents = incidents.value;
    if (incidents.value.available && incidents.value.incidents) {
      const inc = incidents.value.incidents;
      results.summary.totalIncidents = inc.length;
      results.summary.totalDeaths = inc.reduce((s, i) => s + (i.casualties?.deaths || 0), 0);
      results.summary.totalInjuries = inc.reduce((s, i) => s + (i.casualties?.injuries || 0), 0);
      results.summary.byType = {};
      for (const i of inc) {
        const type = i.type || FIRE_TYPES.OTHER;
        results.summary.byType[type] = (results.summary.byType[type] || 0) + 1;
      }
    }
  }

  // Water supply
  if (waterSupply.status === 'fulfilled') {
    results.waterSupply = waterSupply.value;
    if (waterSupply.value.available) {
      results.summary.totalHydrants = waterSupply.value.total;
    }
  }

  // Hazmat facilities
  if (hazmat.status === 'fulfilled') {
    results.hazmatFacilities = hazmat.value;
    if (hazmat.value.available) {
      results.summary.totalHazmatFacilities = hazmat.value.total;
    }
  }

  // Hospitals
  if (hospitals.status === 'fulfilled') {
    results.hospitals = hospitals.value;
    if (hospitals.value.available) {
      results.summary.totalHospitals = hospitals.value.total;
      results.summary.totalAvailableBeds = hospitals.value.totalAvailableBeds;
    }
  }

  // Data availability summary
  results.summary.dataAvailability = {
    incidents: incidents.status === 'fulfilled' && incidents.value.available,
    waterSupply: waterSupply.status === 'fulfilled' && waterSupply.value.available,
    hazmat: hazmat.status === 'fulfilled' && hazmat.value.available,
    hospitals: hospitals.status === 'fulfilled' && hospitals.value.available,
  };

  return results;
}
