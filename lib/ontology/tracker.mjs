// Track Manager (Anduril Lattice Track Management Pattern)
// Manages incident lifecycle: creation, state transitions, auto-escalation, merging
// Each incident gets a unique trackId (incidentId) that all data links back to

import { Incident, generateIncidentId, INCIDENT_STATES } from './entities.mjs';
import { fuseIncidentSignals, matchNearestResources, predictFireSpread, haversineKm } from './fusion.mjs';

export class TrackManager {
  constructor(config = {}) {
    this.tracks = new Map();  // incidentId → Incident
    this.config = {
      autoEscalateMinutes: config.autoEscalateMinutes || 10,
      fusionConfidenceThreshold: config.fusionConfidenceThreshold || 0.6,
      maxTrackAgeMinutes: config.maxTrackAgeMinutes || 480, // 8 hours
      ...config,
    };
  }

  // === Track CRUD ===

  createTrack(props = {}) {
    const incidentId = generateIncidentId();
    const incident = new Incident(incidentId, props);
    incident.addTimelineEvent('사건 접수', { source: props.source || 'system' });
    this.tracks.set(incidentId, incident);
    return incident;
  }

  getTrack(incidentId) {
    return this.tracks.get(incidentId) || null;
  }

  getAllTracks() {
    return [...this.tracks.values()];
  }

  getActiveTracks() {
    const closedStates = ['EXTINGUISHED', 'CLOSED'];
    return [...this.tracks.values()].filter(t => !closedStates.includes(t.props.state));
  }

  // === State Transitions ===

  transitionTrack(incidentId, newState, details = {}) {
    const track = this.tracks.get(incidentId);
    if (!track) return null;

    const success = track.transition(newState);
    if (success && details.event) {
      track.addTimelineEvent(details.event, details);
    }
    return success ? track : null;
  }

  // === Auto-Escalation ===
  // Check all active tracks for staleness and escalate if needed

  checkEscalations() {
    const escalated = [];
    for (const track of this.getActiveTracks()) {
      if (track.props.state === 'REPORTED' && track.isStale(this.config.autoEscalateMinutes)) {
        // REPORTED for too long without confirmation → escalate severity
        const currentLevel = track.props.severity?.code || 1;
        if (currentLevel < 3) {
          track.props.severity = {
            code: currentLevel + 1,
            label: `대응 ${currentLevel + 1}단계`,
            description: `자동 상향 — ${this.config.autoEscalateMinutes}분 미확인`,
          };
          track.addTimelineEvent(`자동 에스컬레이션: 대응 ${currentLevel + 1}단계`, {
            reason: `${this.config.autoEscalateMinutes}분 경과, 미확인`,
            auto: true,
          });
          escalated.push(track);
        }
      }
    }
    return escalated;
  }

  // === Track Merging ===
  // When two tracks are determined to be the same incident

  mergeTracks(keepId, mergeId) {
    const keep = this.tracks.get(keepId);
    const merge = this.tracks.get(mergeId);
    if (!keep || !merge) return null;

    // Merge sources
    for (const src of merge.sources) keep.addSource(src);

    // Merge timeline
    keep.props.timeline.push(...merge.props.timeline);
    keep.props.timeline.sort((a, b) => a.time - b.time);

    // Merge SNS signals
    keep.props.snsSignals.push(...merge.props.snsSignals);

    // Merge evidence
    keep.props.evidence.push(...merge.props.evidence);

    // Update confidence (more sources = higher confidence)
    keep.confidence = Math.min(1.0, keep.confidence + 0.1);

    // Update caller count
    keep.props.callerCount += merge.props.callerCount;

    keep.addTimelineEvent(`사건 병합: ${mergeId}`, { mergedFrom: mergeId });

    // Remove merged track
    this.tracks.delete(mergeId);

    return keep;
  }

  // === Process Incoming Data ===
  // Takes fused signals and creates/updates tracks

  processSignals(fusedCandidates, resources = {}) {
    const results = { created: [], updated: [], escalated: [] };

    for (const candidate of fusedCandidates) {
      if (candidate.confidence < this.config.fusionConfidenceThreshold) continue;

      // Check if this matches an existing active track
      const existingTrack = this.findNearbyTrack(candidate.centroid);

      if (existingTrack) {
        // Update existing track
        existingTrack.confidence = Math.max(existingTrack.confidence, candidate.confidence);
        existingTrack.addSource(candidate.sources.join('+'));
        existingTrack.addTimelineEvent('신호 업데이트', {
          sources: candidate.sources,
          confidence: candidate.confidence,
        });

        // Auto-confirm if confidence threshold met
        if (existingTrack.props.state === 'REPORTED' && candidate.confidence >= 0.6) {
          existingTrack.transition('CONFIRMED');
          existingTrack.addTimelineEvent('센서 퓨전 확인', {
            confidence: candidate.confidence,
            sources: candidate.sources,
          });
        }

        results.updated.push(existingTrack);
      } else {
        // Create new track
        const track = this.createTrack({
          location: {
            lat: candidate.centroid.lat,
            lon: candidate.centroid.lon,
          },
          source: candidate.sources.join('+'),
        });
        track.confidence = candidate.confidence;
        track.sources = candidate.sources;

        // Auto-confirm if high confidence
        if (candidate.confidence >= 0.6) {
          track.transition('CONFIRMED');
          track.addTimelineEvent('센서 퓨전 확인', {
            confidence: candidate.confidence,
            sources: candidate.sources,
          });
        }

        // Match nearest resources
        const nearest = matchNearestResources(
          { lat: candidate.centroid.lat, lon: candidate.centroid.lon },
          resources
        );
        track.props.nearbyHydrants = nearest.hydrants;
        track.props.nearbyHospitals = nearest.hospitals;

        results.created.push(track);
      }
    }

    // Check for escalations
    results.escalated = this.checkEscalations();

    return results;
  }

  // Find existing track near a location (within 2km)
  findNearbyTrack(location, maxKm = 2) {
    if (!location?.lat) return null;

    for (const track of this.getActiveTracks()) {
      if (!track.props.location?.lat) continue;
      const dist = haversineKm(
        location.lat, location.lon,
        track.props.location.lat, track.props.location.lon
      );
      if (dist <= maxKm) return track;
    }
    return null;
  }

  // === Cleanup old tracks ===

  cleanupOldTracks() {
    const maxAge = this.config.maxTrackAgeMinutes * 60 * 1000;
    const now = Date.now();
    let cleaned = 0;

    for (const [id, track] of this.tracks) {
      if (now - track.createdAt > maxAge && ['EXTINGUISHED', 'CLOSED'].includes(track.props.state)) {
        this.tracks.delete(id);
        cleaned++;
      }
    }
    return cleaned;
  }

  // === Export all tracks as JSON (for API/SSE) ===

  toJSON() {
    const active = this.getActiveTracks();
    const all = this.getAllTracks();

    return {
      totalTracks: all.length,
      activeTracks: active.length,
      incidents: all.map(t => t.toJSON()),
      activeIncidents: active.map(t => t.toJSON()),
      byState: INCIDENT_STATES.reduce((acc, state) => {
        acc[state] = all.filter(t => t.props.state === state).length;
        return acc;
      }, {}),
    };
  }
}
