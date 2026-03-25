#!/usr/bin/env node
// Crucix Dashboard Data Synthesizer
// Reads runs/latest.json, fetches RSS news, generates signal-based ideas,
// and injects everything into dashboard/public/jarvis.html
//
// Exports synthesize(), generateIdeas(), fetchAllNews() for use by server.mjs

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { exec } from 'child_process';
import config from '../crucix.config.mjs';
import { createLLMProvider } from '../lib/llm/index.mjs';
import { generateLLMIdeas } from '../lib/llm/ideas.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// === Helpers ===
const cyrillic = /[\u0400-\u04FF]/;
function isEnglish(text) {
  if (!text) return false;
  return !cyrillic.test(text.substring(0, 80));
}

// === Geo-tagging keyword map ===
const geoKeywords = {
  'Ukraine':[49,32],'Russia':[56,38],'Moscow':[55.7,37.6],'Kyiv':[50.4,30.5],
  'China':[35,105],'Beijing':[39.9,116.4],'Iran':[32,53],'Tehran':[35.7,51.4],
  'Israel':[31.5,35],'Gaza':[31.4,34.4],'Palestine':[31.9,35.2],
  'Syria':[35,38],'Iraq':[33,44],'Saudi':[24,45],'Yemen':[15,48],'Lebanon':[34,36],
  'India':[20,78],'Japan':[36,138],'Korea':[37,127],'Pyongyang':[39,125.7],
  'Taiwan':[23.5,121],'Philippines':[13,122],'Myanmar':[20,96],
  'Canada':[56,-96],'Mexico':[23,-102],'Brazil':[-14,-51],'Argentina':[-38,-63],
  'Colombia':[4,-74],'Venezuela':[7,-66],'Cuba':[22,-80],'Chile':[-35,-71],
  'Germany':[51,10],'France':[46,2],'UK':[54,-2],'Britain':[54,-2],'London':[51.5,-0.1],
  'Spain':[40,-4],'Italy':[42,12],'Poland':[52,20],'NATO':[50,4],'EU':[50,4],
  'Turkey':[39,35],'Greece':[39,22],'Romania':[46,25],'Finland':[64,26],'Sweden':[62,15],
  'Africa':[0,20],'Nigeria':[10,8],'South Africa':[-30,25],'Kenya':[-1,38],
  'Egypt':[27,30],'Libya':[27,17],'Sudan':[13,30],'Ethiopia':[9,38],
  'Somalia':[5,46],'Congo':[-4,22],'Uganda':[1,32],'Morocco':[32,-6],
  'Pakistan':[30,70],'Afghanistan':[33,65],'Bangladesh':[24,90],
  'Australia':[-25,134],'Indonesia':[-2,118],'Thailand':[15,100],
  'US':[39,-98],'America':[39,-98],'Washington':[38.9,-77],'Pentagon':[38.9,-77],
  'Trump':[38.9,-77],'White House':[38.9,-77],
  'Wall Street':[40.7,-74],'New York':[40.7,-74],'California':[37,-120],
  'Nepal':[28,84],'Cambodia':[12.5,105],'Malawi':[-13.5,34],'Burundi':[-3.4,29.9],
  'Oman':[21,57],'Netherlands':[52.1,5.3],'Gabon':[-0.8,11.6],
  'Peru':[-10,-76],'Ecuador':[-2,-78],'Bolivia':[-17,-65],
  'Singapore':[1.35,103.8],'Malaysia':[4.2,101.9],'Vietnam':[16,108],
  'Algeria':[28,3],'Tunisia':[34,9],'Zimbabwe':[-20,30],'Mozambique':[-18,35],
  // Americas expansion
  'Texas':[31,-100],'Florida':[28,-82],'Chicago':[41.9,-87.6],'Los Angeles':[34,-118],
  'San Francisco':[37.8,-122.4],'Seattle':[47.6,-122.3],'Miami':[25.8,-80.2],
  'Toronto':[43.7,-79.4],'Ottawa':[45.4,-75.7],'Vancouver':[49.3,-123.1],
  'São Paulo':[-23.5,-46.6],'Rio':[-22.9,-43.2],'Buenos Aires':[-34.6,-58.4],
  'Bogotá':[4.7,-74.1],'Lima':[-12,-77],'Santiago':[-33.4,-70.7],
  'Caracas':[10.5,-66.9],'Havana':[23.1,-82.4],'Panama':[9,-79.5],
  'Guatemala':[14.6,-90.5],'Honduras':[14.1,-87.2],'El Salvador':[13.7,-89.2],
  'Costa Rica':[10,-84],'Jamaica':[18.1,-77.3],'Haiti':[19,-72],
  'Dominican':[18.5,-70],'Puerto Rico':[18.2,-66.5],
  // More Asia-Pacific
  'Sri Lanka':[7,80],'Hong Kong':[22.3,114.2],'Taipei':[25,121.5],
  'Seoul':[37.6,127],'Osaka':[34.7,135.5],'Mumbai':[19.1,72.9],
  'Delhi':[28.6,77.2],'Shanghai':[31.2,121.5],'Shenzhen':[22.5,114.1],
  'Auckland':[-36.8,174.8],'Papua New Guinea':[-6.3,147],
  // More Europe
  'Berlin':[52.5,13.4],'Paris':[48.9,2.3],'Madrid':[40.4,-3.7],
  'Rome':[41.9,12.5],'Warsaw':[52.2,21],'Prague':[50.1,14.4],
  'Vienna':[48.2,16.4],'Budapest':[47.5,19.1],'Bucharest':[44.4,26.1],
  'Kyiv':[50.4,30.5],'Oslo':[59.9,10.7],'Copenhagen':[55.7,12.6],
  'Brussels':[50.8,4.4],'Zurich':[47.4,8.5],'Dublin':[53.3,-6.3],
  'Lisbon':[38.7,-9.1],'Athens':[37.9,23.7],'Minsk':[53.9,27.6],
  // More Africa
  'Nairobi':[-1.3,36.8],'Lagos':[6.5,3.4],'Accra':[5.6,-0.2],
  'Addis Ababa':[9,38.7],'Cape Town':[-33.9,18.4],'Johannesburg':[-26.2,28],
  'Kinshasa':[-4.3,15.3],'Khartoum':[15.6,32.5],'Mogadishu':[2.1,45.3],
  'Dakar':[14.7,-17.5],'Abuja':[9.1,7.5],
  // Tech/Economy keywords with US locations
  'Fed':[38.9,-77],'Congress':[38.9,-77],'Senate':[38.9,-77],
  'Silicon Valley':[37.4,-122],'NASA':[28.6,-80.6],'Pentagon':[38.9,-77],
  'IMF':[38.9,-77],'World Bank':[38.9,-77],'UN':[40.7,-74],
};

function geoTagText(text) {
  if (!text) return null;
  for (const [keyword, [lat, lon]] of Object.entries(geoKeywords)) {
    if (text.includes(keyword)) {
      return { lat, lon, region: keyword };
    }
  }
  return null;
}

function sanitizeExternalUrl(raw) {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

function sumAirHotspots(hotspots = []) {
  return hotspots.reduce((sum, hotspot) => sum + (hotspot.totalAircraft || 0), 0);
}

function summarizeAirHotspots(hotspots = []) {
  return hotspots.map(h => ({
    region: h.region,
    total: h.totalAircraft || 0,
    noCallsign: h.noCallsign || 0,
    highAlt: h.highAltitude || 0,
    top: Object.entries(h.byCountry || {}).sort((a, b) => b[1] - a[1]).slice(0, 5),
  }));
}

function loadOpenSkyFallback(currentTimestamp) {
  const runsDir = join(ROOT, 'runs');
  if (!existsSync(runsDir)) return null;

  const currentMs = currentTimestamp ? new Date(currentTimestamp).getTime() : NaN;
  const files = readdirSync(runsDir)
    .filter(name => /^briefing_.*\.json$/.test(name))
    .sort()
    .reverse();

  for (const file of files) {
    const filePath = join(runsDir, file);
    try {
      const prior = JSON.parse(readFileSync(filePath, 'utf8'));
      const priorTimestamp = prior.sources?.OpenSky?.timestamp || prior.crucix?.timestamp || null;
      if (priorTimestamp && Number.isFinite(currentMs) && new Date(priorTimestamp).getTime() >= currentMs) continue;

      const hotspots = prior.sources?.OpenSky?.hotspots || [];
      if (sumAirHotspots(hotspots) > 0) {
        return { file, timestamp: priorTimestamp, hotspots };
      }
    } catch {
      // Ignore unreadable historical runs and continue searching backward.
    }
  }

  return null;
}

// === RSS Fetching ===
async function fetchRSS(url, source) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const xml = await res.text();
    const items = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const block = match[1];
      const title = (block.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '').trim();
      const link = sanitizeExternalUrl((block.match(/<link>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/link>/)?.[1] || '').trim());
      const pubDate = block.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      if (title && title !== source) items.push({ title, date: pubDate, source, url: link || undefined });
    }
    return items;
  } catch (e) {
    console.log(`RSS fetch failed (${source}):`, e.message);
    return [];
  }
}

const RSS_SOURCE_FALLBACKS = {
  'SBS Australia': { lat: -35.2809, lon: 149.13, region: 'Australia' },
  'Indian Express': { lat: 28.6139, lon: 77.209, region: 'India' },
  'The Hindu': { lat: 13.0827, lon: 80.2707, region: 'India' },
  'MercoPress': { lat: -34.9011, lon: -56.1645, region: 'South America' }
};
const REGIONAL_NEWS_SOURCES = ['MercoPress', 'Indian Express', 'The Hindu', 'SBS Australia'];

export async function fetchAllNews() {
  const feeds = [
    // Global
    ['http://feeds.bbci.co.uk/news/world/rss.xml', 'BBC'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/World.xml', 'NYT'],
    ['https://www.aljazeera.com/xml/rss/all.xml', 'Al Jazeera'],
    // USA
    ['https://feeds.npr.org/1001/rss.xml', 'NPR'],
    ['https://feeds.bbci.co.uk/news/technology/rss.xml', 'BBC Tech'],
    ['http://feeds.bbci.co.uk/news/science_and_environment/rss.xml', 'BBC Science'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Americas.xml', 'NYT Americas'],
    // Europe
    ['https://rss.dw.com/rdf/rss-en-all', 'DW'],
    ['https://www.france24.com/en/rss', 'France 24'],
    ['https://www.euronews.com/rss?format=mrss', 'Euronews'],
    // Africa & Cameroon region
    ['https://rss.dw.com/rdf/rss-en-africa', 'DW Africa'],
    ['https://www.rfi.fr/en/rss', 'RFI'],
    ['https://www.africanews.com/feed/rss', 'Africa News'],
    ['https://rss.nytimes.com/services/xml/rss/nyt/Africa.xml', 'NYT Africa'],
    // Asia-Pacific
    ['https://rss.nytimes.com/services/xml/rss/nyt/AsiaPacific.xml', 'NYT Asia'],
    ['https://www.sbs.com.au/news/topic/australia/feed', 'SBS Australia'],
    // India
    ['https://indianexpress.com/section/india/feed/', 'Indian Express'],
    ['https://www.thehindu.com/news/national/feeder/default.rss', 'The Hindu'],
    // South America
    ['https://en.mercopress.com/rss/latin-america', 'MercoPress'],
  ];

  const results = await Promise.allSettled(
    feeds.map(([url, source]) => fetchRSS(url, source))
  );

  const allNews = results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);

  // De-duplicate and geo-tag
  const seen = new Set();
  const geoNews = [];
  for (const item of allNews) {
    const key = item.title.substring(0, 40).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const geo = geoTagText(item.title) || RSS_SOURCE_FALLBACKS[item.source];
    if (geo) {
      geoNews.push({
        title: item.title.substring(0, 100),
        source: item.source,
        date: item.date,
        url: item.url,
        lat: geo.lat + (Math.random() - 0.5) * 2,
        lon: geo.lon + (Math.random() - 0.5) * 2,
        region: geo.region
      });
    }
  }

  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const filtered = geoNews.filter(n => !n.date || new Date(n.date) >= cutoff);
  filtered.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.source}|${item.title}|${item.date}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  // Reserve a little space so newly-added regional feeds are not crowded out by larger globals.
  for (const source of REGIONAL_NEWS_SOURCES) {
    filtered.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  filtered.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === Leverageable Ideas → Fire Response Strategies from Signals ===
export function generateIdeas(V2) {
  const ideas = [];
  const thermal = V2.thermal || [];
  const totalThermal = thermal.reduce((s, t) => s + (t.det || 0), 0);
  const weather = V2.weather || {};
  const fireRisk = V2.fireRisk || {};
  const e119 = V2.emergency119 || {};
  const snsFire = V2.snsFire || {};

  // 1. Thermal + Dry/Windy weather → wildfire dispatch
  if (totalThermal > 100 && weather.humidity < 30 && weather.windSpeed > 7) {
    ideas.push({
      title: '산불 확산 위험',
      text: `열점 ${totalThermal.toLocaleString()}건 + 습도 ${weather.humidity}% + 풍속 ${weather.windSpeed}m/s. 건조+강풍 조건으로 산불 확산 우려. 소방헬기 선제 배치 권고.`,
      type: 'DISPATCH', confidence: 'High', horizon: '즉시',
      resources: ['소방헬기', '산림청 진화대'],
    });
  }

  // 2. High fire risk index
  if (fireRisk.summary?.overallRisk === 'HIGH') {
    ideas.push({
      title: '산불위험지수 경보',
      text: `산불위험지수 고위험 지역 ${fireRisk.summary.highFireRiskRegions || 0}곳. 예방순찰 강화 및 임산물 소각 금지 조치 권고.`,
      type: 'MONITOR', confidence: 'High', horizon: '수시간',
    });
  }

  // 3. Multiple 119 calls → confirmed large incident
  const fireAlerts = e119.summary?.fireRelatedAlerts || 0;
  if (fireAlerts > 3) {
    ideas.push({
      title: '다수 화재 신고',
      text: `화재 관련 신고 ${fireAlerts}건 접수. 복수 신고는 대형 화재 가능성 시사. 대응 2단계 이상 검토.`,
      type: 'REINFORCE', confidence: 'High', horizon: '즉시',
    });
  }

  // 4. Hospital bed shortage
  const beds = e119.summary?.totalAvailableBeds;
  if (beds !== undefined && beds < 10) {
    ideas.push({
      title: '응급실 병상 부족',
      text: `가용 응급 병상 ${beds}석. 다수 사상자 발생 시 원거리 이송 필요. 인근 2차 병원 사전 연락 권고.`,
      type: 'MONITOR', confidence: 'Medium', horizon: '수시간',
    });
  }

  // 5. SNS cross-platform fire signals
  const highConfSns = snsFire.summary?.highConfidenceSignals || 0;
  if (highConfSns > 0) {
    ideas.push({
      title: 'SNS 교차 확인 화재',
      text: `${highConfSns}건의 고신뢰 SNS 화재 신호 (${snsFire.summary?.activePlatforms || 0}개 플랫폼). 현장 확인 및 출동 준비 권고.`,
      type: 'DISPATCH', confidence: highConfSns >= 3 ? 'High' : 'Medium', horizon: '즉시',
    });
  }

  // 6. Strong wind + thermal → fire spread prediction
  if (weather.windSpeed > 10 && totalThermal > 50) {
    ideas.push({
      title: '화재 확산 벡터 활성',
      text: `풍속 ${weather.windSpeed}m/s (${weather.windDirection || '알 수 없음'}방향) + 열점 ${totalThermal}건. 풍하측 대피 경로 확보 및 방어선 구축 권고.`,
      type: 'EVACUATE', confidence: 'Medium', horizon: '즉시',
      resources: ['대피 안내팀', '방호복'],
    });
  }

  // 7. NOAA severe weather + fire conditions
  const noaaAlerts = V2.noaa?.totalAlerts || 0;
  if (noaaAlerts > 0 && totalThermal > 30) {
    ideas.push({
      title: '기상 경보 + 화재 복합',
      text: `기상 경보 ${noaaAlerts}건 발효 중 + 열점 ${totalThermal}건. 기상 악화 시 진화 작업 중단 가능성. 교대 인력 확보 권고.`,
      type: 'REINFORCE', confidence: 'Medium', horizon: '수시간',
    });
  }

  // 8. Building fire risk
  const highRiskBuildings = V2.buildingInfo?.summary?.highRiskBuildings || 0;
  if (highRiskBuildings > 5) {
    ideas.push({
      title: '고위험 건물 집중 지역',
      text: `고위험 건물 ${highRiskBuildings}동 감지. 노후 건물 밀집 지역 우선 순찰 및 소방시설 점검 권고.`,
      type: 'MONITOR', confidence: 'Medium', horizon: '일일',
    });
  }

  return ideas.slice(0, 8);
}

// === Synthesize raw sweep data into fire control room dashboard format ===
// Normalizes all sources into ontology-aware entities for the COP display
export async function synthesize(data) {
  // === Tier 1: Fire Detection (FIRMS thermal) ===
  const thermal = (data.sources.FIRMS?.hotspots || []).map(h => ({
    region: h.region, det: h.totalDetections || 0, night: h.nightDetections || 0,
    hc: h.highConfidence || 0,
    fires: (h.highIntensity || []).slice(0, 8).map(f => ({ lat: f.lat, lon: f.lon, frp: f.frp || 0 }))
  }));
  const tSignals = data.sources.FIRMS?.signals || [];
  const totalThermal = thermal.reduce((s, t) => s + t.det, 0);

  // === Tier 1: KMA Weather ===
  const kmaData = data.sources.KMA || {};
  const weather = {
    windSpeed: kmaData.stations?.[0]?.windSpeed ?? null,
    windDirection: kmaData.stations?.[0]?.windDirection ?? null,
    humidity: kmaData.stations?.[0]?.humidity ?? null,
    temperature: kmaData.stations?.[0]?.temperature ?? null,
    precipitation: kmaData.stations?.[0]?.precipitation1h ?? null,
    fireWeatherRisk: kmaData.fireWeatherRisk ?? null,
    fireWeatherRiskLabel: kmaData.summary?.fireWeatherRiskLabel ?? null,
    warnings: kmaData.warnings || [],
    apiAvailable: kmaData.summary?.apiAvailable || false,
    stations: kmaData.stations || [],
  };

  // === Tier 1: Fire Risk Index ===
  const fireRiskData = data.sources.FireRisk || {};
  const fireRisk = {
    disasterAlerts: (fireRiskData.disasterAlerts || []).slice(0, 20),
    forestFireRisk: fireRiskData.forestFireRisk || {},
    fireStations: fireRiskData.fireStations || {},
    summary: fireRiskData.summary || {},
  };

  // === Tier 1: 119 Emergency ===
  const e119Data = data.sources.Emergency119 || {};
  const emergency119 = {
    incidents: e119Data.incidents || {},
    waterSupply: e119Data.waterSupply || {},
    hazmatFacilities: e119Data.hazmatFacilities || {},
    hospitals: e119Data.hospitals || {},
    summary: e119Data.summary || {},
  };

  // === Tier 2: Building & Elevator ===
  const buildingInfo = data.sources.BuildingInfo || {};
  const elevatorInfo = data.sources.ElevatorInfo || {};

  // === Tier 3: SNS Fire + Telegram ===
  const snsFireData = data.sources['SNS-Fire'] || {};
  const snsFire = {
    platforms: snsFireData.platforms || {},
    fusedSignals: (snsFireData.fusedSignals || []).slice(0, 20),
    summary: snsFireData.summary || {},
  };

  const tgData = data.sources.Telegram || {};
  const tgUrgent = (tgData.urgentPosts || []).map(p => ({
    channel: p.channel, text: p.text?.substring(0, 200), views: p.views, date: p.date, urgentFlags: p.urgentFlags || []
  }));
  const tgTop = (tgData.topPosts || []).map(p => ({
    channel: p.channel, text: p.text?.substring(0, 200), views: p.views, date: p.date, urgentFlags: []
  }));

  // === Tier 4: Environment & Health ===
  const nuke = (data.sources.Safecast?.sites || []).map(s => ({
    site: s.site, anom: s.anomaly || false, cpm: s.avgCPM, n: s.recentReadings || 0
  }));
  const nukeSignals = (data.sources.Safecast?.signals || []).filter(s => s);
  const who = (data.sources.WHO?.diseaseOutbreakNews || []).slice(0, 10).map(w => ({
    title: w.title?.substring(0, 120), date: w.date, summary: w.summary?.substring(0, 150)
  }));
  const noaa = {
    totalAlerts: data.sources.NOAA?.totalSevereAlerts || 0,
    alerts: (data.sources.NOAA?.topAlerts || []).filter(a => a.lat != null && a.lon != null).slice(0, 10).map(a => ({
      event: a.event, severity: a.severity, headline: a.headline?.substring(0, 120),
      lat: a.lat, lon: a.lon
    }))
  };
  const epaData = data.sources.EPA || {};
  const epaStations = [];
  const seenEpa = new Set();
  for (const r of (epaData.readings || [])) {
    if (r.lat == null || r.lon == null) continue;
    const key = `${r.lat},${r.lon}`;
    if (seenEpa.has(key)) continue;
    seenEpa.add(key);
    epaStations.push({ location: r.location, state: r.state, lat: r.lat, lon: r.lon, analyte: r.analyte, result: r.result, unit: r.unit });
  }
  const epa = { totalReadings: epaData.totalReadings || 0, stations: epaStations.slice(0, 10) };

  // === Tier 5: GDELT News ===
  const gdeltData = data.sources.GDELT || {};
  const gdelt = {
    totalArticles: gdeltData.totalArticles || 0,
    topTitles: (gdeltData.allArticles || []).slice(0, 5).map(a => a.title?.substring(0, 80)),
    geoPoints: (gdeltData.geoPoints || []).slice(0, 20).map(p => ({
      lat: p.lat, lon: p.lon, name: (p.name || '').substring(0, 80), count: p.count || 1
    }))
  };

  // === Source Health ===
  const health = Object.entries(data.sources || {}).map(([name, src]) => ({
    n: name, err: Boolean(src?.error), stale: Boolean(src?.stale)
  }));

  // === Hydrants / Hazmat / Hospitals as map entities ===
  const hydrants = (e119Data.waterSupply?.hydrants || []).filter(h => h.lat && h.lon).slice(0, 100);
  const hazmatFacilities = (e119Data.hazmatFacilities?.facilities || []).filter(f => f.lat && f.lon).slice(0, 50);
  const hospitals = (e119Data.hospitals?.hospitals || []).filter(h => h.lat && h.lon).slice(0, 30);
  const fireStationsList = (fireRiskData.fireStations?.stations || []).filter(s => s.lat && s.lon).slice(0, 50);

  // === Backward compatibility: provide stub fields the dashboard JS expects ===
  const air = [];
  const fred = [];
  const energy = { wti: null, brent: null, natgas: null, wtiRecent: [], signals: [] };
  const bls = [];
  const treasury = { totalDebt: '0', signals: [] };
  const gscpi = null;
  const acled = { totalEvents: 0, totalFatalities: 0, byRegion: {}, byType: {}, deadliestEvents: [] };
  const space = { totalNewObjects: 0, recentLaunches: [], signals: [] };
  const markets = { indexes: [], rates: [], commodities: [], crypto: [], vix: null, timestamp: null };

  // Fetch RSS (fire/disaster focused)
  const news = await fetchAllNews();

  // === Build synthesized output (COP data) ===
  const V2 = {
    meta: data.crucix,
    // Fire-specific data
    thermal, tSignals, totalThermal,
    weather,
    fireRisk,
    emergency119,
    snsFire,
    buildingInfo: { summary: buildingInfo.summary || {} },
    elevatorInfo: { summary: elevatorInfo.summary || {} },
    // Map entities (for COP overlay)
    hydrants,
    hazmatFacilities,
    hospitals,
    fireStations: fireStationsList,
    // Environment
    nuke, nukeSignals, noaa, epa, who,
    // News & OSINT
    tg: { posts: tgData.totalPosts || 0, urgent: tgUrgent, topPosts: tgTop },
    gdelt,
    // Backward-compatible stubs (dashboard JS references these)
    air, fred, energy, bls, treasury, gscpi, acled, space, markets,
    chokepoints: [], sdr: { total: 0, online: 0, zones: [] }, defense: [],
    airMeta: { fallback: false, liveTotal: 0, timestamp: data.crucix?.timestamp, source: 'N/A' },
    // Output
    health, news,
    ideas: [], ideasSource: 'disabled',
    newsFeed: buildNewsFeed(news, gdeltData, tgUrgent, tgTop),
    // Ontology (populated by server.mjs after synthesis)
    incidents: null,
    processedCalls: null,
  };

  return V2;
}

// === Unified News Feed for Ticker ===
function buildNewsFeed(rssNews, gdeltData, tgUrgent, tgTop) {
  const feed = [];

  // RSS news
  for (const n of rssNews) {
    feed.push({
      headline: n.title, source: n.source, type: 'rss',
      timestamp: n.date, region: n.region, urgent: false, url: n.url
    });
  }

  // GDELT top articles
  for (const a of (gdeltData.allArticles || []).slice(0, 10)) {
    if (a.title) {
      const geo = geoTagText(a.title);
      feed.push({
        headline: a.title.substring(0, 100), source: 'GDELT', type: 'gdelt',
        timestamp: new Date().toISOString(), region: geo?.region || 'Global', urgent: false, url: sanitizeExternalUrl(a.url)
      });
    }
  }

  // Telegram urgent
  for (const p of tgUrgent.slice(0, 10)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      headline: text.substring(0, 100), source: p.channel?.toUpperCase() || 'TELEGRAM',
      type: 'telegram', timestamp: p.date, region: 'OSINT', urgent: true
    });
  }

  // Telegram top (non-urgent)
  for (const p of tgTop.slice(0, 5)) {
    const text = (p.text || '').replace(/[\u{1F1E0}-\u{1F1FF}]/gu, '').trim();
    feed.push({
      headline: text.substring(0, 100), source: p.channel?.toUpperCase() || 'TELEGRAM',
      type: 'telegram', timestamp: p.date, region: 'OSINT', urgent: false
    });
  }

  // Filter to last 30 days, sort by timestamp descending, limit to 50
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const recent = feed.filter(item => !item.timestamp || new Date(item.timestamp) >= cutoff);
  recent.sort((a, b) => new Date(b.timestamp || 0) - new Date(a.timestamp || 0));

  const selected = [];
  const selectedKeys = new Set();
  const keyFor = item => `${item.type}|${item.source}|${item.headline}|${item.timestamp}`;
  const pushUnique = item => {
    const key = keyFor(item);
    if (selectedKeys.has(key)) return;
    selected.push(item);
    selectedKeys.add(key);
  };

  for (const source of REGIONAL_NEWS_SOURCES) {
    recent.filter(item => item.source === source).slice(0, 2).forEach(pushUnique);
  }
  recent.forEach(pushUnique);
  return selected.slice(0, 50);
}

// === CLI Mode: inject into HTML file ===
function getCliArg(flag) {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

async function cliInject() {
  const data = JSON.parse(readFileSync(join(ROOT, 'runs/latest.json'), 'utf8'));
  const htmlOverride = getCliArg('--html');
  const shouldOpen = !process.argv.includes('--no-open');

  console.log('Fetching RSS news feeds...');
  const V2 = await synthesize(data);
  const llmProvider = createLLMProvider(config.llm);

  if (llmProvider?.isConfigured) {
    try {
      console.log(`[LLM] Generating ideas via ${llmProvider.name}...`);
      const llmIdeas = await generateLLMIdeas(llmProvider, V2, null, []);
      if (llmIdeas?.length) {
        V2.ideas = llmIdeas;
        V2.ideasSource = 'llm';
        console.log(`[LLM] Generated ${llmIdeas.length} ideas`);
      } else {
        V2.ideas = [];
        V2.ideasSource = 'llm-failed';
        console.log('[LLM] No ideas returned');
      }
    } catch (err) {
      V2.ideas = [];
      V2.ideasSource = 'llm-failed';
      console.log('[LLM] Idea generation failed:', err.message);
    }
  } else {
    V2.ideas = [];
    V2.ideasSource = 'disabled';
  }
  console.log(`Generated ${V2.ideas.length} leverageable ideas`);

  const json = JSON.stringify(V2);
  console.log('\n--- Synthesis ---');
  console.log('Size:', json.length, 'bytes | Air:', V2.air.length, '| Thermal:', V2.thermal.length,
    '| News:', V2.news.length, '| Ideas:', V2.ideas.length, '| Sources:', V2.health.length);

  const htmlPath = htmlOverride || join(ROOT, 'dashboard/public/jarvis.html');
  let html = readFileSync(htmlPath, 'utf8');
  // Use a replacer function so JSON is inserted literally even if it contains `$`.
  html = html.replace(/^(let|const) D = .*;\s*$/m, () => 'let D = ' + json + ';');
  writeFileSync(htmlPath, html);
  console.log('Data injected into jarvis.html!');

  if (!shouldOpen) return;

  // Auto-open dashboard in default browser
  // NOTE: On Windows, `start` in PowerShell is an alias for Start-Service, not cmd's start.
  // We must use `cmd /c start ""` to ensure it works in both cmd.exe and PowerShell.
  const openCmd = process.platform === 'win32' ? 'cmd /c start ""' :
                  process.platform === 'darwin' ? 'open' : 'xdg-open';
  const dashUrl = htmlPath.replace(/\\/g, '/');
  exec(`${openCmd} "${dashUrl}"`, (err) => {
    if (err) console.log('Could not auto-open browser:', err.message);
    else console.log('Dashboard opened in browser!');
  });
}

// Run CLI if invoked directly
const isMain = process.argv[1]
  && fileURLToPath(import.meta.url).replace(/\\/g, '/') === process.argv[1].replace(/\\/g, '/');
if (isMain) {
  await cliInject();
}
