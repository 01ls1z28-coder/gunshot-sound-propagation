/**
 * Acoustics — Phase 1 + Phase 2 of the Gunshot Sound Propagation web port.
 *
 * Phase 1:
 *   - Wind: directional refraction-style factor
 *     factor = 1 + 0.03·v·cos(relAngle), clamped [0.7, 1.3]; ΔL = 20·log10(factor).
 *   - Atmospheric absorption: ISO 9613-1:1993 pure-tone α (dB/m), Eq. (5).
 *
 * Phase 2:
 *   - Continuous / field SPL: existing 3-band weighted Propagate pipeline
 *     (LowWeight·L_low + MidWeight·L_mid + HighWeight·L_high), then optional
 *     shockwave merge in the pressure domain (same as desktop-derived port).
 *   - Peak-style estimate: coherent pressure-domain sum of the three band
 *     linear pressures p_i = 10^(L_i/20), plus shock pressure when isSupersonic;
 *     L_peak≈ = 20·log₁₀(Σ p_i). Extends the same pressure-sum technique already
 *     used for field+shock merge — not a measured Lpeak / OSHA impulse criterion.
 *   - Distance-to-level: binary search on Propagate(distance) along a ray.
 *
 * Spherical spreading, terrain, ground reflection, band weights remain as in
 * the desktop-derived port.
 */
(function (global) {
  'use strict';

  var LowWeight = 0.45;
  var MidWeight = 0.35;
  var HighWeight = 0.20;

  function ApplySuppressor(muzzleSPL_dB, reduction_dB) {
    return muzzleSPL_dB - reduction_dB;
  }

  function SphericalSpreading(sourceSPL_dB, referenceDistance_m, distance_m) {
    if (distance_m < referenceDistance_m) {
      distance_m = referenceDistance_m;
    }
    var delta = 20.0 * Math.log10(distance_m / referenceDistance_m);
    return sourceSPL_dB - delta;
  }

  /**
   * ISO 9613-1:1993 atmospheric absorption — pure-tone α (dB/m), Eq. (5).
   * A_atm = α · d. Frequency f in Hz. Default pressure pa = pr = 101.325 kPa (1 atm).
   *
   * Table 1 style checks (dB/km = α·1000), console-only:
   *   20 °C, 50 % RH, 1000 Hz → ~4.66 dB/km
   *   10 °C, 70 % RH, 1000 Hz → ~3.66 dB/km
   */
  function iso9613Alpha_dB_per_m(tempC, humidityPct, frequencyHz, pa_kPa) {
    var T0 = 293.15; // K
    var pr = 101.325; // kPa
    var pa = pa_kPa == null ? pr : pa_kPa;
    var T = tempC + 273.15;
    var f = frequencyHz;

    // Annex B: saturation vapour pressure ratio psat/pr
    var psat_pr = Math.pow(10.0, -6.8346 * Math.pow(273.16 / T, 1.261) + 4.6151);
    // Molar concentration of water vapour (%)
    var h = humidityPct * (psat_pr) / (pa / pr);

    var frO =
      (pa / pr) * (24.0 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
    var frN =
      (pa / pr) *
      Math.pow(T / T0, -0.5) *
      (9.0 + 280.0 * h * Math.exp(-4.170 * (Math.pow(T / T0, -1.0 / 3.0) - 1.0)));

    var alpha =
      8.686 *
      f *
      f *
      (1.84e-11 * (pr / pa) * Math.sqrt(T / T0) +
        Math.pow(T / T0, -2.5) *
          (0.01275 * Math.exp(-2239.1 / T) / (frO + (f * f) / frO) +
            0.1068 * Math.exp(-3352.0 / T) / (frN + (f * f) / frN)));

    return alpha;
  }

  function AtmosphericAbsorption(spl_dB, distance_m, tempC, humidityPct, frequencyHz) {
    var alpha = iso9613Alpha_dB_per_m(tempC, humidityPct, frequencyHz, null);
    var loss = alpha * distance_m; // A_atm = α · d
    return spl_dB - loss;
  }

  // Optional ISO Table 1 self-check (console-only; skipped in production pages without console)
  if (typeof console !== 'undefined' && console.assert) {
    var a20 = iso9613Alpha_dB_per_m(20, 50, 1000, null) * 1000;
    var a10 = iso9613Alpha_dB_per_m(10, 70, 1000, null) * 1000;
    console.assert(
      Math.abs(a20 - 4.66) < 0.15,
      'ISO 9613-1 check: 20C/50%/1kHz expected ~4.66 dB/km, got ' + a20.toFixed(3)
    );
    console.assert(
      Math.abs(a10 - 3.66) < 0.15,
      'ISO 9613-1 check: 10C/70%/1kHz expected ~3.66 dB/km, got ' + a10.toFixed(3)
    );
  }

  function TerrainLoss(spl_dB, distance_m, terrain) {
    var alphaTerrain;
    switch (terrain) {
      case 'Forest':
        alphaTerrain = 0.01;
        break;
      case 'Urban':
        alphaTerrain = 0.02;
        break;
      case 'Indoor':
        alphaTerrain = 0.05;
        break;
      case 'Open Field':
      default:
        alphaTerrain = 0.002;
        break;
    }
    var loss = alphaTerrain * distance_m;
    return spl_dB - loss;
  }

  function ApplyGroundReflection(directSpl_dB, distance_m, sourceHeight_m, frequencyHz) {
    var c = 343.0;
    var lambda = c / frequencyHz;

    var directPath = distance_m;
    var reflectedPath = Math.sqrt(distance_m * distance_m + 4 * sourceHeight_m * sourceHeight_m);
    var delta = reflectedPath - directPath;

    var phase = 2.0 * Math.PI * delta / lambda;

    var reflectionCoeff = 0.6;

    var pDirect = Math.pow(10.0, directSpl_dB / 20.0);
    var pReflected = reflectionCoeff * pDirect;

    var pTotal = pDirect + pReflected * Math.cos(phase);
    if (pTotal <= 0) {
      pTotal = 0.000001;
    }

    return 20.0 * Math.log10(pTotal);
  }

  function SupersonicShockwave(muzzleSPL, distance_m, isSupersonic) {
    if (!isSupersonic) {
      return 0.0;
    }

    var shockSPL0 = muzzleSPL - 10.0;
    var shockSPL = SphericalSpreading(shockSPL0, 5.0, distance_m);

    if (shockSPL < 60.0) {
      shockSPL = 60.0;
    }

    return shockSPL;
  }

  /**
   * Directional wind refraction-style factor.
   * factor = 1 + 0.03·v·cos(relAngle), clamped [0.7, 1.3]; ΔL = 20·log10(factor).
   * cos>0 (downwind) boosts; cos<0 (upwind) attenuates.
   */
  function ApplyWind(spl_dB, distance_m, windSpeed_mps, windDirRad, rayAngleRad) {
    if (windSpeed_mps <= 0.01) {
      return spl_dB;
    }

    var relAngle = rayAngleRad - windDirRad;
    var cos = Math.cos(relAngle);

    var factor = 1.0 + 0.03 * windSpeed_mps * cos;
    factor = Math.max(0.7, Math.min(1.3, factor));

    return spl_dB + 20.0 * Math.log10(factor);
  }

  /**
   * Run the per-band pipeline; returns band SPLs + optional shock SPL.
   * Shared by continuous and peak-style estimators (Phase 2).
   */
  function PropagateBands(
    muzzleSPL,
    distance_m,
    tempC,
    humidityPct,
    terrain,
    isSupersonic,
    windSpeed_mps,
    windDirRad,
    rayAngleRad
  ) {
    var lowFreq = 125.0;
    var midFreq = 1000.0;
    var highFreq = 4000.0;
    var sourceHeight_m = 1.5;

    var splLow = SphericalSpreading(muzzleSPL, 1.0, distance_m);
    splLow = AtmosphericAbsorption(splLow, distance_m, tempC, humidityPct, lowFreq);
    splLow = TerrainLoss(splLow, distance_m, terrain);
    splLow = ApplyGroundReflection(splLow, distance_m, sourceHeight_m, lowFreq);
    splLow = ApplyWind(splLow, distance_m, windSpeed_mps, windDirRad, rayAngleRad);

    var splMid = SphericalSpreading(muzzleSPL, 1.0, distance_m);
    splMid = AtmosphericAbsorption(splMid, distance_m, tempC, humidityPct, midFreq);
    splMid = TerrainLoss(splMid, distance_m, terrain);
    splMid = ApplyGroundReflection(splMid, distance_m, sourceHeight_m, midFreq);
    splMid = ApplyWind(splMid, distance_m, windSpeed_mps, windDirRad, rayAngleRad);

    var splHigh = SphericalSpreading(muzzleSPL, 1.0, distance_m);
    splHigh = AtmosphericAbsorption(splHigh, distance_m, tempC, humidityPct, highFreq);
    splHigh = TerrainLoss(splHigh, distance_m, terrain);
    splHigh = ApplyGroundReflection(splHigh, distance_m, sourceHeight_m, highFreq);
    splHigh = ApplyWind(splHigh, distance_m, windSpeed_mps, windDirRad, rayAngleRad);

    var shockSPL = SupersonicShockwave(muzzleSPL, distance_m, isSupersonic);

    return {
      splLow: splLow,
      splMid: splMid,
      splHigh: splHigh,
      shockSPL: shockSPL
    };
  }

  /**
   * Continuous / field SPL — band-weighted dB average, then optional shock
   * merge in the pressure domain (identical to prior Propagate).
   */
  function continuousFromBands(bands) {
    var combined =
      LowWeight * bands.splLow +
      MidWeight * bands.splMid +
      HighWeight * bands.splHigh;

    if (bands.shockSPL > 0.0) {
      var pField = Math.pow(10.0, combined / 20.0);
      var pShock = Math.pow(10.0, bands.shockSPL / 20.0);
      var pTotal = pField + pShock;
      combined = 20.0 * Math.log10(pTotal);
    }

    return combined;
  }

  /**
   * Peak-style estimate from the same band pipeline (Phase 2).
   * Coherent pressure-domain sum: p_i = 10^(L_i/20); L_peak≈ = 20·log₁₀(Σ p_i)
   * (+ shock pressure when isSupersonic). Same pressure-sum technique as the
   * existing field+shock merge — engineering upper-bound style, not measured Lpeak.
   */
  function peakFromBands(bands) {
    var pLow = Math.pow(10.0, bands.splLow / 20.0);
    var pMid = Math.pow(10.0, bands.splMid / 20.0);
    var pHigh = Math.pow(10.0, bands.splHigh / 20.0);
    var pPeak = pLow + pMid + pHigh;

    if (bands.shockSPL > 0.0) {
      pPeak += Math.pow(10.0, bands.shockSPL / 20.0);
    }

    if (pPeak <= 0) {
      pPeak = 1e-12;
    }

    return 20.0 * Math.log10(pPeak);
  }

  /**
   * Propagate — continuous / field SPL (same signature as before).
   */
  function Propagate(
    muzzleSPL,
    distance_m,
    tempC,
    humidityPct,
    terrain,
    isSupersonic,
    windSpeed_mps,
    windDirRad,
    rayAngleRad
  ) {
    var bands = PropagateBands(
      muzzleSPL, distance_m, tempC, humidityPct, terrain,
      isSupersonic, windSpeed_mps, windDirRad, rayAngleRad
    );
    return continuousFromBands(bands);
  }

  /**
   * PropagateWithPeak — continuous field SPL + peak-style pressure-sum estimate.
   */
  function PropagateWithPeak(
    muzzleSPL,
    distance_m,
    tempC,
    humidityPct,
    terrain,
    isSupersonic,
    windSpeed_mps,
    windDirRad,
    rayAngleRad
  ) {
    var bands = PropagateBands(
      muzzleSPL, distance_m, tempC, humidityPct, terrain,
      isSupersonic, windSpeed_mps, windDirRad, rayAngleRad
    );
    return {
      continuous: continuousFromBands(bands),
      peak: peakFromBands(bands)
    };
  }

  /**
   * Binary-search radial distance (m) along rayAngleRad where continuous
   * Propagate equals targetDb. Assumes overall decay with distance
   * (ground-reflection ripples are small vs spreading+absorption+terrain).
   *
   * Returns { distance_m, status } where status is:
   *   'ok'           — root found in (1 m, maxDistance_m]
   *   'outside_map'  — SPL at maxDistance still ≥ target (never reaches level)
   *   'below_near'   — SPL already < target at 1 m reference
   */
  function DistanceToLevel(
    targetDb,
    maxDistance_m,
    muzzleSPL,
    tempC,
    humidityPct,
    terrain,
    isSupersonic,
    windSpeed_mps,
    windDirRad,
    rayAngleRad
  ) {
    var dMin = 1.0;
    var dMax = Math.max(dMin, maxDistance_m);

    function splAt(d) {
      return Propagate(
        muzzleSPL, d, tempC, humidityPct, terrain,
        isSupersonic, windSpeed_mps, windDirRad, rayAngleRad
      );
    }

    var splNear = splAt(dMin);
    if (splNear < targetDb) {
      return { distance_m: dMin, status: 'below_near' };
    }

    var splFar = splAt(dMax);
    if (splFar >= targetDb) {
      return { distance_m: dMax, status: 'outside_map' };
    }

    var lo = dMin;
    var hi = dMax;
    // 48 iterations → sub-mm precision over km-scale domains
    for (var i = 0; i < 48; i++) {
      var mid = 0.5 * (lo + hi);
      if (splAt(mid) >= targetDb) {
        lo = mid; // still at/above target → search farther
      } else {
        hi = mid;
      }
    }

    return { distance_m: 0.5 * (lo + hi), status: 'ok' };
  }

  global.Acoustics = {
    ApplySuppressor: ApplySuppressor,
    SphericalSpreading: SphericalSpreading,
    Propagate: Propagate,
    PropagateWithPeak: PropagateWithPeak,
    DistanceToLevel: DistanceToLevel,
    // Exposed for validation / debugging
    _iso9613Alpha_dB_per_m: iso9613Alpha_dB_per_m,
    _ApplyWind: ApplyWind,
    _peakFromBands: peakFromBands,
    _continuousFromBands: continuousFromBands
  };
})(typeof window !== 'undefined' ? window : globalThis);
