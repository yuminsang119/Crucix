// Korea Disaster Intelligence — 대한민국 재난/화재/위험 정보
// Sources:
//   1. 공공데이터포털 재난문자 API (data.go.kr)
//   2. 기상청 특보 API (KMA)
//   3. 산림청 산불 정보
//   4. 행정안전부 재난안전 정보
//   5. GDACS (Global Disaster Alerting Coordination System) — Korea filter
//   6. NASA FIRMS Korea-focused thermal detection
//
// API keys: DATA_GO_KR_API_KEY (free at data.go.kr)
// Some endpoints are open (no key required)

import { safeFetch } from '../utils/fetch.mjs';
import '../utils/env.mjs';

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Korea bounding box
const KOREA_BBOX = { west: 124.5, south: 33.0, east: 132.0, north: 38.7 };

// Major Korean cities for geo-tagging
const KOREA_CITIES = {
  '서울': { lat: 37.5665, lon: 126.9780 }, '부산': { lat: 35.1796, lon: 129.0756 },
  '대구': { lat: 35.8714, lon: 128.6014 }, '인천': { lat: 37.4563, lon: 126.7052 },
  '광주': { lat: 35.1595, lon: 126.8526 }, '대전': { lat: 36.3504, lon: 127.3845 },
  '울산': { lat: 35.5384, lon: 129.3114 }, '세종': { lat: 36.4800, lon: 127.0000 },
  '경기': { lat: 37.2750, lon: 127.0094 }, '강원': { lat: 37.8228, lon: 128.1555 },
  '충북': { lat: 36.6357, lon: 127.4912 }, '충남': { lat: 36.6588, lon: 126.6728 },
  '전북': { lat: 35.8203, lon: 127.1089 }, '전남': { lat: 34.8161, lon: 126.4629 },
  '경북': { lat: 36.4919, lon: 128.8889 }, '경남': { lat: 35.4606, lon: 128.2132 },
  '제주': { lat: 33.4996, lon: 126.5312 },
  'Seoul': { lat: 37.5665, lon: 126.9780 }, 'Busan': { lat: 35.1796, lon: 129.0756 },
  'Incheon': { lat: 37.4563, lon: 126.7052 }, 'Daegu': { lat: 35.8714, lon: 128.6014 },
  'Daejeon': { lat: 36.3504, lon: 127.3845 }, 'Gwangju': { lat: 35.1595, lon: 126.8526 },
  'Ulsan': { lat: 35.5384, lon: 129.3114 }, 'Jeju': { lat: 33.4996, lon: 126.5312 },
};

function geoTagKorea(text) {
  if (!text) return null;
  for (const [city, coords] of Object.entries(KOREA_CITIES)) {
    if (text.includes(city)) return { ...coords, region: city };
  }
  return { lat: 36.5, lon: 127.8, region: 'Korea' };
}

// === 1. 공공데이터포털 재난문자 (Emergency Alerts) ===
async function fetchDisasterMessages() {
  const key = process.env.DATA_GO_KR_API_KEY;
  if (!key) return { status: 'no_key', items: [] };

  try {
    const today = new Date().toISOString().split('T')[0];
    const url = `https://www.safekorea.go.kr/idsiSFK/sfk/cs/sua/web/sms_list.do`;
    // Fallback: use RSS feed from safekorea
    const rssUrl = 'https://www.safekorea.go.kr/idsiSFK/sfk/cs/sfc/rss/sms_rss.do';

    const res = await safeFetch(rssUrl, { timeout: 10000 });

    // Parse items from XML-like response
    const items = [];
    if (res?.rawText) {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(res.rawText)) !== null) {
        const block = match[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
        const desc = block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const geo = geoTagKorea(title + ' ' + desc);

        const severity = classifySeverity(title + ' ' + desc);
        items.push({ title, description: desc.slice(0, 200), date: pubDate, severity, geo });
      }
    }
    return { status: 'ok', items: items.slice(0, 30) };
  } catch (e) {
    return { status: 'error', error: e.message, items: [] };
  }
}

// === 2. 기상청 기상특보 (KMA Weather Warnings) ===
async function fetchKMAWarnings() {
  try {
    // KMA RSS feed for weather warnings
    const url = 'https://www.weather.go.kr/w/rss/dfs/wn_pm.xml';
    const res = await safeFetch(url, { timeout: 10000 });

    const items = [];
    if (res?.rawText) {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(res.rawText)) !== null) {
        const block = match[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
        const desc = block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const geo = geoTagKorea(title + ' ' + desc);
        items.push({ title, description: desc.slice(0, 200), date: pubDate, type: 'weather', geo });
      }
    }
    return { status: 'ok', items: items.slice(0, 20) };
  } catch (e) {
    return { status: 'error', error: e.message, items: [] };
  }
}

// === 3. 산림청 산불 현황 (Forest Fire Status) ===
async function fetchForestFires() {
  try {
    // Forest Service wildfire RSS/data
    const url = 'https://www.forest.go.kr/kfs/idx/SubIndex.do?orgId=kfs&boardId=fire_rss';
    const res = await safeFetch(url, { timeout: 10000 });

    const fires = [];
    if (res?.rawText) {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(res.rawText)) !== null) {
        const block = match[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
        const desc = block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';
        const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
        const geo = geoTagKorea(title + ' ' + desc);
        fires.push({ title, description: desc.slice(0, 200), date: pubDate, type: 'wildfire', geo });
      }
    }
    return { status: 'ok', fires: fires.slice(0, 15) };
  } catch (e) {
    return { status: 'error', error: e.message, fires: [] };
  }
}

// === 4. GDACS — Global Disaster Alerts (Korea filtered) ===
async function fetchGDACS() {
  try {
    const url = 'https://www.gdacs.org/xml/rss.xml';
    const res = await safeFetch(url, { timeout: 10000 });

    const alerts = [];
    if (res?.rawText) {
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(res.rawText)) !== null) {
        const block = match[1];
        const title = block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1]?.trim() || '';
        const desc = block.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/)?.[1]?.trim() || '';

        // Extract geo:lat / geo:long
        const lat = parseFloat(block.match(/<geo:lat>([\d.-]+)<\/geo:lat>/)?.[1]);
        const lon = parseFloat(block.match(/<geo:long>([\d.-]+)<\/geo:long>/)?.[1]);
        const alertLevel = block.match(/<gdacs:alertlevel>(.*?)<\/gdacs:alertlevel>/)?.[1] || '';
        const eventType = block.match(/<gdacs:eventtype>(.*?)<\/gdacs:eventtype>/)?.[1] || '';

        // Filter for Korea region or Korea-mentioning events
        const isKoreaRegion = !isNaN(lat) && !isNaN(lon) &&
          lat >= KOREA_BBOX.south && lat <= KOREA_BBOX.north &&
          lon >= KOREA_BBOX.west && lon <= KOREA_BBOX.east;
        const mentionsKorea = /korea|한국|부산|서울|제주|대구|인천/i.test(title + desc);

        if (isKoreaRegion || mentionsKorea) {
          alerts.push({
            title, description: desc.slice(0, 200),
            lat: isKoreaRegion ? lat : 36.5, lon: isKoreaRegion ? lon : 127.8,
            alertLevel, eventType
          });
        }
      }
    }

    return { status: 'ok', alerts: alerts.slice(0, 10) };
  } catch (e) {
    return { status: 'error', error: e.message, alerts: [] };
  }
}

// === 5. NASA FIRMS — Korea-focused thermal detections ===
async function fetchKoreaFIRMS() {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return { status: 'no_key', fires: [] };

  try {
    const { west, south, east, north } = KOREA_BBOX;
    const url = `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/VIIRS_SNPP_NRT/${west},${south},${east},${north}/2`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Crucix/2.0-Korea' },
    });
    clearTimeout(timer);

    if (!res.ok) return { status: 'error', error: `HTTP ${res.status}`, fires: [] };
    const text = await res.text();
    const lines = text.trim().split('\n');
    if (lines.length < 2) return { status: 'ok', fires: [] };

    const headers = lines[0].split(',');
    const fires = lines.slice(1).map(line => {
      const vals = line.split(',');
      const obj = {};
      headers.forEach((h, i) => { obj[h.trim()] = vals[i]?.trim(); });
      return {
        lat: parseFloat(obj.latitude),
        lon: parseFloat(obj.longitude),
        brightness: parseFloat(obj.bright_ti4),
        frp: parseFloat(obj.frp),
        confidence: obj.confidence,
        date: obj.acq_date,
        time: obj.acq_time,
        daynight: obj.daynight,
      };
    }).filter(f => !isNaN(f.lat) && !isNaN(f.lon));

    const highIntensity = fires.filter(f => f.frp > 5).sort((a, b) => b.frp - a.frp);
    const nightFires = fires.filter(f => f.daynight === 'N');

    return {
      status: 'ok',
      totalDetections: fires.length,
      highIntensity: highIntensity.slice(0, 20),
      nightDetections: nightFires.length,
      fires,
    };
  } catch (e) {
    return { status: 'error', error: e.message, fires: [] };
  }
}

// === 6. 지진 정보 (Earthquake — USGS Korea filter) ===
async function fetchKoreaEarthquakes() {
  try {
    const url = `https://earthquake.usgs.gov/fdsnws/event/1/query?format=geojson&minlatitude=${KOREA_BBOX.south}&maxlatitude=${KOREA_BBOX.north}&minlongitude=${KOREA_BBOX.west}&maxlongitude=${KOREA_BBOX.east}&starttime=${daysAgo(7)}&orderby=time&limit=20`;
    const res = await safeFetch(url, { timeout: 10000 });
    const features = res?.features || [];
    return {
      status: 'ok',
      earthquakes: features.map(f => ({
        magnitude: f.properties?.mag,
        place: f.properties?.place,
        time: f.properties?.time ? new Date(f.properties.time).toISOString() : null,
        lat: f.geometry?.coordinates?.[1],
        lon: f.geometry?.coordinates?.[0],
        depth: f.geometry?.coordinates?.[2],
        tsunami: f.properties?.tsunami,
      })),
    };
  } catch (e) {
    return { status: 'error', error: e.message, earthquakes: [] };
  }
}

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// Classify severity based on keywords
function classifySeverity(text) {
  if (!text) return 'info';
  const t = text.toLowerCase();
  if (/긴급|대피|위험|사망|폭발|지진|쓰나미|emergency|critical|explosion/i.test(t)) return 'critical';
  if (/주의|경고|경보|화재|산불|태풍|홍수|warning|fire|flood|typhoon/i.test(t)) return 'warning';
  if (/안전|해제|완화|정보|clear|resolved/i.test(t)) return 'info';
  return 'notice';
}

// === Master Briefing ===
export async function briefing() {
  const [disasters, kma, fires, gdacs, firms, earthquakes] = await Promise.all([
    fetchDisasterMessages(),
    fetchKMAWarnings(),
    fetchForestFires(),
    fetchGDACS(),
    fetchKoreaFIRMS(),
    fetchKoreaEarthquakes(),
  ]);

  // Aggregate all geo points for map markers
  const geoPoints = [];

  // Disaster messages
  for (const item of disasters.items) {
    if (item.geo) {
      geoPoints.push({
        lat: item.geo.lat, lon: item.geo.lon,
        type: 'disaster', severity: item.severity,
        label: item.title?.slice(0, 60), region: item.geo.region,
      });
    }
  }

  // KMA weather warnings
  for (const item of kma.items) {
    if (item.geo) {
      geoPoints.push({
        lat: item.geo.lat, lon: item.geo.lon,
        type: 'weather', label: item.title?.slice(0, 60), region: item.geo.region,
      });
    }
  }

  // Forest fires
  for (const fire of fires.fires) {
    if (fire.geo) {
      geoPoints.push({
        lat: fire.geo.lat, lon: fire.geo.lon,
        type: 'wildfire', label: fire.title?.slice(0, 60), region: fire.geo.region,
      });
    }
  }

  // GDACS alerts
  for (const alert of gdacs.alerts) {
    geoPoints.push({
      lat: alert.lat, lon: alert.lon,
      type: 'gdacs', severity: alert.alertLevel,
      label: alert.title?.slice(0, 60), eventType: alert.eventType,
    });
  }

  // FIRMS thermal detections
  if (firms.fires?.length) {
    for (const f of firms.highIntensity || []) {
      geoPoints.push({
        lat: f.lat, lon: f.lon,
        type: 'thermal', frp: f.frp,
        label: `Thermal ${f.frp?.toFixed(1)}MW (${f.date} ${f.time})`,
      });
    }
  }

  // Earthquakes
  for (const eq of earthquakes.earthquakes || []) {
    if (eq.lat && eq.lon) {
      geoPoints.push({
        lat: eq.lat, lon: eq.lon,
        type: 'earthquake', magnitude: eq.magnitude,
        label: `M${eq.magnitude} ${eq.place}`,
      });
    }
  }

  // Generate signals
  const signals = [];
  const criticalDisasters = disasters.items.filter(d => d.severity === 'critical');
  if (criticalDisasters.length > 0) {
    signals.push(`긴급재난: ${criticalDisasters.length}건 — ${criticalDisasters.map(d => d.title?.slice(0, 30)).join(', ')}`);
  }
  if (firms.totalDetections > 5) {
    signals.push(`위성 화재감지: 한반도 내 ${firms.totalDetections}건 열점 탐지 (고강도 ${firms.highIntensity?.length || 0}건)`);
  }
  if (firms.nightDetections > 3) {
    signals.push(`야간 열점 ${firms.nightDetections}건 탐지 — 산불/화재 가능성`);
  }
  if ((earthquakes.earthquakes || []).some(eq => eq.magnitude >= 3.0)) {
    const big = earthquakes.earthquakes.filter(eq => eq.magnitude >= 3.0);
    signals.push(`지진 감지: ${big.length}건 (최대 M${Math.max(...big.map(e => e.magnitude)).toFixed(1)})`);
  }
  if (fires.fires?.length > 0) {
    signals.push(`산림청 산불: ${fires.fires.length}건 보고`);
  }
  if (kma.items.length > 0) {
    signals.push(`기상특보: ${kma.items.length}건 발효 중`);
  }

  return {
    source: 'Korea Disaster',
    timestamp: new Date().toISOString(),
    status: 'active',
    summary: {
      totalAlerts: disasters.items.length + kma.items.length + fires.fires.length + gdacs.alerts.length,
      criticalCount: criticalDisasters.length,
      thermalDetections: firms.totalDetections || 0,
      earthquakeCount: (earthquakes.earthquakes || []).length,
      forestFires: fires.fires?.length || 0,
      weatherWarnings: kma.items.length,
    },
    disasterMessages: disasters.items.slice(0, 15),
    weatherWarnings: kma.items.slice(0, 10),
    forestFires: fires.fires.slice(0, 10),
    gdacsAlerts: gdacs.alerts,
    thermalData: {
      totalDetections: firms.totalDetections || 0,
      highIntensity: firms.highIntensity || [],
      nightDetections: firms.nightDetections || 0,
    },
    earthquakes: earthquakes.earthquakes || [],
    geoPoints,
    signals,
  };
}

// Run standalone
if (process.argv[1]?.endsWith('korea-disaster.mjs')) {
  const data = await briefing();
  console.log(JSON.stringify(data, null, 2));
}
