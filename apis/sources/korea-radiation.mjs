// Korea Radiation Monitor — 방사선 선량 실시간 모니터링
// Sources:
//   1. KINS (한국원자력안전기술원) — IERNet 환경방사선감시망
//   2. Safecast Korea — 시민 방사선 측정 네트워크
//   3. IAEA REMIS — 국제원자력기구 실시간 모니터링
//
// Monitors: 원전 주변 + 전국 환경방사선 + 북한 핵시설 인접
// Units: µSv/h (마이크로시버트/시), CPM (분당 계수)
// Normal background in Korea: 0.05–0.30 µSv/h

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

// Korean nuclear power plant sites + key monitoring points
const MONITORING_SITES = [
  // Active nuclear power plants (가동 원전)
  { id: 'kori', name: '고리/신고리', nameEn: 'Kori/Shin-Kori', lat: 35.3208, lon: 129.2783, type: 'npp', reactors: 9 },
  { id: 'hanbit', name: '한빛', nameEn: 'Hanbit', lat: 35.4142, lon: 126.4225, type: 'npp', reactors: 6 },
  { id: 'hanul', name: '한울/신한울', nameEn: 'Hanul/Shin-Hanul', lat: 37.0928, lon: 129.3833, type: 'npp', reactors: 8 },
  { id: 'wolsong', name: '월성/신월성', nameEn: 'Wolsong/Shin-Wolsong', lat: 35.7133, lon: 129.4747, type: 'npp', reactors: 6 },

  // Nuclear research facilities (연구시설)
  { id: 'kaeri', name: 'KAERI 대전', nameEn: 'KAERI Daejeon', lat: 36.3908, lon: 127.3725, type: 'research' },

  // North Korea nuclear sites (북한 핵시설 인접)
  { id: 'yongbyon', name: '영변 인접(북)', nameEn: 'Near Yongbyon (NK)', lat: 39.8000, lon: 125.7500, type: 'nk_facility' },
  { id: 'punggye', name: '풍계리 인접(북)', nameEn: 'Near Punggye-ri (NK)', lat: 41.2808, lon: 129.0939, type: 'nk_test_site' },

  // Major population centers (주요 도시)
  { id: 'seoul', name: '서울', nameEn: 'Seoul', lat: 37.5665, lon: 126.9780, type: 'city' },
  { id: 'busan', name: '부산', nameEn: 'Busan', lat: 35.1796, lon: 129.0756, type: 'city' },
  { id: 'jeju', name: '제주', nameEn: 'Jeju', lat: 33.4996, lon: 126.5312, type: 'city' },
  { id: 'incheon', name: '인천', nameEn: 'Incheon', lat: 37.4563, lon: 126.7052, type: 'city' },
  { id: 'gangneung', name: '강릉', nameEn: 'Gangneung', lat: 37.7519, lon: 128.8761, type: 'city' },
];

// Radiation thresholds (µSv/h)
const THRESHOLDS = {
  normal: 0.30,       // 정상 범위 상한
  elevated: 0.50,     // 주의 수준
  warning: 1.00,      // 경고 수준
  danger: 5.00,       // 위험 수준
  emergency: 20.00,   // 비상 수준 (실내 대피 권고)
};

function classifyLevel(usvh) {
  if (usvh >= THRESHOLDS.emergency) return { level: 'emergency', ko: '비상', color: '#ff0000' };
  if (usvh >= THRESHOLDS.danger) return { level: 'danger', ko: '위험', color: '#ff4444' };
  if (usvh >= THRESHOLDS.warning) return { level: 'warning', ko: '경고', color: '#ff8800' };
  if (usvh >= THRESHOLDS.elevated) return { level: 'elevated', ko: '주의', color: '#ffcc00' };
  return { level: 'normal', ko: '정상', color: '#00cc66' };
}

// CPM to µSv/h approximate conversion (for Safecast LND-7317 tubes)
function cpmToUsv(cpm) {
  return cpm / 334;
}

// === 1. KINS IERNet — 환경방사선감시망 ===
async function fetchKINS() {
  try {
    // KINS public radiation data endpoint
    const url = 'https://iernet.kins.re.kr/json/getEnvRadData.do';
    const res = await safeFetch(url, { timeout: 12000 });

    if (res?.list || res?.data || Array.isArray(res)) {
      const items = res.list || res.data || res;
      const readings = items.map(item => ({
        station: item.mntSttNm || item.stationName || item.name,
        region: item.sidoNm || item.sido || '',
        usvh: parseFloat(item.gammaRay || item.doserate || item.value) || 0,
        time: item.measDt || item.datetime || item.time,
      })).filter(r => r.usvh > 0);

      return { status: 'ok', readings };
    }

    return { status: 'empty', readings: [] };
  } catch (e) {
    return { status: 'error', error: e.message, readings: [] };
  }
}

// === 2. Safecast — Korea region ===
async function fetchSafecast() {
  const sites = MONITORING_SITES.filter(s => s.type === 'npp' || s.type === 'city');
  const allReadings = [];

  for (const site of sites) {
    try {
      const url = `https://api.safecast.org/measurements.json?latitude=${site.lat}&longitude=${site.lon}&distance=50000&order=created_at+desc&per_page=10`;
      const res = await safeFetch(url, { timeout: 10000 });

      if (Array.isArray(res) && res.length > 0) {
        const cpms = res.map(m => parseFloat(m.value) || 0).filter(v => v > 0);
        if (cpms.length > 0) {
          const avgCPM = cpms.reduce((a, b) => a + b, 0) / cpms.length;
          const maxCPM = Math.max(...cpms);
          allReadings.push({
            siteId: site.id,
            siteName: site.name,
            lat: site.lat,
            lon: site.lon,
            avgCPM: Math.round(avgCPM),
            maxCPM: Math.round(maxCPM),
            usvh: parseFloat(cpmToUsv(avgCPM).toFixed(3)),
            maxUsvh: parseFloat(cpmToUsv(maxCPM).toFixed(3)),
            readings: cpms.length,
            lastReading: res[0]?.captured_at || res[0]?.created_at,
          });
        }
      }
    } catch {
      // Continue with next site
    }
  }

  return { status: allReadings.length > 0 ? 'ok' : 'empty', readings: allReadings };
}

// === 3. IAEA REMIS — Korea monitoring stations ===
async function fetchIAEA() {
  try {
    // IAEA public radiation monitoring data
    const url = 'https://remis.iaea.org/api/v1/stations?country=KR&limit=50';
    const res = await safeFetch(url, { timeout: 10000 });

    const stations = (res?.data || res?.stations || []).map(s => ({
      station: s.name || s.station_name,
      lat: parseFloat(s.latitude || s.lat) || 0,
      lon: parseFloat(s.longitude || s.lon) || 0,
      usvh: parseFloat(s.dose_rate || s.value) || 0,
      time: s.last_update || s.timestamp,
    })).filter(s => s.lat > 0 && s.usvh > 0);

    return { status: stations.length > 0 ? 'ok' : 'empty', stations };
  } catch (e) {
    return { status: 'error', error: e.message, stations: [] };
  }
}

// === Master Briefing ===
export async function briefing() {
  const [kins, safecast, iaea] = await Promise.all([
    fetchKINS(),
    fetchSafecast(),
    fetchIAEA(),
  ]);

  // Build site-level readings by merging all sources
  const siteReadings = MONITORING_SITES.map(site => {
    // Find best available reading for this site
    const safecastReading = safecast.readings.find(r => r.siteId === site.id);

    // Match KINS readings by region name
    const kinsReading = kins.readings.find(r =>
      r.station?.includes(site.name) || r.region?.includes(site.name)
    );

    // Determine best µSv/h value
    const usvh = kinsReading?.usvh || safecastReading?.usvh || 0;
    const maxUsvh = Math.max(kinsReading?.usvh || 0, safecastReading?.maxUsvh || 0);
    const classification = classifyLevel(usvh > 0 ? usvh : 0.10); // Default normal

    return {
      ...site,
      usvh: parseFloat(usvh.toFixed(3)),
      maxUsvh: parseFloat(maxUsvh.toFixed(3)),
      cpm: safecastReading?.avgCPM || null,
      classification,
      dataSource: kinsReading ? 'KINS' : safecastReading ? 'Safecast' : 'estimated',
      lastUpdate: kinsReading?.time || safecastReading?.lastReading || null,
    };
  });

  // Geo points for map
  const geoPoints = siteReadings.map(s => ({
    lat: s.lat,
    lon: s.lon,
    type: 'radiation',
    level: s.classification.level,
    label: `${s.name} ${s.usvh}µSv/h (${s.classification.ko})`,
    usvh: s.usvh,
    siteType: s.type,
  }));

  // Signals
  const signals = [];
  const anomalies = siteReadings.filter(s => s.usvh > THRESHOLDS.elevated);
  const nppStatus = siteReadings.filter(s => s.type === 'npp');
  const allNormal = nppStatus.every(s => s.classification.level === 'normal');

  if (anomalies.length > 0) {
    for (const a of anomalies) {
      signals.push(`방사선 이상: ${a.name} ${a.usvh}µSv/h (${a.classification.ko}) — 정상범위 ${THRESHOLDS.normal}µSv/h 초과`);
    }
  }

  if (allNormal) {
    signals.push('원전 주변 방사선: 전 원전 정상 범위');
  } else {
    const abnormal = nppStatus.filter(s => s.classification.level !== 'normal');
    signals.push(`원전 방사선 주의: ${abnormal.map(s => `${s.name}(${s.usvh}µSv/h)`).join(', ')}`);
  }

  // Check North Korea facility proximity
  const nkSites = siteReadings.filter(s => s.type === 'nk_facility' || s.type === 'nk_test_site');
  const nkAnomalies = nkSites.filter(s => s.usvh > THRESHOLDS.elevated);
  if (nkAnomalies.length > 0) {
    signals.push(`북한 핵시설 인접 이상: ${nkAnomalies.map(s => `${s.name}(${s.usvh}µSv/h)`).join(', ')}`);
  }

  return {
    source: 'Korea Radiation',
    timestamp: new Date().toISOString(),
    status: 'active',
    summary: {
      totalSites: siteReadings.length,
      nppCount: nppStatus.length,
      allNppNormal: allNormal,
      anomalyCount: anomalies.length,
      avgNppUsvh: nppStatus.length > 0
        ? parseFloat((nppStatus.reduce((s, n) => s + n.usvh, 0) / nppStatus.length).toFixed(3))
        : 0,
      maxUsvh: siteReadings.length > 0
        ? Math.max(...siteReadings.map(s => s.usvh))
        : 0,
    },
    dataSources: {
      kins: { status: kins.status, count: kins.readings.length },
      safecast: { status: safecast.status, count: safecast.readings.length },
      iaea: { status: iaea.status, count: iaea.stations?.length || 0 },
    },
    thresholds: THRESHOLDS,
    sites: siteReadings,
    nppStatus: nppStatus.map(s => ({
      name: s.name,
      nameEn: s.nameEn,
      reactors: s.reactors,
      usvh: s.usvh,
      level: s.classification.level,
      levelKo: s.classification.ko,
    })),
    geoPoints,
    signals,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('korea-radiation.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
