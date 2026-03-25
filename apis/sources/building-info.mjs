#!/usr/bin/env node
// Building Information Source — 건축물대장 API
// Fetches building details from Korea's national building registry
// Used for fire response: structure type, floors, fire equipment, hazmat

import { safeFetch } from '../utils/fetch.mjs';

/**
 * Fetch building info from 건축물대장 표제부 API
 * @param {string} sigunguCd - 시군구코드 (5 digits)
 * @param {string} bjdongCd - 법정동코드 (5 digits)
 */
async function fetchBuildingRegistry(sigunguCd, bjdongCd) {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) return { available: false, note: 'DATA_GO_KR_API_KEY not set' };

  try {
    const url = `http://apis.data.go.kr/1613000/BldRgstService_v2/getBrTitleInfo?serviceKey=${encodeURIComponent(apiKey)}&sigunguCd=${sigunguCd}&bjdongCd=${bjdongCd}&numOfRows=50&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];

    return {
      available: true,
      buildings: items.map(b => ({
        name: b.bldNm || '건물명 없음',
        address: `${b.platPlc || ''} ${b.newPlatPlc || ''}`.trim(),
        mainUse: b.mainPurpsCdNm || '',
        floors: {
          above: parseInt(b.grndFlrCnt) || 0,
          below: parseInt(b.ugrndFlrCnt) || 0,
        },
        structure: b.strctCdNm || '',
        totalArea: parseFloat(b.totArea) || 0,
        buildDate: b.useAprDay || b.crtnDay || '',
        buildYear: parseInt((b.useAprDay || '').substring(0, 4)) || null,
        // Fire safety assessment
        age: b.useAprDay ? new Date().getFullYear() - parseInt(b.useAprDay.substring(0, 4)) : null,
      })),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Fetch fire safety equipment info for a building
 * 소방시설 정보 (스프링클러, 자동화재탐지설비 등)
 */
async function fetchFireSafetyEquipment() {
  const apiKey = process.env.DATA_GO_KR_API_KEY;
  if (!apiKey) return { available: false };

  try {
    const url = `http://apis.data.go.kr/1160000/service/GetFireSafetyEquipService/getFireSafetyEquipList?serviceKey=${encodeURIComponent(apiKey)}&numOfRows=100&pageNo=1&resultType=json`;

    const res = await safeFetch(url, { timeout: 15000 });
    if (!res.ok) return { available: false, error: `HTTP ${res.status}` };

    const data = await res.json();
    const items = data?.response?.body?.items?.item || [];

    return {
      available: true,
      equipment: items.map(e => ({
        buildingName: e.bldNm || '',
        address: e.addr || '',
        sprinkler: e.sprinklerYn === 'Y',
        fireAlarm: e.fireAlarmYn === 'Y',
        emergencyBroadcast: e.emergBroadcastYn === 'Y',
        smokeControl: e.smokeCtrlYn === 'Y',
        emergencyExits: parseInt(e.emergExitCnt) || 0,
        fireDoors: parseInt(e.fireDoorCnt) || 0,
        lat: parseFloat(e.lat) || null,
        lon: parseFloat(e.lon || e.lng) || null,
      })).filter(e => e.lat && e.lon),
    };
  } catch (e) {
    return { available: false, error: e.message };
  }
}

/**
 * Estimate building occupancy based on use type and area
 */
function estimateOccupancy(mainUse, totalArea) {
  // Korean fire code occupancy load factors (approximate m² per person)
  const loadFactors = {
    '업무시설': 10,      // Office
    '근린생활시설': 5,    // Neighborhood facility
    '판매시설': 3,        // Retail
    '숙박시설': 15,       // Accommodation
    '의료시설': 8,        // Medical
    '교육연구시설': 5,    // Education
    '노유자시설': 8,      // Elderly/children
    '공장': 20,          // Factory
    '창고시설': 50,       // Warehouse
    '주거시설': 20,       // Residential
    '공동주택': 25,       // Apartments
  };

  const factor = Object.entries(loadFactors).find(([key]) => mainUse?.includes(key));
  return factor ? Math.round(totalArea / factor[1]) : Math.round(totalArea / 10);
}

/**
 * Assess fire risk based on building properties
 */
function assessBuildingFireRisk(building) {
  let risk = 0;
  const factors = [];

  // Age risk
  if (building.age > 30) {
    risk += 2;
    factors.push(`노후 건물 (${building.age}년)`);
  } else if (building.age > 20) {
    risk += 1;
    factors.push(`준노후 (${building.age}년)`);
  }

  // High-rise risk
  if (building.floors.above > 10) {
    risk += 2;
    factors.push(`고층 (${building.floors.above}층)`);
  } else if (building.floors.above > 5) {
    risk += 1;
  }

  // Underground floors risk
  if (building.floors.below > 2) {
    risk += 1;
    factors.push(`심층 지하 (지하 ${building.floors.below}층)`);
  }

  // Use type risk
  const highRiskUses = ['공장', '창고', '판매', '숙박', '노유자'];
  if (highRiskUses.some(u => building.mainUse?.includes(u))) {
    risk += 1;
    factors.push(`고위험 용도 (${building.mainUse})`);
  }

  const riskLevel = risk >= 4 ? 'HIGH' : risk >= 2 ? 'MODERATE' : 'LOW';

  return {
    riskScore: risk,
    riskLevel,
    factors,
    occupancy: estimateOccupancy(building.mainUse, building.totalArea),
  };
}

// === Main Briefing ===

export async function briefing() {
  const results = {
    source: 'BuildingInfo',
    description: 'Korean building registry — structure, fire safety, risk assessment',
    timestamp: new Date().toISOString(),
    buildings: {},
    fireSafety: {},
    summary: {},
  };

  const [registry, safety] = await Promise.allSettled([
    // Default: fetch buildings in Seoul (Gangnam-gu) as sample
    // In production, this would be called on-demand for specific incident locations
    fetchBuildingRegistry('11680', '10300'),
    fetchFireSafetyEquipment(),
  ]);

  if (registry.status === 'fulfilled') {
    results.buildings = registry.value;
    if (registry.value.available && registry.value.buildings) {
      // Add risk assessment to each building
      results.buildings.buildings = registry.value.buildings.map(b => ({
        ...b,
        fireRisk: assessBuildingFireRisk(b),
      }));
      results.summary.totalBuildings = registry.value.buildings.length;
      results.summary.highRiskBuildings = registry.value.buildings.filter(
        b => b.fireRisk?.riskLevel === 'HIGH'
      ).length;
    }
  }

  if (safety.status === 'fulfilled') {
    results.fireSafety = safety.value;
    if (safety.value.available) {
      results.summary.buildingsWithSprinkler = safety.value.equipment?.filter(e => e.sprinkler).length || 0;
      results.summary.buildingsWithAlarm = safety.value.equipment?.filter(e => e.fireAlarm).length || 0;
    }
  }

  results.summary.dataAvailability = {
    registry: registry.status === 'fulfilled' && registry.value?.available,
    fireSafety: safety.status === 'fulfilled' && safety.value?.available,
  };

  return results;
}

// Export for on-demand queries by incident
export { fetchBuildingRegistry, fetchFireSafetyEquipment, assessBuildingFireRisk, estimateOccupancy };
