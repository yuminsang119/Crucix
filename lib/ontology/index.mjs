// Fire Ontology Engine — Main Entry Point
// Palantir-style semantic layer + Anduril Lattice track management
// All data flows through here: raw sources → entities → fusion → tracks → dashboard

export { FireEntity, Incident, Unit, Building, Elevator, Hydrant, Hospital, HazmatSite, SocialSignal } from './entities.mjs';
export { INCIDENT_STATES, INCIDENT_TYPES, SEVERITY_LEVELS, CONFIDENCE, generateIncidentId } from './entities.mjs';
export { fuseIncidentSignals, predictFireSpread, matchNearestResources, haversineKm, clusterSignals } from './fusion.mjs';
export { TrackManager } from './tracker.mjs';
