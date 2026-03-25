// 119 Call Priority Scorer
// Computes 0-100 priority score based on incident type, severity, proximity, weather
// Uses data from ontology entities and KMA weather

import { haversineKm } from '../ontology/fusion.mjs';

export const PRIORITY_LEVELS = {
  CRITICAL: { min: 80, label: 'CRITICAL', description: '즉시 대응 — 대형 화재, 다수사상자, 위험물' },
  HIGH: { min: 60, label: 'HIGH', description: '긴급 대응 — 화재 확산, 건물화재' },
  MODERATE: { min: 40, label: 'MODERATE', description: '일반 대응 — 소규모 화재, 구조' },
  LOW: { min: 0, label: 'LOW', description: '확인 필요 — 오보 가능성, 구급' },
};

// Incident type severity weights (max 25)
const TYPE_WEIGHTS = {
  EXPLOSION: 25,
  HAZMAT: 22,
  STRUCTURE_FIRE: 20,
  WILDFIRE: 18,
  GAS_LEAK: 17,
  RESCUE: 15,
  VEHICLE_FIRE: 12,
  EMS: 10,
  OTHER: 8,
};

// Severity indicator weights (max 5 each, capped at 20)
const SEVERITY_INDICATOR_WEIGHT = 5;
const SEVERITY_MAX = 20;

/**
 * Score a 119 emergency call for priority dispatch
 * @param {object} extractedInfo - from extractor.mjs
 * @param {object} context - environmental context
 * @param {Array} [context.hazmatFacilities] - nearby hazmat sites with {lat, lon}
 * @param {Array} [context.vulnerableFacilities] - schools, hospitals, elderly with {lat, lon}
 * @param {object} [context.weather] - { humidity, windSpeed, temperature }
 * @param {number} [context.callerCount] - number of callers reporting same location
 * @param {object} [context.geocodeResult] - { lat, lon, confidence }
 * @returns {{ score: number, priority: string, breakdown: object }}
 */
export function scoreCall(extractedInfo, context = {}) {
  const breakdown = {};
  let totalScore = 0;

  // 1. Incident type severity (0-25)
  const typeScore = TYPE_WEIGHTS[extractedInfo.incidentType] || TYPE_WEIGHTS.OTHER;
  breakdown.incidentType = { score: typeScore, max: 25, type: extractedInfo.incidentType };
  totalScore += typeScore;

  // 2. Severity indicators (0-20)
  const indicators = extractedInfo.severityIndicators || [];
  const severityScore = Math.min(indicators.length * SEVERITY_INDICATOR_WEIGHT, SEVERITY_MAX);
  breakdown.severityIndicators = { score: severityScore, max: 20, indicators };
  totalScore += severityScore;

  // 3. Multiple callers (0-15)
  const callerCount = context.callerCount || 1;
  let callerScore = 3;
  if (callerCount >= 3) callerScore = 15;
  else if (callerCount >= 2) callerScore = 8;
  breakdown.multipleCalls = { score: callerScore, max: 15, callerCount };
  totalScore += callerScore;

  // 4. Hazmat proximity (0-15)
  let hazmatScore = 0;
  const incidentLocation = context.geocodeResult;
  if (incidentLocation?.lat && context.hazmatFacilities?.length) {
    let nearestHazmatKm = Infinity;
    for (const facility of context.hazmatFacilities) {
      if (!facility.lat || !facility.lon) continue;
      const dist = haversineKm(
        incidentLocation.lat, incidentLocation.lon,
        facility.lat, facility.lon
      );
      nearestHazmatKm = Math.min(nearestHazmatKm, dist);
    }
    if (nearestHazmatKm <= 0.5) hazmatScore = 15;
    else if (nearestHazmatKm <= 1) hazmatScore = 10;
    else if (nearestHazmatKm <= 2) hazmatScore = 5;
    breakdown.hazmatProximity = { score: hazmatScore, max: 15, nearestKm: Math.round(nearestHazmatKm * 100) / 100 };
  } else {
    breakdown.hazmatProximity = { score: 0, max: 15, note: 'No location or hazmat data' };
  }
  totalScore += hazmatScore;

  // 5. Vulnerable facility proximity (0-10)
  let vulnerableScore = 0;
  if (incidentLocation?.lat && context.vulnerableFacilities?.length) {
    let nearbyCount = 0;
    for (const facility of context.vulnerableFacilities) {
      if (!facility.lat || !facility.lon) continue;
      const dist = haversineKm(
        incidentLocation.lat, incidentLocation.lon,
        facility.lat, facility.lon
      );
      if (dist <= 1) nearbyCount++;
    }
    vulnerableScore = Math.min(nearbyCount * 3, 10);
    breakdown.vulnerableProximity = { score: vulnerableScore, max: 10, nearbyCount };
  } else {
    breakdown.vulnerableProximity = { score: 0, max: 10, note: 'No location or facility data' };
  }
  totalScore += vulnerableScore;

  // 6. Weather risk (0-10)
  let weatherScore = 0;
  const weather = context.weather;
  if (weather) {
    const isDry = weather.humidity !== null && weather.humidity < 30;
    const isWindy = weather.windSpeed !== null && weather.windSpeed > 7;
    if (isDry && isWindy) weatherScore = 10;
    else if (isDry) weatherScore = 5;
    else if (isWindy) weatherScore = 5;
    breakdown.weatherRisk = { score: weatherScore, max: 10, humidity: weather.humidity, windSpeed: weather.windSpeed };
  } else {
    breakdown.weatherRisk = { score: 0, max: 10, note: 'No weather data' };
  }
  totalScore += weatherScore;

  // 7. Address specificity (0-5)
  const addressConfidence = context.geocodeResult?.confidence || extractedInfo.confidence || 0.2;
  const addressScore = Math.round(addressConfidence * 5);
  breakdown.addressSpecificity = { score: addressScore, max: 5, confidence: addressConfidence };
  totalScore += addressScore;

  // Bonus: trapped persons
  if (extractedInfo.trappedPersons > 0) {
    const trapBonus = Math.min(extractedInfo.trappedPersons * 3, 10);
    totalScore = Math.min(100, totalScore + trapBonus);
    breakdown.trappedPersons = { bonus: trapBonus, count: extractedInfo.trappedPersons };
  }

  // Clamp to 0-100
  totalScore = Math.max(0, Math.min(100, totalScore));

  // Determine priority level
  let priority = 'LOW';
  if (totalScore >= PRIORITY_LEVELS.CRITICAL.min) priority = 'CRITICAL';
  else if (totalScore >= PRIORITY_LEVELS.HIGH.min) priority = 'HIGH';
  else if (totalScore >= PRIORITY_LEVELS.MODERATE.min) priority = 'MODERATE';

  return {
    score: totalScore,
    priority,
    priorityInfo: PRIORITY_LEVELS[priority],
    breakdown,
    timestamp: Date.now(),
  };
}
