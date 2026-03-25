// Fire Ontology — Entity Definitions (Palantir Ontology Pattern)
// All fire control room data is normalized into these entity types
// Every entity links back to an Incident via incidentId

// === Incident State Machine (Anduril Lattice Track Pattern) ===
export const INCIDENT_STATES = [
  'REPORTED',      // 119 신고 접수
  'CONFIRMED',     // 센서 퓨전으로 확인 (열점 + 신고 + SNS 교차)
  'RESPONDING',    // 출동 지시 완료
  'ON_SCENE',      // 현장 도착
  'CONTAINED',     // 화재 진압 중 (확산 저지)
  'EXTINGUISHED',  // 진화 완료
  'CLOSED',        // 상황 종료
];

export const INCIDENT_TYPES = {
  STRUCTURE_FIRE: '건물화재',
  WILDFIRE: '산불',
  VEHICLE_FIRE: '차량화재',
  HAZMAT: '위험물사고',
  GAS_LEAK: '가스누출',
  EXPLOSION: '폭발',
  RESCUE: '구조',
  EMS: '구급',
  OTHER: '기타',
};

export const SEVERITY_LEVELS = {
  LEVEL_1: { code: 1, label: '대응 1단계', description: '소규모 — 단일 안전센터 대응' },
  LEVEL_2: { code: 2, label: '대응 2단계', description: '중규모 — 소방서 단위 대응' },
  LEVEL_3: { code: 3, label: '대응 3단계', description: '대형 — 소방본부 단위 대응' },
  SPECIAL: { code: 4, label: '특수대응', description: '위험물/폭발/다수사상자' },
};

// === Confidence Levels ===
// Sensor fusion increases confidence as more sources confirm
export const CONFIDENCE = {
  UNVERIFIED: 0.3,    // 단일 소스 (119 신고 또는 SNS 1건)
  CORROBORATED: 0.6,  // 2개 소스 교차 확인
  CONFIRMED: 0.9,     // 3개+ 소스 확인
  VERIFIED: 1.0,      // 현장 확인 완료
};

// === Base Entity Class ===
export class FireEntity {
  constructor(type, id, props = {}) {
    this.type = type;
    this.id = id;
    this.props = props;
    this.links = [];          // [{ relation, targetType, targetId }]
    this.sources = [];        // data source names that contributed
    this.confidence = 1.0;
    this.createdAt = Date.now();
    this.lastUpdated = Date.now();
  }

  addLink(relation, targetType, targetId) {
    this.links.push({ relation, targetType, targetId });
    this.lastUpdated = Date.now();
  }

  addSource(sourceName) {
    if (!this.sources.includes(sourceName)) {
      this.sources.push(sourceName);
      this.lastUpdated = Date.now();
    }
  }

  toJSON() {
    return {
      type: this.type,
      id: this.id,
      ...this.props,
      links: this.links,
      sources: this.sources,
      confidence: this.confidence,
      createdAt: this.createdAt,
      lastUpdated: this.lastUpdated,
    };
  }
}

// === Incident Entity (Central — all data links here) ===
export class Incident extends FireEntity {
  constructor(incidentId, props = {}) {
    super('incident', incidentId, {
      state: 'REPORTED',
      incidentType: INCIDENT_TYPES.OTHER,
      severity: SEVERITY_LEVELS.LEVEL_1,
      location: null,          // { lat, lon, address, zone }
      reportedAt: Date.now(),
      confirmedAt: null,
      respondingAt: null,
      onSceneAt: null,
      containedAt: null,
      extinguishedAt: null,
      closedAt: null,
      casualties: { deaths: 0, injuries: 0 },
      callerCount: 0,
      weather: null,           // snapshot at time of incident
      building: null,          // linked building info
      elevators: [],           // linked elevator info
      smokeSimulation: null,   // smoke spread prediction
      evacuationPlan: null,    // evacuation simulation result
      assignedUnits: [],       // dispatched units
      nearbyHydrants: [],      // water supply within range
      nearbyHospitals: [],     // hospitals with ER availability
      snsSignals: [],          // social media signals
      evidence: [],            // media URLs (photos/videos)
      timeline: [],            // chronological events
      aiStrategy: null,        // LLM-generated response strategy
      ...props,
    });
    this.confidence = CONFIDENCE.UNVERIFIED;
  }

  // State machine transition
  transition(newState) {
    const currentIdx = INCIDENT_STATES.indexOf(this.props.state);
    const newIdx = INCIDENT_STATES.indexOf(newState);
    if (newIdx < 0) return false;
    // Allow forward transitions or CLOSED from any state
    if (newIdx <= currentIdx && newState !== 'CLOSED') return false;

    this.props.state = newState;
    const tsField = `${newState.toLowerCase()}At`;
    if (tsField in this.props) this.props[tsField] = Date.now();

    this.props.timeline.push({
      time: Date.now(),
      event: `상태 변경: ${newState}`,
      auto: true,
    });
    this.lastUpdated = Date.now();
    return true;
  }

  addTimelineEvent(event, details = {}) {
    this.props.timeline.push({
      time: Date.now(),
      event,
      ...details,
    });
    this.lastUpdated = Date.now();
  }

  // Check if incident is stale (no state change for N minutes)
  isStale(maxMinutes) {
    const lastActivity = this.lastUpdated;
    return (Date.now() - lastActivity) > maxMinutes * 60 * 1000;
  }
}

// === Unit Entity (Fire trucks, ambulances, helicopters) ===
export class Unit extends FireEntity {
  constructor(unitId, props = {}) {
    super('unit', unitId, {
      name: '',
      unitType: '',          // 펌프차, 고가사다리차, 구급차, 헬기
      station: '',           // home station
      status: 'AVAILABLE',   // AVAILABLE | DISPATCHED | ON_SCENE | RETURNING
      location: null,        // current GPS { lat, lon }
      assignedIncident: null, // incidentId
      personnel: 0,
      ...props,
    });
  }
}

// === Building Entity ===
export class Building extends FireEntity {
  constructor(buildingId, props = {}) {
    super('building', buildingId, {
      name: '',
      address: '',
      location: null,        // { lat, lon }
      mainUse: '',
      floors: { above: 0, below: 0 },
      structure: '',         // 철근콘크리트, 철골, 조적
      totalArea: 0,          // m²
      buildDate: '',
      occupancy: 0,          // estimated persons
      sprinkler: false,
      fireAlarm: false,
      emergencyExits: 0,
      hazmatStored: [],
      ...props,
    });
  }
}

// === Elevator Entity ===
export class Elevator extends FireEntity {
  constructor(elevatorId, props = {}) {
    super('elevator', elevatorId, {
      buildingId: '',
      elevatorNo: '',
      elevatorType: '',      // 승객용, 화물용, 비상용
      capacity: 0,           // persons
      loadCapacity: 0,       // kg
      floors: [],            // stop floors
      fireServiceMode: false,
      lastInspection: '',
      inspectionResult: '',
      manufacturer: '',
      installDate: '',
      ...props,
    });
  }
}

// === Hydrant Entity ===
export class Hydrant extends FireEntity {
  constructor(hydrantId, props = {}) {
    super('hydrant', hydrantId, {
      hydrantType: '소화전', // 소화전, 저수조
      address: '',
      location: null,        // { lat, lon }
      status: '정상',
      ...props,
    });
  }
}

// === Hospital Entity ===
export class Hospital extends FireEntity {
  constructor(hospitalId, props = {}) {
    super('hospital', hospitalId, {
      name: '',
      address: '',
      location: null,
      tel: '',
      erAvailableBeds: 0,
      distanceKm: null,
      ...props,
    });
  }
}

// === HazmatSite Entity ===
export class HazmatSite extends FireEntity {
  constructor(siteId, props = {}) {
    super('hazmat', siteId, {
      name: '',
      address: '',
      location: null,
      hazmatType: '',
      riskRadius: 0,         // meters
      ...props,
    });
  }
}

// === SocialSignal Entity (SNS post) ===
export class SocialSignal extends FireEntity {
  constructor(signalId, props = {}) {
    super('social_signal', signalId, {
      platform: '',          // twitter, youtube, naver, bluesky, telegram, instagram
      text: '',
      author: '',
      date: '',
      engagement: 0,         // likes/views
      hasMedia: false,
      hasGeoTag: false,
      geoTag: null,          // { lat, lon }
      isLiveStream: false,
      matchedKeywords: [],
      score: 0,
      url: '',
      ...props,
    });
  }
}

// === Incident ID Generator ===
let dailyCounter = 0;
let lastDate = '';

export function generateIncidentId() {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  if (dateStr !== lastDate) {
    lastDate = dateStr;
    dailyCounter = 0;
  }
  dailyCounter++;
  return `INC-${dateStr}-${String(dailyCounter).padStart(3, '0')}`;
}
