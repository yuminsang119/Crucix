#!/usr/bin/env node
// Elevator Information Source — 한국승강기안전공단 API
// Fetches elevator details for buildings involved in fire incidents
// Critical for fire response: fire service mode, capacity, stop floors

import { safeFetch } from '../utils/fetch.mjs';

/**
 * Fetch elevator information from 승강기 정보 API
 * @param {string} address - Building address to search
 */
async function fetchElevatorsByAddress(address) {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) return { available: false, note: 'DATA_GO_KR_API_KEY not set' };

  try {
    const url = `http://apis.data.go.kr/B551166/ElevatorInformationService/getElevatorInformation?serviceKey=${encodeURIComponent(apiKey)}&address=${encodeURIComponent(address)}&numOfRows=50&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];

    return {
      available: true,
      elevators: items.map(e => ({
        elevatorNo: e.elevatorNo || e.elvtrAsNo || '',
        buildingName: e.buldNm || e.installationPlace || '',
        address: e.address1 || e.installAddr || '',
        elevatorType: e.elvtrKindNm || classifyElevatorType(e),
        capacity: parseInt(e.ratedCap) || 0,           // persons
        loadCapacity: parseInt(e.ratedLoad) || 0,       // kg
        speed: parseFloat(e.ratedSpeed) || 0,           // m/s
        floors: parseFloors(e.elvtrStopFloorCnt || e.stopFloorCnt),
        stopFloorCount: parseInt(e.elvtrStopFloorCnt || e.stopFloorCnt) || 0,
        manufacturer: e.mnfctCmpnyNm || e.manufacturerNm || '',
        installDate: e.installationDe || e.installDe || '',
        lastInspection: e.inspctDe || e.latestInspDe || '',
        inspectionResult: e.inspctResultNm || e.latestInspResultNm || '',
        fireServiceMode: detectFireServiceMode(e),
        operationStatus: e.elvtrOprtSttusCdNm || '정상',
        lat: parseFloat(e.lat) || null,
        lon: parseFloat(e.lon || e.lng) || null,
      })),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Fetch overall elevator statistics for a region
 */
async function fetchElevatorStats() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) return { available: false, note: 'DATA_GO_KR_API_KEY not set' };

  try {
    const url = `http://apis.data.go.kr/B551166/ElevatorInformationService/getElevatorInformation?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=100&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const totalCount = data?.response?.body?.totalCount || 0;
    const items = data?.response?.body?.items?.item || [];

    // Classify by type
    const byType = {};
    for (const item of items) {
      const type = item.elvtrKindNm || '기타';
      byType[type] = (byType[type] || 0) + 1;
    }

    return {
      available: true,
      totalRegistered: totalCount,
      sampleSize: items.length,
      byType,
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Classify elevator type from raw data
 */
function classifyElevatorType(item) {
  const kind = (item.elvtrKindCd || item.elvtrKindNm || '').toLowerCase();
  if (kind.includes('비상') || kind.includes('emergency')) return '비상용';
  if (kind.includes('화물') || kind.includes('freight') || kind.includes('cargo')) return '화물용';
  if (kind.includes('장애') || kind.includes('wheelchair')) return '장애인용';
  if (kind.includes('에스컬') || kind.includes('escalator')) return '에스컬레이터';
  return '승객용';
}

/**
 * Parse floor count/range into floor list
 */
function parseFloors(floorData) {
  if (!floorData) return [];
  const count = parseInt(floorData);
  if (count > 0) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  return [];
}

/**
 * Detect if elevator has fire service mode (소방운전)
 * Based on installation year (mandatory after 2005 for new buildings)
 * and elevator type
 */
function detectFireServiceMode(item) {
  const type = (item.elvtrKindNm || '').toLowerCase();
  if (type.includes('비상')) return true;

  const installYear = parseInt((item.installationDe || item.installDe || '').substring(0, 4));
  if (installYear >= 2005) return true; // Likely has fire service mode

  return false;
}

/**
 * Calculate elevator evacuation capacity
 * Used by evacuation simulator
 */
export function calculateElevatorEvacCapacity(elevators) {
  const emergencyElevators = elevators.filter(e => e.fireServiceMode);
  const totalCapacity = emergencyElevators.reduce((sum, e) => sum + (e.capacity || 0), 0);

  // Estimate trips needed
  const avgTripTime = 120; // seconds for one round trip (high-rise estimate)
  const tripsPerHour = Math.floor(3600 / avgTripTime);

  return {
    emergencyElevatorCount: emergencyElevators.length,
    totalCapacityPerTrip: totalCapacity,
    tripsPerHour,
    personsPerHour: totalCapacity * tripsPerHour,
    elevators: emergencyElevators.map(e => ({
      elevatorNo: e.elevatorNo,
      capacity: e.capacity,
      speed: e.speed,
      floors: e.stopFloorCount,
    })),
  };
}

// === Main Briefing ===

export async function briefing() {
  const results = {
    source: 'ElevatorInfo',
    description: 'Korean elevator safety information — capacity, fire service mode, inspection status',
    timestamp: new Date().toISOString(),
    stats: {},
    summary: {},
  };

  const [stats] = await Promise.allSettled([
    fetchElevatorStats(),
  ]);

  if (stats.status === 'fulfilled') {
    results.stats = stats.value;
    if (stats.value.available) {
      results.summary.totalRegistered = stats.value.totalRegistered;
      results.summary.byType = stats.value.byType;
    }
  }

  results.summary.dataAvailability = {
    stats: stats.status === 'fulfilled' && stats.value?.available,
  };

  return results;
}

// Export for on-demand queries by incident
export { fetchElevatorsByAddress, fetchElevatorStats };
