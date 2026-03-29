// Korea Air Quality — 미세먼지/대기질 실시간 모니터링
// Sources:
//   1. AirKorea (에어코리아) — 한국환경공단 실시간 대기질
//      API: data.go.kr 공공데이터포털 (DATA_GO_KR_API_KEY)
//   2. OpenAQ — Global open air quality data (no key, Korea filter)
//   3. WAQI (World Air Quality Index) — aqicn.org (free token)
//
// Metrics: PM2.5, PM10, O3, NO2, CO, SO2, CAI (통합대기환경지수)
// All sources degrade gracefully when keys are missing.

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

// Korean monitoring station regions
const KOREA_REGIONS = [
  { name: '서울', lat: 37.5665, lon: 126.9780 },
  { name: '부산', lat: 35.1796, lon: 129.0756 },
  { name: '대구', lat: 35.8714, lon: 128.6014 },
  { name: '인천', lat: 37.4563, lon: 126.7052 },
  { name: '광주', lat: 35.1595, lon: 126.8526 },
  { name: '대전', lat: 36.3504, lon: 127.3845 },
  { name: '울산', lat: 35.5384, lon: 129.3114 },
  { name: '세종', lat: 36.4800, lon: 127.0000 },
  { name: '경기', lat: 37.2750, lon: 127.0094 },
  { name: '강원', lat: 37.8228, lon: 128.1555 },
  { name: '충북', lat: 36.6357, lon: 127.4912 },
  { name: '충남', lat: 36.6588, lon: 126.6728 },
  { name: '전북', lat: 35.8203, lon: 127.1089 },
  { name: '전남', lat: 34.8161, lon: 126.4629 },
  { name: '경북', lat: 36.4919, lon: 128.8889 },
  { name: '경남', lat: 35.4606, lon: 128.2132 },
  { name: '제주', lat: 33.4996, lon: 126.5312 },
];

// PM2.5 thresholds (WHO/KMA standards, µg/m³)
const PM25_LEVELS = {
  good: 15,       // 좋음
  moderate: 35,   // 보통
  unhealthy: 75,  // 나쁨
  veryUnhealthy: 150, // 매우 나쁨 (hazardous)
};

// PM10 thresholds (µg/m³)
const PM10_LEVELS = {
  good: 30,
  moderate: 80,
  unhealthy: 150,
  veryUnhealthy: 300,
};

function classifyAQI(pm25, pm10) {
  if (pm25 >= PM25_LEVELS.veryUnhealthy || pm10 >= PM10_LEVELS.veryUnhealthy) return 'hazardous';
  if (pm25 >= PM25_LEVELS.unhealthy || pm10 >= PM10_LEVELS.unhealthy) return 'unhealthy';
  if (pm25 >= PM25_LEVELS.moderate || pm10 >= PM10_LEVELS.moderate) return 'moderate';
  return 'good';
}

function gradeToKorean(grade) {
  const map = { good: '좋음', moderate: '보통', unhealthy: '나쁨', hazardous: '매우 나쁨' };
  return map[grade] || grade;
}

// === 1. AirKorea via data.go.kr ===
async function fetchAirKorea() {
  const key = process.env.DATA_GO_KR_API_KEY;
  if (!key) return { status: 'no_key', stations: [] };

  try {
    // 시도별 실시간 측정정보 조회
    const url = `http://apis.data.go.kr/B552584/ArpltnInforInqireSvc/getCtprvnRltmMesureDnsty?serviceKey=${encodeURIComponent(key)}&returnType=json&numOfRows=500&pageNo=1&sidoName=전국&ver=1.5`;

    const res = await safeFetch(url, { timeout: 15000 });
    const items = res?.response?.body?.items || [];

    const stations = items.map(item => {
      const pm25 = parseFloat(item.pm25Value) || 0;
      const pm10 = parseFloat(item.pm10Value) || 0;

      // Find matching region for geo coordinates
      const region = KOREA_REGIONS.find(r => item.sidoName?.includes(r.name));

      return {
        station: item.stationName,
        city: item.sidoName,
        pm25,
        pm10,
        o3: parseFloat(item.o3Value) || 0,
        no2: parseFloat(item.no2Value) || 0,
        co: parseFloat(item.coValue) || 0,
        so2: parseFloat(item.so2Value) || 0,
        cai: parseInt(item.khaiValue) || 0,    // 통합대기환경지수
        caiGrade: item.khaiGrade,
        grade: classifyAQI(pm25, pm10),
        time: item.dataTime,
        lat: region?.lat || 36.5,
        lon: region?.lon + (Math.random() - 0.5) * 0.5 || 127.8,
      };
    }).filter(s => s.pm25 > 0 || s.pm10 > 0);

    return { status: 'ok', stations };
  } catch (e) {
    return { status: 'error', error: e.message, stations: [] };
  }
}

// === 2. OpenAQ — Korea filter (no key needed) ===
async function fetchOpenAQ() {
  try {
    const url = 'https://api.openaq.org/v2/latest?country=KR&limit=100&parameter=pm25&parameter=pm10';
    const res = await safeFetch(url, { timeout: 12000, headers: { 'Accept': 'application/json' } });
    const results = res?.results || [];

    const stations = results.map(r => {
      const pm25 = r.measurements?.find(m => m.parameter === 'pm25');
      const pm10 = r.measurements?.find(m => m.parameter === 'pm10');
      return {
        station: r.location,
        city: r.city,
        pm25: pm25?.value || 0,
        pm10: pm10?.value || 0,
        grade: classifyAQI(pm25?.value || 0, pm10?.value || 0),
        lat: r.coordinates?.latitude,
        lon: r.coordinates?.longitude,
        time: pm25?.lastUpdated || pm10?.lastUpdated,
      };
    }).filter(s => s.lat && s.lon);

    return { status: 'ok', stations };
  } catch (e) {
    return { status: 'error', error: e.message, stations: [] };
  }
}

// === 3. WAQI (World Air Quality Index) — Major Korean cities ===
async function fetchWAQI() {
  const token = process.env.WAQI_TOKEN;
  if (!token) return { status: 'no_key', stations: [] };

  const cities = ['seoul', 'busan', 'daegu', 'incheon', 'gwangju', 'daejeon', 'ulsan', 'jeju'];
  const stations = [];

  for (const city of cities) {
    try {
      const res = await safeFetch(`https://api.waqi.info/feed/${city}/?token=${token}`, { timeout: 8000 });
      if (res?.status === 'ok' && res.data) {
        const d = res.data;
        stations.push({
          station: d.city?.name || city,
          city,
          aqi: d.aqi,
          pm25: d.iaqi?.pm25?.v || 0,
          pm10: d.iaqi?.pm10?.v || 0,
          o3: d.iaqi?.o3?.v || 0,
          no2: d.iaqi?.no2?.v || 0,
          co: d.iaqi?.co?.v || 0,
          so2: d.iaqi?.so2?.v || 0,
          grade: classifyAQI(d.iaqi?.pm25?.v || 0, d.iaqi?.pm10?.v || 0),
          lat: d.city?.geo?.[0],
          lon: d.city?.geo?.[1],
          time: d.time?.iso,
          dominant: d.dominentpol,
        });
      }
    } catch {
      // Continue with next city
    }
  }

  return { status: 'ok', stations };
}

// === Master Briefing ===
export async function briefing() {
  const [airkorea, openaq, waqi] = await Promise.all([
    fetchAirKorea(),
    fetchOpenAQ(),
    fetchWAQI(),
  ]);

  // Merge and deduplicate — prefer AirKorea, then WAQI, then OpenAQ
  const allStations = [
    ...airkorea.stations,
    ...waqi.stations,
    ...openaq.stations,
  ];

  // Aggregate by region (시도별 평균)
  const regionMap = new Map();
  for (const region of KOREA_REGIONS) {
    const matching = allStations.filter(s =>
      s.city?.includes(region.name) ||
      (Math.abs((s.lat || 0) - region.lat) < 0.5 && Math.abs((s.lon || 0) - region.lon) < 0.5)
    );
    if (matching.length === 0) continue;

    const avgPM25 = matching.reduce((s, m) => s + m.pm25, 0) / matching.length;
    const avgPM10 = matching.reduce((s, m) => s + m.pm10, 0) / matching.length;
    const maxPM25 = Math.max(...matching.map(m => m.pm25));
    const maxPM10 = Math.max(...matching.map(m => m.pm10));

    regionMap.set(region.name, {
      region: region.name,
      lat: region.lat,
      lon: region.lon,
      stationCount: matching.length,
      avgPM25: Math.round(avgPM25),
      avgPM10: Math.round(avgPM10),
      maxPM25: Math.round(maxPM25),
      maxPM10: Math.round(maxPM10),
      grade: classifyAQI(avgPM25, avgPM10),
      gradeKo: gradeToKorean(classifyAQI(avgPM25, avgPM10)),
    });
  }

  const regions = Array.from(regionMap.values());

  // Geo points for map markers
  const geoPoints = regions.map(r => ({
    lat: r.lat,
    lon: r.lon,
    type: 'airquality',
    grade: r.grade,
    label: `${r.region} PM2.5: ${r.avgPM25}µg/m³ (${r.gradeKo})`,
    pm25: r.avgPM25,
    pm10: r.avgPM10,
  }));

  // Signals
  const signals = [];
  const unhealthyRegions = regions.filter(r => r.grade === 'unhealthy' || r.grade === 'hazardous');
  const hazardousRegions = regions.filter(r => r.grade === 'hazardous');

  if (hazardousRegions.length > 0) {
    signals.push(`미세먼지 매우 나쁨: ${hazardousRegions.map(r => `${r.region}(PM2.5: ${r.avgPM25})`).join(', ')}`);
  }
  if (unhealthyRegions.length > 0) {
    signals.push(`미세먼지 나쁨 이상: ${unhealthyRegions.length}개 지역 — ${unhealthyRegions.map(r => r.region).join(', ')}`);
  }

  const nationalAvgPM25 = regions.length > 0
    ? Math.round(regions.reduce((s, r) => s + r.avgPM25, 0) / regions.length)
    : 0;

  if (nationalAvgPM25 > PM25_LEVELS.moderate) {
    signals.push(`전국 평균 PM2.5: ${nationalAvgPM25}µg/m³ — 외출 자제 권고 수준`);
  }

  return {
    source: 'Korea Air Quality',
    timestamp: new Date().toISOString(),
    status: 'active',
    summary: {
      nationalAvgPM25,
      nationalAvgPM10: regions.length > 0
        ? Math.round(regions.reduce((s, r) => s + r.avgPM10, 0) / regions.length)
        : 0,
      unhealthyCount: unhealthyRegions.length,
      hazardousCount: hazardousRegions.length,
      totalStations: allStations.length,
      grade: classifyAQI(nationalAvgPM25, 0),
      gradeKo: gradeToKorean(classifyAQI(nationalAvgPM25, 0)),
    },
    dataSources: {
      airkorea: { status: airkorea.status, count: airkorea.stations.length },
      openaq: { status: openaq.status, count: openaq.stations.length },
      waqi: { status: waqi.status, count: waqi.stations.length },
    },
    regions,
    geoPoints,
    signals,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('korea-airquality.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
