/**
 * Acoustics — faithful port of Acoustics.cs from GunshotSoundPropagationSimulator.
 * Do not change the physics without updating the C# source of truth.
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

  function AtmosphericAbsorption(spl_dB, distance_m, tempC, humidityPct, frequencyHz) {
    var h = humidityPct / 100.0; // retained for parity with C# (unused in alpha)

    var alphaBase;
    if (frequencyHz < 300) {
      alphaBase = 0.0001;
    } else if (frequencyHz < 1500) {
      alphaBase = 0.0003;
    } else {
      alphaBase = 0.0010;
    }

    var tempFactor = 1.0 + 0.01 * (tempC - 20.0);
    tempFactor = Math.max(0.8, Math.min(1.2, tempFactor));

    var humidityFactor = 1.0 + 0.01 * (humidityPct - 50.0);
    humidityFactor = Math.max(0.7, Math.min(1.3, humidityFactor));

    var alpha = alphaBase * tempFactor * humidityFactor;
    var loss = alpha * distance_m;
    return spl_dB - loss;
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

  function ApplyWind(spl_dB, distance_m, windSpeed_mps, windDirRad, rayAngleRad) {
    if (windSpeed_mps <= 0.01) {
      return spl_dB;
    }

    var relAngle = rayAngleRad - windDirRad;
    var cos = Math.cos(relAngle);

    var downwindFactor = 1.0 + 0.03 * windSpeed_mps * cos;
    var upwindFactor = 1.0 - 0.03 * windSpeed_mps * cos;

    var factor = cos >= 0 ? downwindFactor : upwindFactor;
    factor = Math.max(0.7, Math.min(1.3, factor));

    return spl_dB + 20.0 * Math.log10(factor);
  }

  /**
   * Propagate — same signature and pipeline as Acoustics.Propagate in Acoustics.cs
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

    var combined =
      LowWeight * splLow +
      MidWeight * splMid +
      HighWeight * splHigh;

    var shockSPL = SupersonicShockwave(muzzleSPL, distance_m, isSupersonic);

    if (shockSPL > 0.0) {
      var pField = Math.pow(10.0, combined / 20.0);
      var pShock = Math.pow(10.0, shockSPL / 20.0);
      var pTotal = pField + pShock;
      combined = 20.0 * Math.log10(pTotal);
    }

    return combined;
  }

  global.Acoustics = {
    ApplySuppressor: ApplySuppressor,
    SphericalSpreading: SphericalSpreading,
    Propagate: Propagate
  };
})(typeof window !== 'undefined' ? window : globalThis);
