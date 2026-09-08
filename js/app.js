/**
 * UI + noise-map renderer — port of MainWindow.xaml / MainWindow.xaml.cs
 * Grid is capped for browser performance (see MAX_CELLS_PER_AXIS).
 */
(function () {
  'use strict';

  /** Cap cells per axis so a 1000 m domain does not freeze the browser. */
  var MAX_CELLS_PER_AXIS = 180;

  var lastGrid = null;
  var cellSize_m = 1.0;
  var lastMaxDistance = 1000;
  var lastGridSize = 0;

  var canvas = document.getElementById('noiseMap');
  var ctx = canvas.getContext('2d');
  var cursorReadout = document.getElementById('cursorReadout');
  var gridInfo = document.getElementById('gridInfo');
  var legendModal = document.getElementById('legendModal');

  function parseOrDefault(text, fallback) {
    var value = parseFloat(String(text).replace(',', '.'));
    return isFinite(value) ? value : fallback;
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
      gridInfo.textContent =
        'Grid: ' + gridSize + '×' + gridSize +
        ' · cell ≈ ' + cellSize_m.toFixed(2) + ' m' +
        ' · cap ' + MAX_CELLS_PER_AXIS + ' / axis';
    }

    return { data: grid, size: gridSize };
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

    // Fit canvas to container while keeping square aspect
    var wrap = canvas.parentElement;
    var side = Math.min(wrap.clientWidth, wrap.clientHeight || wrap.clientWidth, 720);
    if (side < 280) side = Math.max(280, wrap.clientWidth);
    canvas.width = side;
    canvas.height = side;

    ctx.imageSmoothingEnabled = true;
    ctx.clearRect(0, 0, side, side);
    ctx.drawImage(off, 0, 0, side, side);

    // Distance rings (every 50 m up to diameter, scaled to pixels)
    var centerPx = side / 2;
    var pxPerM = side / (maxDistance * 2);
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    ctx.font = '12px "Segoe UI", system-ui, sans-serif';

    for (var dist = 50; dist <= maxDistance * 2; dist += 50) {
      var radiusPx = dist * pxPerM;
      if (radiusPx > side * 0.55) continue; // keep labels readable
      ctx.beginPath();
      ctx.arc(centerPx, centerPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(dist + ' m', centerPx + radiusPx + 6, centerPx + 4);
    }

    // Source marker
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(centerPx, centerPx, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function generateNoiseMap() {
    var startingSPL = parseOrDefault(document.getElementById('startingSPL').value, 165.0);
    var maxDistance = parseOrDefault(document.getElementById('maxDistance').value, 1000.0);
    var tempC = parseOrDefault(document.getElementById('tempC').value, 20.0);
    var humidityPct = parseOrDefault(document.getElementById('humidity').value, 50.0);
    var terrain = document.getElementById('terrain').value || 'Open Field';
    var windSpeed = parseOrDefault(document.getElementById('windSpeed').value, 0.0);
    var windDirDeg = parseOrDefault(document.getElementById('windDir').value, 0.0);
    var windDirRad = windDirDeg * Math.PI / 180.0;

    if (maxDistance < 10) maxDistance = 10;
    if (maxDistance > 5000) maxDistance = 5000;

    var btn = document.getElementById('btnGenerate');
    btn.disabled = true;
    btn.textContent = 'Computing…';

    // Yield so UI can update before heavy loop
    setTimeout(function () {
      lastGrid = generateGrid(startingSPL, tempC, humidityPct, terrain, windSpeed, windDirRad, maxDistance);
      renderGrid(lastGrid, maxDistance);
      btn.disabled = false;
      btn.textContent = 'Generate Noise Map';
      cursorReadout.textContent = 'SPL: --- dB   Dist: --- m';
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
    var x = Math.round(px / canvas.width * size);
    var y = Math.round(py / canvas.height * size);

    if (x < 0 || y < 0 || x >= size || y >= size) {
      cursorReadout.textContent = 'SPL: --- dB   Dist: --- m';
      return;
    }

    var spl = lastGrid.data[x * size + y];
    var center = size / 2;
    var dx = (x - center) * cellSize_m;
    var dy = (y - center) * cellSize_m;
    var dist_m = Math.sqrt(dx * dx + dy * dy);
    cursorReadout.textContent = 'SPL: ' + spl.toFixed(1) + ' dB   Dist: ' + dist_m.toFixed(1) + ' m';
  }

  function showLegend() {
    legendModal.hidden = false;
  }

  function hideLegend() {
    legendModal.hidden = true;
  }

  document.getElementById('btnGenerate').addEventListener('click', generateNoiseMap);
  document.getElementById('btnLegend').addEventListener('click', showLegend);
  document.getElementById('btnCloseLegend').addEventListener('click', hideLegend);
  legendModal.addEventListener('click', function (e) {
    if (e.target === legendModal) hideLegend();
  });
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    onCanvasMove(e);
  }, { passive: false });

  window.addEventListener('resize', function () {
    if (lastGrid) renderGrid(lastGrid, lastMaxDistance);
  });

  // Initial map
  generateNoiseMap();
})();
