// Evacuation Simulation
// Calculates building evacuation times, routes, and identifies critical floors
// Integrates with smoke-spread to determine safety margins

import { calculateElevatorEvacCapacity } from '../../apis/sources/elevator-info.mjs';

// Evacuation speed constants (Korean fire code references)
const EVAC_SPEEDS = {
  corridor: 1.0,       // m/s in corridors
  stairDown: 0.5,      // m/s descending stairs
  stairUp: 0.35,       // m/s ascending stairs (from basement)
  doorFlow: 1.3,       // persons per meter of door width per second
  stairFlow: 1.0,      // persons per meter of stair width per second
};

// Default assumptions
const DEFAULTS = {
  floorHeight: 3.0,       // meters
  stairWidth: 1.2,        // meters (standard Korean fire escape)
  doorWidth: 0.9,         // meters (standard emergency exit)
  corridorLength: 30,     // meters (average to nearest stair)
  stairsPerFloor: 2,      // number of staircases
  evacuationStartDelay: 60, // seconds (fire alarm → movement starts)
};

export class EvacuationSimulator {
  /**
   * @param {Object} building - building info (floors, occupancy, exits, etc.)
   * @param {Array} smokeData - smoke arrival times per floor (from SmokeSpreadSimulator)
   * @param {Array} elevators - elevator data (from elevator-info source)
   */
  constructor(building, smokeData = [], elevators = []) {
    this.building = {
      ...DEFAULTS,
      ...building,
      floorsAbove: building.floors?.above || 5,
      floorsBelow: building.floors?.below || 0,
    };
    this.smokeData = smokeData;
    this.elevators = elevators;
    this.elevatorCapacity = calculateElevatorEvacCapacity(elevators);
  }

  /**
   * Estimate occupants per floor based on total and use type
   */
  estimateOccupantsPerFloor(floor) {
    const total = this.building.occupancy || 100;
    const totalFloors = this.building.floorsAbove + this.building.floorsBelow;
    if (totalFloors === 0) return 0;

    // Ground floor and lower floors typically more populated
    if (floor <= 0) return Math.round(total / totalFloors * 0.5); // Basement: less people
    if (floor <= 2) return Math.round(total / totalFloors * 1.5);  // Ground/2F: more people
    return Math.round(total / totalFloors);
  }

  /**
   * Calculate evacuation time for a single floor
   * @param {number} floor - floor number
   * @returns {Object} floor evacuation details
   */
  calcFloorEvacTime(floor) {
    const occupants = this.estimateOccupantsPerFloor(floor);
    const floorsToDescend = floor > 0 ? floor : Math.abs(floor);
    const isBasement = floor <= 0;

    // Phase 1: Travel to staircase
    const corridorTime = this.building.corridorLength / EVAC_SPEEDS.corridor;

    // Phase 2: Descend/ascend stairs
    const verticalDistance = floorsToDescend * this.building.floorHeight;
    const stairSpeed = isBasement ? EVAC_SPEEDS.stairUp : EVAC_SPEEDS.stairDown;
    const stairTravelTime = verticalDistance / stairSpeed;

    // Phase 3: Flow bottleneck (all occupants through stairs)
    const totalStairWidth = this.building.stairsPerFloor * this.building.stairWidth;
    const flowTime = occupants / (totalStairWidth * EVAC_SPEEDS.stairFlow);

    // Total = max(travel time, flow time) + start delay
    const evacuationTime = this.building.evacuationStartDelay +
      corridorTime + Math.max(stairTravelTime, flowTime);

    // Smoke arrival time for this floor
    const smokeEntry = this.smokeData.find(s => s.floor === floor);
    const smokeArrival = smokeEntry?.smokeArrivalSeconds || Infinity;

    // Safety margin = smoke arrival - evacuation time
    const safetyMargin = smokeArrival - evacuationTime;

    return {
      floor,
      floorLabel: floor > 0 ? `${floor}층` : `지하${Math.abs(floor)}층`,
      occupants,
      evacuationTimeSeconds: Math.round(evacuationTime),
      evacuationTimeMinutes: Math.round(evacuationTime / 60 * 10) / 10,
      smokeArrivalSeconds: Math.round(smokeArrival),
      safetyMarginSeconds: Math.round(safetyMargin),
      status: safetyMargin > 120 ? 'SAFE'
        : safetyMargin > 0 ? 'WARNING'
        : 'CRITICAL',
      phases: {
        startDelay: this.building.evacuationStartDelay,
        corridorTravel: Math.round(corridorTime),
        stairTravel: Math.round(stairTravelTime),
        flowBottleneck: Math.round(flowTime),
      },
    };
  }

  /**
   * Calculate elevator-assisted evacuation
   */
  calcElevatorEvac() {
    if (!this.elevatorCapacity.emergencyElevatorCount) {
      return { available: false, note: '비상용 엘리베이터 없음' };
    }

    const cap = this.elevatorCapacity;
    const totalOccupants = this.building.occupancy || 100;

    // Priority floors: highest floors (longest stair descent)
    const priorityFloors = [];
    for (let f = this.building.floorsAbove; f >= Math.max(1, this.building.floorsAbove - 5); f--) {
      priorityFloors.push(f);
    }

    // Also add mobility-impaired estimate (2% of occupants)
    const mobilityImpaired = Math.ceil(totalOccupants * 0.02);

    // Trips needed for priority floors
    const priorityOccupants = priorityFloors.reduce(
      (sum, f) => sum + this.estimateOccupantsPerFloor(f), 0
    );
    const tripsNeeded = Math.ceil(priorityOccupants / cap.totalCapacityPerTrip);

    // Average trip time (depends on building height)
    const avgTripHeight = this.building.floorsAbove * this.building.floorHeight / 2;
    const avgSpeed = cap.elevators[0]?.speed || 1.5;
    const avgTripSeconds = (avgTripHeight / avgSpeed) * 2 + 30; // round trip + loading

    return {
      available: true,
      emergencyElevators: cap.emergencyElevatorCount,
      capacityPerTrip: cap.totalCapacityPerTrip,
      priorityFloors,
      priorityOccupants,
      mobilityImpaired,
      tripsNeeded,
      avgTripSeconds: Math.round(avgTripSeconds),
      totalEvacTimeMinutes: Math.round(tripsNeeded * avgTripSeconds / 60 * 10) / 10,
    };
  }

  /**
   * Run full evacuation simulation
   */
  simulate() {
    const allFloors = [];
    for (let f = -this.building.floorsBelow; f <= this.building.floorsAbove; f++) {
      if (f === 0) continue;
      allFloors.push(f);
    }

    const floorResults = allFloors.map(f => this.calcFloorEvacTime(f));
    const elevatorEvac = this.calcElevatorEvac();

    // Find critical floors (where evacuation is slower than smoke)
    const criticalFloors = floorResults.filter(f => f.status === 'CRITICAL');
    const warningFloors = floorResults.filter(f => f.status === 'WARNING');

    // Total evacuation time (worst case)
    const maxEvacTime = Math.max(...floorResults.map(f => f.evacuationTimeSeconds));

    // Overall summary
    const totalOccupants = floorResults.reduce((sum, f) => sum + f.occupants, 0);

    return {
      timestamp: new Date().toISOString(),
      building: {
        floorsAbove: this.building.floorsAbove,
        floorsBelow: this.building.floorsBelow,
        totalOccupancy: totalOccupants,
        stairsPerFloor: this.building.stairsPerFloor,
        stairWidth: this.building.stairWidth,
      },
      floors: floorResults,
      elevatorEvac,
      summary: {
        totalOccupants,
        maxEvacTimeSeconds: Math.round(maxEvacTime),
        maxEvacTimeMinutes: Math.round(maxEvacTime / 60 * 10) / 10,
        criticalFloorCount: criticalFloors.length,
        warningFloorCount: warningFloors.length,
        criticalFloors: criticalFloors.map(f => f.floorLabel),
        warningFloors: warningFloors.map(f => f.floorLabel),
        overallStatus: criticalFloors.length > 0 ? 'CRITICAL'
          : warningFloors.length > 0 ? 'WARNING' : 'SAFE',
        recommendation: this._generateRecommendation(criticalFloors, warningFloors, elevatorEvac),
      },
    };
  }

  /**
   * Generate evacuation recommendation text
   */
  _generateRecommendation(critical, warning, elevator) {
    const rec = [];

    if (critical.length > 0) {
      rec.push(`⚠️ 위험: ${critical.map(f => f.floorLabel).join(', ')} — 연기 도달 전 대피 불가`);
      if (elevator.available) {
        rec.push(`🛗 비상 엘리베이터 ${elevator.emergencyElevators}기 활용 → ${critical[0].floorLabel} 우선 배치`);
      } else {
        rec.push('🚒 고가사다리차 요청 필요 — 외부 대피 경로 확보');
      }
    }

    if (warning.length > 0) {
      rec.push(`⚡ 주의: ${warning.map(f => f.floorLabel).join(', ')} — 즉시 대피 시작 필요`);
    }

    if (critical.length === 0 && warning.length === 0) {
      rec.push('✅ 전 층 안전 대피 가능 — 표준 대피 절차 진행');
    }

    return rec.join('\n');
  }
}
