/**
 * UI + noise-map renderer — port of MainWindow.xaml / MainWindow.xaml.cs
 * Grid is capped for browser performance (see MAX_CELLS_PER_AXIS).
 * Internal acoustics stay metric (SI); UI converts ↔ display units on toggle.
 */
(function () {
  'use strict';

  /** Cap cells/axis (browser perf). Higher = smoother rings; physics unchanged. */
  var MAX_CELLS_PER_AXIS = 400;

  /**
   * Official OSHA 29 CFR 1910.95 reference levels (same set as Sound Distance Calculator).
   * Action level: 1910.95(c)(1)–(c)(2). Others: Table G-16 (dBA slow response).
   * Contours follow the modeled SPL field (not forced circles).
   */
  var OSHA_LINES = [
    { db: 85, label: '85 action', color: 'rgba(200, 255, 74, 0.95)' },
    { db: 90, label: '90 / 8 h', color: 'rgba(255, 196, 86, 0.92)' },
    { db: 95, label: '95 / 4 h', color: 'rgba(255, 168, 76, 0.9)' },
    { db: 100, label: '100 / 2 h', color: 'rgba(255, 120, 90, 0.9)' },
    { db: 105, label: '105 / 1 h', color: 'rgba(255, 90, 110, 0.9)' },
    { db: 115, label: '115 / ≤¼ h', color: 'rgba(255, 72, 120, 0.95)' }
  ];

  var M_PER_FT = 0.3048;
  var MPS_PER_MPH = 0.44704;

  var lastGrid = null;
  var cellSize_m = 1.0;
  var lastMaxDistance = 1000;
  var lastGridSize = 0;
  /** @type {'metric'|'imperial'} */
  var units = 'metric';

  var canvas = document.getElementById('noiseMap');
  var ctx = canvas.getContext('2d');
  var cursorReadout = document.getElementById('cursorReadout');
  var gridInfo = document.getElementById('gridInfo');

  function parseOrDefault(text, fallback) {
    var value = parseFloat(String(text).replace(',', '.'));
    return isFinite(value) ? value : fallback;
  }

  function distUnit() {
    return units === 'metric' ? 'm' : 'ft';
  }

  function formatDist(meters) {
    if (units === 'metric') {
      return meters.toFixed(1) + ' m';
    }
    return (meters / M_PER_FT).toFixed(1) + ' ft';
  }

  function mapSPLToColor(spl) {
    var min = 60;
    var max = 180;
    var t = (spl - min) / (max - min);
    t = Math.max(0, Math.min(1, t));
    var r = Math.round(255 * t);
    var g = Math.round(255 * (1 - Math.abs(t - 0.5) * 2));
    var b = Math.round(255 * (1 - t));
    return [r, g, b];
  }

  /**
   * Domain matches desktop: diameter = 2 * maxDistance meters, source at center.
   * Cell size scales up when that would exceed MAX_CELLS_PER_AXIS.
   */
  function resolveGrid(maxDistance) {
    var domainM = maxDistance * 2;
    var idealCells = Math.max(2, Math.floor(domainM)); // 1 m cells like desktop
    var gridSize = Math.min(idealCells, MAX_CELLS_PER_AXIS);
    // Prefer even size so center is clean
    if (gridSize % 2 !== 0) gridSize -= 1;
    if (gridSize < 2) gridSize = 2;
    var cs = domainM / gridSize;
    return { gridSize: gridSize, cellSize_m: cs, domainM: domainM };
  }

  function generateGrid(startingSPL, tempC, humidityPct, terrain, windSpeed, windDirRad, maxDistance) {
    var res = resolveGrid(maxDistance);
    cellSize_m = res.cellSize_m;
    lastMaxDistance = maxDistance;
    lastGridSize = res.gridSize;

    var gridSize = res.gridSize;
    var grid = new Float64Array(gridSize * gridSize);
    var center = gridSize / 2;

    for (var x = 0; x < gridSize; x++) {
      for (var y = 0; y < gridSize; y++) {
        var dx = (x - center) * cellSize_m;
        var dy = (y - center) * cellSize_m;
        var distance_m = Math.sqrt(dx * dx + dy * dy);
        if (distance_m < 1.0) distance_m = 1.0;
        var angleRad = Math.atan2(dy, dx);
        // Desktop MainWindow hardcodes isSupersonic = false
        var spl = Acoustics.Propagate(
          startingSPL, distance_m, tempC, humidityPct,
          terrain, false, windSpeed, windDirRad, angleRad
        );
        grid[x * gridSize + y] = spl;
      }
    }

    if (gridInfo) {
      var cellLabel = units === 'metric'
        ? cellSize_m.toFixed(2) + ' m'
        : (cellSize_m / M_PER_FT).toFixed(2) + ' ft';
      gridInfo.textContent =
        'Grid: ' + gridSize + '×' + gridSize +
        ' · cell ≈ ' + cellLabel +
        ' · cap ' + MAX_CELLS_PER_AXIS + ' / axis';
    }

    return { data: grid, size: gridSize };
  }


  function roundRectPath(c, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + radius, y);
    c.arcTo(x + w, y, x + w, y + h, radius);
    c.arcTo(x + w, y + h, x, y + h, radius);
    c.arcTo(x, y + h, x, y, radius);
    c.arcTo(x, y, x + w, y, radius);
    c.closePath();
  }

  function isoFrac(v0, v1, level) {
    var d = v1 - v0;
    if (Math.abs(d) < 1e-12) return 0.5;
    return (level - v0) / d;
  }

  /**
   * Marching-squares iso-contours on the SPL grid, stroked in canvas pixels.
   * Grid index: data[x * size + y] (same as heatmap).
   */
  function drawOshaContours(pack, side) {
    var data = pack.data;
    var size = pack.size;
    if (!data || size < 2) return;

    var scale = side / size;
    var segmentsByLevel = [];

    for (var li = 0; li < OSHA_LINES.length; li++) {
      var level = OSHA_LINES[li].db;
      var segs = [];

      for (var x = 0; x < size - 1; x++) {
        for (var y = 0; y < size - 1; y++) {
          var v00 = data[x * size + y];
          var v10 = data[(x + 1) * size + y];
          var v11 = data[(x + 1) * size + (y + 1)];
          var v01 = data[x * size + (y + 1)];

          var b0 = v00 >= level ? 1 : 0;
          var b1 = v10 >= level ? 2 : 0;
          var b2 = v11 >= level ? 4 : 0;
          var b3 = v01 >= level ? 8 : 0;
          var caseId = b0 | b1 | b2 | b3;
          if (caseId === 0 || caseId === 15) continue;

          // Edge crossings in grid space (linear interp along edges)
          var tx = x + isoFrac(v00, v10, level);
          var ty = y;
          var rx = x + 1;
          var ry = y + isoFrac(v10, v11, level);
          var bx = x + isoFrac(v01, v11, level);
          var by = y + 1;
          var lx = x;
          var ly = y + isoFrac(v00, v01, level);

          // Standard marching-squares edge pairs (ambiguous 5/10: consistent diagonal)
          switch (caseId) {
            case 1: case 14:
              segs.push(lx, ly, tx, ty); break;
            case 2: case 13:
              segs.push(tx, ty, rx, ry); break;
            case 3: case 12:
              segs.push(lx, ly, rx, ry); break;
            case 4: case 11:
              segs.push(rx, ry, bx, by); break;
            case 6: case 9:
              segs.push(tx, ty, bx, by); break;
            case 7: case 8:
              segs.push(lx, ly, bx, by); break;
            case 5:
              segs.push(lx, ly, tx, ty, rx, ry, bx, by); break;
            case 10:
              segs.push(tx, ty, rx, ry, lx, ly, bx, by); break;
            default:
              break;
          }
        }
      }
      segmentsByLevel.push(segs);
    }

    for (var i = 0; i < OSHA_LINES.length; i++) {
      var line = OSHA_LINES[i];
      var segs2 = segmentsByLevel[i];
      if (!segs2.length) continue;

      ctx.save();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();

      var labelGx = null;
      var labelGy = null;
      var bestScore = -Infinity;

      for (var s = 0; s < segs2.length; s += 4) {
        var x0 = segs2[s] * scale;
        var y0 = segs2[s + 1] * scale;
        var x1 = segs2[s + 2] * scale;
        var y1 = segs2[s + 3] * scale;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);

        // Prefer a label anchor toward the east (+x) mid-height for readability
        var mx = (segs2[s] + segs2[s + 2]) * 0.5;
        var my = (segs2[s + 1] + segs2[s + 3]) * 0.5;
        var score = mx - Math.abs(my - size * 0.5) * 0.35;
        if (score > bestScore) {
          bestScore = score;
          labelGx = mx;
          labelGy = my;
        }
      }
      ctx.stroke();
      ctx.setLineDash([]);

      if (labelGx != null) {
        var lx = labelGx * scale;
        var ly = labelGy * scale;
        ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'left';
        var padX = 5;
        var boxH = 14;
        var metrics = ctx.measureText(line.label);
        var boxW = metrics.width + padX * 2;
        var boxX = lx + 4;
        var boxY = ly - boxH / 2;
        if (boxX + boxW > side - 2) boxX = lx - boxW - 4;
        if (boxY < 2) boxY = 2;
        if (boxY + boxH > side - 2) boxY = side - boxH - 2;

        ctx.fillStyle = 'rgba(8, 10, 14, 0.82)';
        ctx.strokeStyle = line.color;
        ctx.lineWidth = 1;
        roundRectPath(ctx, boxX, boxY, boxW, boxH, 3);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = line.color;
        ctx.fillText(line.label, boxX + padX, boxY + boxH / 2);
      }
      ctx.restore();
    }
  }

  function renderGrid(pack, maxDistance) {
    var grid = pack.data;
    var w = pack.size;
    var h = pack.size;

    // Offscreen pixel buffer at grid resolution, then scale to canvas
    var off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    var octx = off.getContext('2d');
    var img = octx.createImageData(w, h);
    var pixels = img.data;

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var spl = grid[x * w + y];
        var rgb = mapSPLToColor(spl);
        var index = (y * w + x) * 4;
        pixels[index] = rgb[0];
        pixels[index + 1] = rgb[1];
        pixels[index + 2] = rgb[2];
        pixels[index + 3] = 255;
      }
    }
    octx.putImageData(img, 0, 0);

    // Fill map-wrap (square panel) — no 720px cap / letterboxing
    var wrap = canvas.parentElement;
    var side = Math.floor(Math.min(wrap.clientWidth || 0, wrap.clientHeight || 0));
    if (side < 2) {
      // Fallback before layout settles
      side = Math.floor(wrap.clientWidth || canvas.clientWidth || 512);
    }
    if (side < 2) side = 512;
    canvas.width = side;
    canvas.height = side;

    ctx.imageSmoothingEnabled = true;
    if (ctx.imageSmoothingQuality) ctx.imageSmoothingQuality = 'high';
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(off, 0, 0, side, side);

    // Distance rings — step in display units, convert to meters for geometry
    var centerPx = side / 2;
    var pxPerM = side / (maxDistance * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';

    var ringStepM;
    var ringLabel;
    if (units === 'metric') {
      ringStepM = 50;
      ringLabel = function (m) { return m + ' m'; };
    } else {
      ringStepM = 100 * M_PER_FT; // every 100 ft
      ringLabel = function (m) { return Math.round(m / M_PER_FT) + ' ft'; };
    }

    for (var dist = ringStepM; dist <= maxDistance * 2; dist += ringStepM) {
      var radiusPx = dist * pxPerM;
      if (radiusPx > side * 0.55) continue; // keep labels readable
      ctx.beginPath();
      ctx.arc(centerPx, centerPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(ringLabel(dist), centerPx + radiusPx + 6, centerPx + 4);
    }

    // OSHA iso-contours follow the SPL field (wind may distort circles)
    drawOshaContours(pack, side);

    // Source marker
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(centerPx, centerPx, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  /** Read UI fields and convert to SI for acoustics. */
  function readInputsAsSI() {
    var startingSPL = parseOrDefault(document.getElementById('startingSPL').value, 165.0);
    var maxDistRaw = parseOrDefault(document.getElementById('maxDistance').value, units === 'metric' ? 1000 : 3281);
    var tempRaw = parseOrDefault(document.getElementById('tempC').value, units === 'metric' ? 20 : 68);
    var humidityPct = parseOrDefault(document.getElementById('humidity').value, 50.0);
    var terrain = document.getElementById('terrain').value || 'Open Field';
    var windRaw = parseOrDefault(document.getElementById('windSpeed').value, 0.0);
    var windDirDeg = parseOrDefault(document.getElementById('windDir').value, 0.0);

    var maxDistance_m;
    var tempC;
    var windSpeed_mps;

    if (units === 'metric') {
      maxDistance_m = maxDistRaw;
      tempC = tempRaw;
      windSpeed_mps = windRaw;
    } else {
      maxDistance_m = maxDistRaw * M_PER_FT;
      tempC = (tempRaw - 32) * (5 / 9);
      windSpeed_mps = windRaw * MPS_PER_MPH;
    }

    if (maxDistance_m < 10) maxDistance_m = 10;
    if (maxDistance_m > 5000) maxDistance_m = 5000;

    return {
      startingSPL: startingSPL,
      maxDistance_m: maxDistance_m,
      tempC: tempC,
      humidityPct: humidityPct,
      terrain: terrain,
      windSpeed_mps: windSpeed_mps,
      windDirRad: windDirDeg * Math.PI / 180.0
    };
  }

  function generateNoiseMap() {
    var inp = readInputsAsSI();

    var btn = document.getElementById('btnGenerate');
    btn.disabled = true;
    btn.textContent = 'Computing…';

    // Yield so UI can update before heavy loop
    setTimeout(function () {
      lastGrid = generateGrid(
        inp.startingSPL, inp.tempC, inp.humidityPct, inp.terrain,
        inp.windSpeed_mps, inp.windDirRad, inp.maxDistance_m
      );
      renderGrid(lastGrid, inp.maxDistance_m);
      btn.disabled = false;
      btn.textContent = 'Generate Noise Map';
      cursorReadout.textContent = 'SPL: --- dB   Dist: --- ' + distUnit();
    }, 20);
  }

  function onCanvasMove(e) {
    if (!lastGrid) return;
    var rect = canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    var px = clientX - rect.left;
    var py = clientY - rect.top;

    var size = lastGrid.size;
    // Map CSS pixels → grid via displayed size (not bitmap width) so CSS scaling stays accurate
    var dispW = rect.width || canvas.width;
    var dispH = rect.height || canvas.height;
    var x = Math.floor(px / dispW * size);
    var y = Math.floor(py / dispH * size);

    if (x < 0 || y < 0 || x >= size || y >= size) {
      cursorReadout.textContent = 'SPL: --- dB   Dist: --- ' + distUnit();
      return;
    }

    var spl = lastGrid.data[x * size + y];
    var center = size / 2;
    var dx = (x - center) * cellSize_m;
    var dy = (y - center) * cellSize_m;
    var dist_m = Math.sqrt(dx * dx + dy * dy);
    cursorReadout.textContent = 'SPL: ' + spl.toFixed(1) + ' dB   Dist: ' + formatDist(dist_m);
  }

  function updateUnitLabels() {
    var labelMax = document.getElementById('labelMaxDistance');
    var labelTemp = document.getElementById('labelTemp');
    var labelWind = document.getElementById('labelWindSpeed');
    var maxInput = document.getElementById('maxDistance');
    var windInput = document.getElementById('windSpeed');

    if (units === 'metric') {
      labelMax.textContent = 'Max Distance (m)';
      labelTemp.textContent = 'Temp (°C)';
      labelWind.textContent = 'Speed (m/s)';
      maxInput.step = '10';
      maxInput.min = '10';
      maxInput.max = '5000';
      windInput.step = '0.5';
    } else {
      labelMax.textContent = 'Max Distance (ft)';
      labelTemp.textContent = 'Temp (°F)';
      labelWind.textContent = 'Speed (mph)';
      maxInput.step = '50';
      maxInput.min = '30';
      maxInput.max = '16400';
      windInput.step = '1';
    }
  }

  /** Convert displayed field values when toggling unit system (physics-preserving). */
  function convertDisplayedValues(from, to) {
    if (from === to) return;
    var maxEl = document.getElementById('maxDistance');
    var tempEl = document.getElementById('tempC');
    var windEl = document.getElementById('windSpeed');

    var maxV = parseOrDefault(maxEl.value, from === 'metric' ? 1000 : 3281);
    var tempV = parseOrDefault(tempEl.value, from === 'metric' ? 20 : 68);
    var windV = parseOrDefault(windEl.value, 0);

    if (from === 'metric' && to === 'imperial') {
      maxEl.value = String(Math.round(maxV / M_PER_FT));
      tempEl.value = String(Math.round(tempV * 9 / 5 + 32));
      windEl.value = String(Math.round(windV / MPS_PER_MPH * 10) / 10);
    } else {
      maxEl.value = String(Math.round(maxV * M_PER_FT));
      tempEl.value = String(Math.round((tempV - 32) * 5 / 9));
      windEl.value = String(Math.round(windV * MPS_PER_MPH * 10) / 10);
    }
  }

  function setUnits(next) {
    if (next === units) return;
    var prev = units;
    convertDisplayedValues(prev, next);
    units = next;
    updateUnitLabels();

    var btnM = document.getElementById('btnMetric');
    var btnI = document.getElementById('btnImperial');
    btnM.classList.toggle('is-active', units === 'metric');
    btnI.classList.toggle('is-active', units === 'imperial');
    btnM.setAttribute('aria-pressed', units === 'metric' ? 'true' : 'false');
    btnI.setAttribute('aria-pressed', units === 'imperial' ? 'true' : 'false');

    // Re-render map labels/rings in new units without recomputing physics if grid exists
    if (lastGrid) {
      renderGrid(lastGrid, lastMaxDistance);
      if (gridInfo) {
        var cellLabel = units === 'metric'
          ? cellSize_m.toFixed(2) + ' m'
          : (cellSize_m / M_PER_FT).toFixed(2) + ' ft';
        gridInfo.textContent =
          'Grid: ' + lastGrid.size + '×' + lastGrid.size +
          ' · cell ≈ ' + cellLabel +
          ' · cap ' + MAX_CELLS_PER_AXIS + ' / axis';
      }
      cursorReadout.textContent = 'SPL: --- dB   Dist: --- ' + distUnit();
    }
  }

  document.getElementById('btnGenerate').addEventListener('click', generateNoiseMap);
  document.getElementById('btnMetric').addEventListener('click', function () { setUnits('metric'); });
  document.getElementById('btnImperial').addEventListener('click', function () { setUnits('imperial'); });
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    onCanvasMove(e);
  }, { passive: false });

  window.addEventListener('resize', function () {
    if (lastGrid) renderGrid(lastGrid, lastMaxDistance);
  });

  updateUnitLabels();
  // Initial map after layout paints so square panel has non-zero size
  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      generateNoiseMap();
    });
  });
})();
