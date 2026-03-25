// Smoke Spread Simulation — Gaussian Plume Model
// Predicts outdoor and indoor smoke propagation for fire incidents
// Uses wind data from KMA + building structure from building-info

/**
 * Pasquill-Gifford stability classes
 * Determines atmospheric dispersion rate
 */
const STABILITY_CLASSES = {
  A: { name: '매우 불안정', σy: 0.22, σz: 0.20 },  // Strong sun, light wind
  B: { name: '불안정', σy: 0.16, σz: 0.12 },
  C: { name: '약간 불안정', σy: 0.11, σz: 0.08 },
  D: { name: '중립', σy: 0.08, σz: 0.06 },          // Default (overcast/night)
  E: { name: '약간 안정', σy: 0.06, σz: 0.03 },
  F: { name: '안정', σy: 0.04, σz: 0.016 },          // Clear night, light wind
};

// Smoke danger thresholds (mg/m³)
const DANGER_THRESHOLD = 30;     // Visibility impaired
const CRITICAL_THRESHOLD = 100;  // Life-threatening

export class SmokeSpreadSimulator {
  /**
   * @param {Object} config
   * @param {number} config.windSpeed - m/s from KMA
   * @param {number} config.windDirection - degrees from north (0=N, 90=E)
   * @param {{ lat: number, lon: number }} config.fireLocation
   * @param {Object} [config.buildingInfo] - building data for indoor sim
   * @param {string} [config.material] - 가연물, 플라스틱, 화학물질, 목재
   * @param {string} [config.stabilityClass] - Pasquill-Gifford class (A-F), default D
   */
  constructor(config) {
    this.windSpeed = config.windSpeed || 3;
    this.windDirection = config.windDirection || 0;
    this.fireLocation = config.fireLocation;
    this.buildingInfo = config.buildingInfo || null;
    this.material = config.material || '가연물';
    this.stability = STABILITY_CLASSES[config.stabilityClass || 'D'];
    this.emissionRate = this._getEmissionRate(this.material);
  }

  /**
   * Emission rate based on burning material (g/s)
   */
  _getEmissionRate(material) {
    const rates = {
      '가연물': 50,
      '목재': 30,
      '플라스틱': 80,
      '화학물질': 120,
      '가스': 150,
      'default': 50,
    };
    return rates[material] || rates.default;
  }

  /**
   * Outdoor smoke spread prediction
   * Returns time-stepped plume polygons for map overlay
   * @param {number} maxMinutes - prediction horizon
   * @returns {Array} time-step results
   */
  predictOutdoor(maxMinutes = 60) {
    if (!this.fireLocation?.lat || !this.fireLocation?.lon) return [];

    const windRad = (this.windDirection * Math.PI) / 180;
    const results = [];

    for (let t = 5; t <= maxMinutes; t += 5) {
      // Downwind distance
      const downwindM = this.windSpeed * t * 60;

      // Pasquill-Gifford dispersion coefficients
      const σy = this.stability.σy * downwindM * (1 + 0.0001 * downwindM) ** -0.5;
      const σz = this.stability.σz * downwindM * (1 + 0.0015 * downwindM) ** -0.5;

      // Centerline concentration at ground level (Gaussian plume)
      const concentration = downwindM > 0
        ? (this.emissionRate / (Math.PI * this.windSpeed * σy * σz)) *
          Math.exp(-0.5 * (0 / σz) ** 2) * 1000 // convert to mg/m³
        : 0;

      // Danger zone width (where concentration > threshold)
      const dangerWidthM = σy * Math.sqrt(2 * Math.log(concentration / DANGER_THRESHOLD));

      // Convert to lat/lon
      const dLat = (downwindM * Math.cos(windRad)) / 111320;
      const dLon = (downwindM * Math.sin(windRad)) /
        (111320 * Math.cos(this.fireLocation.lat * Math.PI / 180));

      const center = {
        lat: this.fireLocation.lat + dLat,
        lon: this.fireLocation.lon + dLon,
      };

      // Plume polygon (ellipse approximation, 12 points)
      const latSpread = (isNaN(dangerWidthM) ? σy : dangerWidthM) / 111320;
      const lonSpread = (isNaN(dangerWidthM) ? σy : dangerWidthM) /
        (111320 * Math.cos(this.fireLocation.lat * Math.PI / 180));

      const polygon = [];
      for (let angle = 0; angle < 360; angle += 30) {
        const rad = (angle * Math.PI) / 180;
        polygon.push({
          lat: center.lat + latSpread * Math.sin(rad) * 0.5,
          lon: center.lon + lonSpread * Math.cos(rad),
        });
      }

      // Connect back to fire origin for teardrop shape
      const teardrop = [
        this.fireLocation,
        ...polygon,
        this.fireLocation,
      ];

      results.push({
        timeMinutes: t,
        downwindDistanceM: Math.round(downwindM),
        lateralSpreadM: Math.round(isNaN(dangerWidthM) ? σy : dangerWidthM),
        concentrationMgM3: Math.round(concentration * 10) / 10,
        dangerLevel: concentration > CRITICAL_THRESHOLD ? 'CRITICAL'
          : concentration > DANGER_THRESHOLD ? 'DANGER' : 'CAUTION',
        center,
        polygon: teardrop,
        σy: Math.round(σy),
        σz: Math.round(σz),
      });
    }

    return results;
  }

  /**
   * Indoor smoke spread prediction (floor-by-floor)
   * Models stack effect through elevator shafts and stairwells
   * @param {Object} building - building info with floors, structure
   * @returns {Array} floor-by-floor smoke arrival and conditions
   */
  predictIndoor(building = null) {
    const bld = building || this.buildingInfo;
    if (!bld) return [];

    const fireFloor = bld.fireFloor || 1;
    const aboveFloors = bld.floors?.above || 5;
    const belowFloors = bld.floors?.below || 0;
    const totalFloors = aboveFloors + belowFloors;
    const floorHeight = 3.0; // meters per floor (typical Korean building)

    // Stack effect velocity (m/s) — warm air rises through shafts
    // v = C × sqrt(h × ΔT / T_outside)
    // Typical fire: ΔT ≈ 200-600°C, C ≈ 0.5
    const deltaT = this.material === '화학물질' ? 400 : 200;
    const stackVelocity = 0.5 * Math.sqrt(totalFloors * floorHeight * deltaT / 293);

    const results = [];
    for (let f = -belowFloors; f <= aboveFloors; f++) {
      if (f === 0) continue; // No floor 0

      const floor = f;
      const distanceFromFire = Math.abs(floor - fireFloor) * floorHeight;

      // Smoke arrival time depends on direction
      let arrivalSeconds;
      if (floor > fireFloor) {
        // Above fire: stack effect pulls smoke up rapidly through shafts
        arrivalSeconds = distanceFromFire / stackVelocity;
      } else if (floor < fireFloor) {
        // Below fire: slower, smoke sinks only if cooled or pressurized
        arrivalSeconds = distanceFromFire / (stackVelocity * 0.3);
      } else {
        // Same floor: immediate
        arrivalSeconds = 0;
      }

      // Visibility decreases as smoke arrives
      // Initial visibility ~10m, drops to <3m within minutes
      const visibilityM = floor === fireFloor ? 1
        : Math.min(10, 10 * Math.exp(-0.5 * (300 / Math.max(arrivalSeconds, 1))));

      // Toxicity level based on material and distance
      const toxicityBase = this.material === '화학물질' ? 0.9
        : this.material === '플라스틱' ? 0.7
        : this.material === '가스' ? 0.8 : 0.4;
      const toxicity = toxicityBase * Math.exp(-0.1 * Math.abs(floor - fireFloor));

      results.push({
        floor,
        floorLabel: floor > 0 ? `${floor}층` : `지하${Math.abs(floor)}층`,
        smokeArrivalSeconds: Math.round(arrivalSeconds),
        smokeArrivalMinutes: Math.round(arrivalSeconds / 60 * 10) / 10,
        visibilityM: Math.round(visibilityM * 10) / 10,
        toxicity: Math.round(toxicity * 100) / 100,
        dangerLevel: arrivalSeconds < 120 ? 'CRITICAL'
          : arrivalSeconds < 300 ? 'DANGER' : 'CAUTION',
        isFireFloor: floor === fireFloor,
        isAboveFire: floor > fireFloor,
      });
    }

    // Sort by arrival time (most urgent first)
    results.sort((a, b) => a.smokeArrivalSeconds - b.smokeArrivalSeconds);

    return results;
  }

  /**
   * Full simulation combining outdoor + indoor
   */
  simulate(maxMinutes = 60) {
    return {
      timestamp: new Date().toISOString(),
      config: {
        windSpeed: this.windSpeed,
        windDirection: this.windDirection,
        material: this.material,
        stabilityClass: this.stability.name,
      },
      outdoor: this.predictOutdoor(maxMinutes),
      indoor: this.buildingInfo ? this.predictIndoor() : [],
    };
  }
}
