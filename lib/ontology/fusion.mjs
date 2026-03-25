// Sensor Fusion Engine (Anduril Lattice Pattern)
// Fuses signals from multiple sources to confirm incidents and boost confidence
// FIRMS thermal + 119 calls + SNS reports → unified Incident with confidence score

import { CONFIDENCE } from './entities.mjs';

const FUSION_DISTANCE_KM = 5;   // max distance to consider same incident
const FUSION_TIME_WINDOW = 30;   // minutes

/**
 * Haversine distance between two points (km)
 */
export function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Cluster signals by proximity and time window
 * Groups nearby signals into potential incidents
 */
export function clusterSignals(signals, maxDistKm = FUSION_DISTANCE_KM, maxTimeMin = FUSION_TIME_WINDOW) {
  const clusters = [];

  for (const signal of signals) {
    if (!signal.location?.lat || !signal.location?.lon) continue;

    let matched = false;
    for (const cluster of clusters) {
      const dist = haversineKm(
        signal.location.lat, signal.location.lon,
        cluster.centroid.lat, cluster.centroid.lon
      );
      const timeDiff = Math.abs(signal.timestamp - cluster.latestTimestamp) / 60000;

      if (dist <= maxDistKm && timeDiff <= maxTimeMin) {
        cluster.signals.push(signal);
        cluster.sources.add(signal.source);
        cluster.latestTimestamp = Math.max(cluster.latestTimestamp, signal.timestamp);
        // Update centroid (running average)
        const n = cluster.signals.length;
        cluster.centroid.lat = ((n - 1) * cluster.centroid.lat + signal.location.lat) / n;
        cluster.centroid.lon = ((n - 1) * cluster.centroid.lon + signal.location.lon) / n;
        matched = true;
        break;
      }
    }

    if (!matched) {
      clusters.push({
        signals: [signal],
        sources: new Set([signal.source]),
        centroid: { ...signal.location },
        latestTimestamp: signal.timestamp || Date.now(),
      });
    }
  }

  return clusters;
}

/**
 * Calculate confidence based on number of confirming sources
 * 1 source → 0.3 (UNVERIFIED)
 * 2 sources → 0.6 (CORROBORATED)
 * 3+ sources → 0.9 (CONFIRMED)
 * + geoTag bonus → +0.05
 * + media evidence → +0.05
 */
export function calculateConfidence(cluster) {
  const sourceCount = cluster.sources.size;
  let confidence;

  if (sourceCount >= 3) {
    confidence = CONFIDENCE.CONFIRMED;
  } else if (sourceCount >= 2) {
    confidence = CONFIDENCE.CORROBORATED;
  } else {
    confidence = CONFIDENCE.UNVERIFIED;
  }

  // Bonus for geotagged signals
  const hasGeoTag = cluster.signals.some(s => s.hasGeoTag);
  if (hasGeoTag) confidence = Math.min(1.0, confidence + 0.05);

  // Bonus for media evidence (photos/videos)
  const hasMedia = cluster.signals.some(s => s.hasMedia);
  if (hasMedia) confidence = Math.min(1.0, confidence + 0.05);

  // Bonus for high address confidence from 119 STT pipeline
  const highAddrConf = cluster.signals.some(s => (s.addressConfidence || 0) >= 0.8);
  if (highAddrConf) confidence = Math.min(1.0, confidence + 0.05);

  return confidence;
}

/**
 * Fuse incident signals from all sources
 * Inputs: thermal hits (FIRMS), emergency calls (119), SNS posts, CCTV alerts
 * Output: array of fused incident candidates with confidence scores
 */
export function fuseIncidentSignals({ thermalHits = [], emergencyCalls = [], snsSignals = [], cctvAlerts = [] }) {
  // Normalize all signals to common format
  const allSignals = [
    ...thermalHits.map(t => ({
      source: 'FIRMS',
      location: { lat: t.lat, lon: t.lon },
      timestamp: t.timestamp ? new Date(t.timestamp).getTime() : Date.now(),
      hasMedia: false,
      hasGeoTag: true,
      data: t,
    })),
    ...emergencyCalls.map(c => ({
      source: '119',
      location: c.location || null,
      timestamp: c.timestamp ? new Date(c.timestamp).getTime() : Date.now(),
      hasMedia: false,
      hasGeoTag: !!(c.location?.lat),
      data: c,
      // STT pipeline enrichment: carry priority score and address confidence
      priorityScore: c.priorityScore || c.data?.priorityScore || 0,
      addressConfidence: c.addressConfidence || c.data?.geocodeResult?.confidence || 0,
    })),
    ...snsSignals.map(s => ({
      source: `SNS:${s.platform || 'unknown'}`,
      location: s.geoTag || null,
      timestamp: s.date ? new Date(s.date).getTime() : Date.now(),
      hasMedia: s.hasMedia || false,
      hasGeoTag: !!s.geoTag,
      data: s,
    })),
    ...cctvAlerts.map(a => ({
      source: 'CCTV',
      location: a.location || null,
      timestamp: a.timestamp ? new Date(a.timestamp).getTime() : Date.now(),
      hasMedia: true,
      hasGeoTag: !!a.location,
      data: a,
    })),
  ];

  // Cluster by proximity and time
  const clusters = clusterSignals(allSignals);

  // Score each cluster
  return clusters.map(cluster => ({
    centroid: cluster.centroid,
    confidence: calculateConfidence(cluster),
    sourceCount: cluster.sources.size,
    sources: [...cluster.sources],
    signalCount: cluster.signals.length,
    signals: cluster.signals,
    latestTimestamp: cluster.latestTimestamp,
  })).sort((a, b) => b.confidence - a.confidence);
}

/**
 * Predict fire spread direction and area based on wind
 * Uses simplified Gaussian plume model
 * Returns array of time-step polygons for map overlay
 */
export function predictFireSpread({ fireLocation, windSpeed, windDirection, timeStepsMinutes = [5, 10, 15, 30, 60] }) {
  if (!fireLocation?.lat || !fireLocation?.lon || !windSpeed) {
    return [];
  }

  // Wind direction: degrees from north (0=N, 90=E, 180=S, 270=W)
  // Smoke travels downwind
  const windRadians = (windDirection * Math.PI) / 180;

  return timeStepsMinutes.map(t => {
    // Downwind distance (meters)
    const downwindM = windSpeed * t * 60;
    // Lateral spread ≈ 0.2 × downwind (Pasquill-Gifford stability class D)
    const lateralM = downwindM * 0.22;

    // Convert to lat/lon offsets
    const dLat = (downwindM * Math.cos(windRadians)) / 111320;
    const dLon = (downwindM * Math.sin(windRadians)) / (111320 * Math.cos(fireLocation.lat * Math.PI / 180));
    const latSpread = lateralM / 111320;
    const lonSpread = lateralM / (111320 * Math.cos(fireLocation.lat * Math.PI / 180));

    // Plume center point
    const centerLat = fireLocation.lat + dLat;
    const centerLon = fireLocation.lon + dLon;

    // Elliptical plume polygon (simplified to 8 points)
    const points = [];
    for (let angle = 0; angle < 360; angle += 45) {
      const rad = (angle * Math.PI) / 180;
      points.push({
        lat: centerLat + latSpread * Math.sin(rad),
        lon: centerLon + lonSpread * Math.cos(rad),
      });
    }

    return {
      timeMinutes: t,
      downwindDistanceM: Math.round(downwindM),
      lateralSpreadM: Math.round(lateralM),
      center: { lat: centerLat, lon: centerLon },
      polygon: points,
      dangerRadius: Math.round(downwindM + lateralM),
    };
  });
}

/**
 * Match nearest resources to an incident
 * Returns sorted lists of nearest hydrants, hospitals, and available units
 */
export function matchNearestResources(incidentLocation, { hydrants = [], hospitals = [], units = [] }) {
  if (!incidentLocation?.lat) return { hydrants: [], hospitals: [], units: [] };

  const withDistance = (items) => items
    .filter(item => item.location?.lat && item.location?.lon)
    .map(item => ({
      ...item,
      distanceKm: haversineKm(
        incidentLocation.lat, incidentLocation.lon,
        item.location.lat, item.location.lon
      ),
    }))
    .sort((a, b) => a.distanceKm - b.distanceKm);

  return {
    hydrants: withDistance(hydrants).slice(0, 10),
    hospitals: withDistance(hospitals).slice(0, 5),
    units: withDistance(units.filter(u => u.status === 'AVAILABLE')).slice(0, 10),
  };
}
