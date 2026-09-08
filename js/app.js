/**
 * UI + noise-map renderer — port of MainWindow.xaml / MainWindow.xaml.cs
 * Grid is capped for browser performance (see MAX_CELLS_PER_AXIS).
 * Internal acoustics stay metric (SI); UI converts ↔ display units on toggle.
 *
 * Phase 2: continuous + peak-style cursor readout; live distance-to-OSHA table
 * (downwind / upwind / crosswind); OSHA 140 dB peak impulsive row.
 *
 * Phase 3: baked gun / suppressor profiles (GSP_PROFILES); bare vs suppressed
 * compare on map source toggle + dual OSHA columns. Suppressed path prefers
 * ApplySuppressor(muzzle, reduction_dB) only when selected bare host matches
 * the suppressor measurement host (bare_ref_id / host_key); otherwise
 * Propagate(ml_dba) — never transplant another host reduction.
 *
 * Phase 4: stagger distance-ring vs OSHA chip anchors (no same-ray stack),
 * opaque chip/backs + overlap skip; A/B localStorage scenarios; CSV export
 * of radial / OSHA distances for active (+ saved A/B) scenarios.
 */
(function () {
  'use strict';

  /** Cap cells/axis (browser perf). Higher = smoother rings; physics unchanged. */
  var MAX_CELLS_PER_AXIS = 400;

  /**
   * Official OSHA 29 CFR 1910.95 reference levels (same set as Sound Distance Calculator).
   * Action level: 1910.95(c)(1)–(c)(2). Others: Table G-16 (dBA slow response).
   * Contours follow the modeled continuous SPL field (not forced circles).
   * Distances are searched on continuous Propagate unless peakSearch is true.
   */
  var OSHA_LINES = [
    { db: 85, label: '85 · action', color: 'rgba(200, 255, 74, 0.95)', peakSearch: false },
    { db: 90, label: '90 · 8 h', color: 'rgba(255, 196, 86, 0.92)', peakSearch: false },
    { db: 95, label: '95 · 4 h', color: 'rgba(255, 168, 76, 0.9)', peakSearch: false },
    { db: 100, label: '100 · 2 h', color: 'rgba(255, 120, 90, 0.9)', peakSearch: false },
    { db: 105, label: '105 · 1 h', color: 'rgba(255, 90, 110, 0.9)', peakSearch: false },
    { db: 115, label: '115 · ≤¼ h', color: 'rgba(255, 72, 120, 0.95)', peakSearch: false }
  ];

  /** OSHA 1910.95 impulsive/impact footnote: ≤140 dB peak SPL — table row only (not map contour). */
  var OSHA_PEAK_LINE = {
    db: 140,
    label: '140 peak',
    peakSearch: true
  };

  var M_PER_FT = 0.3048;
  var MPS_PER_MPH = 0.44704;

  var profiles = (typeof GSP_PROFILES !== 'undefined' && GSP_PROFILES) ? GSP_PROFILES : null;
  var hostBare = profiles && Array.isArray(profiles.HOST_BARE_PROFILES) ? profiles.HOST_BARE_PROFILES : [];
  var suppressors = profiles && Array.isArray(profiles.SUPPRESSOR_PROFILES) ? profiles.SUPPRESSOR_PROFILES : [];
  var caliberList = profiles && Array.isArray(profiles.CALIBERS)
    ? profiles.CALIBERS.slice()
    : uniqueSorted(suppressors.map(function (s) { return s.caliber; }));

  var selectedSuppressorId = null;
  var selectedBareId = 'custom';
  /** @type {'bare'|'suppressed'} */
  var mapSource = 'bare';
  /** @type {'bare'|'suppressed'} OSHA distance table tab */
  var oshaView = 'bare';

  var lastGrid = null;
  var cellSize_m = 1.0;
  var lastMaxDistance = 1000;
  var lastGridSize = 0;
  /** @type {'metric'|'imperial'} */
  var units = 'metric';
  /** Last SI inputs used for map / distance table (for hover peak recompute). */
  var lastInputs = null;
  var distanceUpdateTimer = null;
  var listFilterTimer = null;

  /** Phase 4 — session A/B scenario slots (localStorage). */
  var AB_STORAGE_KEY = 'gsp_phase4_scenarios_v1';
  /** @type {{A: object|null, B: object|null}} */
  var abSlots = { A: null, B: null };

  /**
   * Polar stagger so ring labels and OSHA chips never share the east mid-ray
   * (Jorge snip: "50 m" / "100 m" under "2 h" / "4 h" chips).
   * Canvas +y is down: +angle = SE (below east), −angle = NE (above east).
   */
  var RING_LABEL_ANGLE_RAD = 28 * Math.PI / 180;
  var OSHA_CHIP_TARGET_ANGLE_RAD = -38 * Math.PI / 180;
  var LABEL_PAD = 10;

  var canvas = document.getElementById('noiseMap');
  var ctx = canvas.getContext('2d');
  var cursorReadout = document.getElementById('cursorReadout');
  var gridInfo = document.getElementById('gridInfo');
  var oshaDistanceBody = document.getElementById('oshaDistanceBody');

  function uniqueSorted(arr) {
    var seen = Object.create(null);
    var out = [];
    for (var i = 0; i < arr.length; i++) {
      var v = arr[i];
      if (v == null || seen[v]) continue;
      seen[v] = 1;
      out.push(v);
    }
    out.sort(function (a, b) { return String(a).localeCompare(String(b)); });
    return out;
  }

  function hostKey(caliber) {
    return String(caliber || '')
      .replace(/\s+TBS20\d{2}\b/g, ' TBS')
      .replace(/\s+Online Marketing Data\b/gi, '')
      .replace(/\s+Mrgunsngear\b/gi, '')
      .replace(/\s+MGAG\b/gi, '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
  }

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

  function formatDistCell(result) {
    if (!result) {
      return '<span class="na">—</span>';
    }
    if (result.status === 'outside_map') {
      return '<span class="beyond">beyond max distance</span>';
    }
    return formatDist(result.distance_m);
  }

  function formatDb(v) {
    if (v == null || !isFinite(v)) return '—';
    return Number(v).toFixed(1) + ' dB';
  }

  function findBareById(id) {
    for (var i = 0; i < hostBare.length; i++) {
      if (hostBare[i].id === id) return hostBare[i];
    }
    return null;
  }

  function findSuppressorById(id) {
    for (var i = 0; i < suppressors.length; i++) {
      if (suppressors[i].id === id) return suppressors[i];
    }
    return null;
  }

  /**
   * Resolve bare muzzle SPL + suppressed SPL.
   * - Bare: cited gun (Bare Muzzle) or manual Starting SPL.
   * - Suppressed: ApplySuppressor only on same-host measured pair
   *   (bare_ref_id / host_key match); else Propagate(ml_dba) on mismatch.
   */
  function resolveSourceLevels() {
    var bareEl = document.getElementById('startingSPL');
    var manualBare = parseOrDefault(bareEl && bareEl.value, 165);
    var gun = selectedBareId !== 'custom' ? findBareById(selectedBareId) : null;
    var bareSPL = gun && gun.muzzle_spl_dB != null ? Number(gun.muzzle_spl_dB) : manualBare;
    var bareSource = gun
      ? ('Cited gun: ' + gun.name + ' (' + gun.muzzle_spl_dB + ' dBA) — ' + (gun.source_note || ''))
      : 'Custom / manual Starting SPL (user override)';

    var sup = selectedSuppressorId ? findSuppressorById(selectedSuppressorId) : null;
    var suppressedSPL = null;
    var suppressedPath = 'No suppressor selected';
    var reduction_dB = null;
    var sourceNote = '';

    if (sup) {
      sourceNote = (sup.source_note || '') + (sup.reduction_note ? ' ' + sup.reduction_note : '');
      // Only ApplySuppressor when selected bare host matches the suppressor measurement host.
      var hostMatch =
        !!gun &&
        ((sup.bare_ref_id && gun.id === sup.bare_ref_id) ||
          (sup.host_key && gun.host_key && gun.host_key === sup.host_key));
      if (
        hostMatch &&
        sup.reduction_dB != null &&
        isFinite(sup.reduction_dB)
      ) {
        reduction_dB = Number(sup.reduction_dB);
        suppressedSPL = Acoustics.ApplySuppressor(bareSPL, reduction_dB);
        suppressedPath =
          'ApplySuppressor(muzzle ' + bareSPL.toFixed(2) + ', reduction ' +
          reduction_dB.toFixed(2) + ') → ' + suppressedSPL.toFixed(2) +
          ' (same-host measured pair; ml_dba=' + Number(sup.ml_dba).toFixed(2) + ')';
      } else if (sup.ml_dba != null && isFinite(sup.ml_dba)) {
        suppressedSPL = Number(sup.ml_dba);
        reduction_dB = bareSPL - suppressedSPL;
        if (hostMatch) {
          suppressedPath =
            'Propagate(ml_dba=' + suppressedSPL.toFixed(2) +
            ') — same host but no baked reduction_dB; using measured ml_dba';
        } else {
          suppressedPath =
            'Propagate(ml_dba=' + suppressedSPL.toFixed(2) +
            ') — host mismatch — using measured ml_dba (not ApplySuppressor with another host reduction)';
        }
      }
    }

    return {
      bareSPL: bareSPL,
      suppressedSPL: suppressedSPL,
      reduction_dB: reduction_dB,
      bareSource: bareSource,
      suppressedPath: suppressedPath,
      sourceNote: sourceNote,
      gun: gun,
      suppressor: sup
    };
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

  function resolveGrid(maxDistance) {
    var domainM = maxDistance * 2;
    var idealCells = Math.max(2, Math.floor(domainM));
    var gridSize = Math.min(idealCells, MAX_CELLS_PER_AXIS);
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
      var srcTag = mapSource === 'suppressed' ? 'map=suppressed' : 'map=bare';
      gridInfo.textContent =
        'Grid: ' + gridSize + '×' + gridSize +
        ' · cell ≈ ' + cellLabel +
        ' · cap ' + MAX_CELLS_PER_AXIS + ' / axis' +
        ' · ' + srcTag +
        ' · map = engineering broadband (not certified Lpeak/LAeq)';
    }

    return { data: grid, size: gridSize };
  }

  function roundRectPath(c, x, y, w, h, r) {
    var radius = Math.min(r, w / 2, h / 2);
    c.beginPath();
    c.moveTo(x + radius, y);
    c.arcTo(x + w, y, x + w, y + h, radius); // top-right
    c.arcTo(x + w, y + h, x, y + h, radius); // bottom-right
    c.arcTo(x, y + h, x, y, radius); // bottom-left (was wrong: x+w,y+h → clipped left)
    c.arcTo(x, y, x + w, y, radius); // top-left
    c.closePath();
  }

  function isoFrac(v0, v1, level) {
    var d = v1 - v0;
    if (Math.abs(d) < 1e-12) return 0.5;
    return (level - v0) / d;
  }

  /**
   * Marching-squares iso-contours on the continuous SPL grid, stroked in canvas pixels.
   * Grid index: data[x * size + y] (same as heatmap).
   */
  function boxesOverlap(a, b, pad) {
    var p = pad == null ? LABEL_PAD : pad;
    return !(
      a.x + a.w + p <= b.x ||
      b.x + b.w + p <= a.x ||
      a.y + a.h + p <= b.y ||
      b.y + b.h + p <= a.y
    );
  }

  function boxCollides(box, occupied, pad) {
    for (var i = 0; i < occupied.length; i++) {
      if (boxesOverlap(box, occupied[i], pad)) return true;
    }
    return false;
  }

  function clampLabelBox(box, side) {
    if (box.x < 2) box.x = 2;
    if (box.y < 2) box.y = 2;
    if (box.x + box.w > side - 2) box.x = Math.max(2, side - 2 - box.w);
    if (box.y + box.h > side - 2) box.y = Math.max(2, side - 2 - box.h);
    return box;
  }

  function drawOpaqueChip(c, box, text, color, font) {
    c.font = font;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    // Near-opaque dark fill (≥90%) + white/high-contrast text; accent border
    c.fillStyle = 'rgba(8, 10, 14, 0.96)';
    c.strokeStyle = color || 'rgba(255,255,255,0.55)';
    c.lineWidth = 2;
    roundRectPath(c, box.x, box.y, box.w, box.h, 4);
    c.fill();
    c.stroke();
    c.fillStyle = '#ffffff';
    c.fillText(text, box.x + box.padX, box.y + box.h / 2);
  }

  /**
   * Marching-squares iso-contours on the continuous SPL grid, stroked in canvas pixels.
   * Grid index: data[x * size + y] (same as heatmap).
   * Labels prefer NE of east (staggered vs SE ring labels); skip if overlap.
   * Contour curves always drawn; chips may be thinned when crowded.
   */
  function drawOshaContours(pack, side, occupied) {
    var data = pack.data;
    var size = pack.size;
    if (!data || size < 2) return;
    if (!occupied) occupied = [];

    var scale = side / size;
    var segmentsByLevel = [];
    var centerG = size * 0.5;
    // Base NE target; per-level angular fan so chips do not stack on one another
    var targetAngBase = OSHA_CHIP_TARGET_ANGLE_RAD;

    for (var li = 0; li < OSHA_LINES.length; li++) {
      var level = OSHA_LINES[li].db;
      var segs = [];

      for (var x = 0; x < size - 1; x++) {
        for (var y = 0; y < size - 1; y++) {
          var v00 = data[x * size + y];
          var v10 = data[(x + 1) * size + y];
          var v11 = data[(x + 1) * size + (y + 1)];
          var v01 = data[x * size + y + 1];

          var b0 = v00 >= level ? 1 : 0;
          var b1 = v10 >= level ? 2 : 0;
          var b2 = v11 >= level ? 4 : 0;
          var b3 = v01 >= level ? 8 : 0;
          var caseId = b0 | b1 | b2 | b3;
          if (caseId === 0 || caseId === 15) continue;

          var tx = x + isoFrac(v00, v10, level);
          var ty = y;
          var rx = x + 1;
          var ry = y + isoFrac(v10, v11, level);
          var bx = x + isoFrac(v01, v11, level);
          var by = y + 1;
          var lx = x;
          var ly = y + isoFrac(v00, v01, level);

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

    var chipFont = '600 10px "Segoe UI", system-ui, sans-serif';

    for (var i = 0; i < OSHA_LINES.length; i++) {
      var line = OSHA_LINES[i];
      var segs2 = segmentsByLevel[i];
      if (!segs2.length) continue;

      ctx.save();
      ctx.strokeStyle = line.color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.beginPath();

      // Fan NE targets: alternate slightly so neighboring level chips clear each other
      var targetAng = targetAngBase + ((i % 3) - 1) * (10 * Math.PI / 180);

      // Collect candidate midpoints with score toward NE target angle (+radial offset)
      var candidates = [];

      for (var s = 0; s < segs2.length; s += 4) {
        var x0 = segs2[s] * scale;
        var y0 = segs2[s + 1] * scale;
        var x1 = segs2[s + 2] * scale;
        var y1 = segs2[s + 3] * scale;
        ctx.moveTo(x0, y0);
        ctx.lineTo(x1, y1);

        var mx = (segs2[s] + segs2[s + 2]) * 0.5;
        var my = (segs2[s + 1] + segs2[s + 3]) * 0.5;
        var dx = mx - centerG;
        var dy = my - centerG;
        var ang = Math.atan2(dy, dx);
        var dang = ang - targetAng;
        while (dang > Math.PI) dang -= 2 * Math.PI;
        while (dang < -Math.PI) dang += 2 * Math.PI;
        // Prefer NE ray; slight preference for east half so chips stay readable
        var score = -Math.abs(dang) * 4 + (dx > 0 ? 0.35 : -0.5);
        candidates.push({ gx: mx, gy: my, score: score });
      }
      ctx.stroke();
      ctx.setLineDash([]);

      candidates.sort(function (a, b) { return b.score - a.score; });

      ctx.font = chipFont;
      var padX = 7;
      var boxH = 17;
      var metrics = ctx.measureText(line.label);
      var boxW = metrics.width + padX * 2;
      var placed = false;
      // Radial nudge options (px along outward normal from center) to clear rings
      var nudges = [0, 10, -10, 18, -18, 28];

      for (var ci = 0; ci < candidates.length && !placed; ci++) {
        // Try top few angle-matched candidates only (thin labels when crowded)
        if (ci > 14) break;
        var cand = candidates[ci];
        var lx = cand.gx * scale;
        var ly = cand.gy * scale;
        var cdx = lx - side * 0.5;
        var cdy = ly - side * 0.5;
        var clen = Math.sqrt(cdx * cdx + cdy * cdy) || 1;
        var ux = cdx / clen;
        var uy = cdy / clen;

        for (var ni = 0; ni < nudges.length; ni++) {
          var nx = lx + ux * nudges[ni];
          var ny = ly + uy * nudges[ni];
          // Alternate left/right of contour tangent-ish: place chip outside curve
          var boxX = nx + 4;
          var boxY = ny - boxH / 2;
          // Prefer chip sitting "above" the contour point on NE (negative y bias)
          if (OSHA_CHIP_TARGET_ANGLE_RAD < 0) boxY = ny - boxH - 2;

          var box = clampLabelBox({
            x: boxX, y: boxY, w: boxW, h: boxH, padX: padX
          }, side);
          // Also try mirrored horizontal if edge-clamped
          if (boxCollides(box, occupied, LABEL_PAD)) {
            box = clampLabelBox({
              x: nx - boxW - 4, y: boxY, w: boxW, h: boxH, padX: padX
            }, side);
          }
          if (boxCollides(box, occupied, LABEL_PAD)) continue;

          drawOpaqueChip(ctx, box, line.label, line.color, chipFont);
          occupied.push({ x: box.x, y: box.y, w: box.w, h: box.h });
          placed = true;
          break;
        }
      }
      // If nothing fits, skip chip (curve remains) — readability > completeness
      ctx.restore();
    }

    // Contour note: 140 dB peak is impulsive criterion — not drawn on continuous field
    ctx.save();
    ctx.font = '600 10px "Segoe UI", system-ui, sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'bottom';
    var note = '140 dB peak (OSHA impulse) → table (peak-style), not continuous contour';
    var noteX = side - 8;
    var noteY = side - 8;
    var nw = ctx.measureText(note).width + 10;
    var nh = 16;
    var noteBox = { x: noteX - nw, y: noteY - nh, w: nw, h: nh };
    ctx.fillStyle = 'rgba(8, 10, 14, 0.9)';
    roundRectPath(ctx, noteBox.x, noteBox.y, noteBox.w, noteBox.h, 3);
    ctx.fill();
    ctx.fillStyle = 'rgba(255, 143, 163, 0.95)';
    ctx.fillText(note, noteX - 5, noteY - 3);
    occupied.push(noteBox);
    ctx.restore();
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

    // Distance rings — curves full circle; labels on SE ray (stagger vs OSHA NE chips)
    var centerPx = side / 2;
    var pxPerM = side / (maxDistance * 2);
    var occupied = [];
    var ringAng = RING_LABEL_ANGLE_RAD;
    var cosR = Math.cos(ringAng);
    var sinR = Math.sin(ringAng);

    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth = 1;
    ctx.font = '600 11px "Segoe UI", system-ui, sans-serif';

    var ringStepM;
    var ringLabel;
    if (units === 'metric') {
      ringStepM = 50;
      ringLabel = function (m) { return m + ' m'; };
    } else {
      ringStepM = 100 * M_PER_FT; // every 100 ft
      ringLabel = function (m) { return Math.round(m / M_PER_FT) + ' ft'; };
    }

    // Estimate label stride: thin every-other ring when canvas is cramped
    var maxLabeledR = side * 0.55;
    var approxCount = 0;
    for (var d0 = ringStepM; d0 <= maxDistance * 2; d0 += ringStepM) {
      if (d0 * pxPerM <= maxLabeledR) approxCount++;
    }
    var labelStride = approxCount > 8 ? 2 : 1;
    var ringIndex = 0;

    for (var dist = ringStepM; dist <= maxDistance * 2; dist += ringStepM) {
      var radiusPx = dist * pxPerM;
      ctx.beginPath();
      ctx.arc(centerPx, centerPx, radiusPx, 0, Math.PI * 2);
      ctx.stroke();

      if (radiusPx > maxLabeledR) continue;
      ringIndex++;
      if ((ringIndex - 1) % labelStride !== 0) continue;

      var txt = ringLabel(dist);
      var padX = 6;
      var boxH = 16;
      var tw = ctx.measureText(txt).width;
      var boxW = tw + padX * 2;
      // Anchor just outside the ring along SE ray
      var ax = centerPx + (radiusPx + 8) * cosR;
      var ay = centerPx + (radiusPx + 8) * sinR;
      var box = clampLabelBox({
        x: ax - boxW * 0.15,
        y: ay - boxH / 2,
        w: boxW,
        h: boxH,
        padX: padX
      }, side);

      if (boxCollides(box, occupied, LABEL_PAD)) {
        // Try slight radial outward nudge, then skip label (keep curve)
        box = clampLabelBox({
          x: ax + 10 * cosR - boxW * 0.15,
          y: ay + 10 * sinR - boxH / 2,
          w: boxW,
          h: boxH,
          padX: padX
        }, side);
        if (boxCollides(box, occupied, LABEL_PAD)) continue;
      }

      drawOpaqueChip(ctx, box, txt, 'rgba(255,255,255,0.55)', '600 11px "Segoe UI", system-ui, sans-serif');
      occupied.push({ x: box.x, y: box.y, w: box.w, h: box.h });
    }

    // OSHA iso-contours follow the continuous SPL field (wind may distort circles)
    drawOshaContours(pack, side, occupied);

    // Source marker
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.arc(centerPx, centerPx, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  function updateCompareSummary(levels) {
    var bareEl = document.getElementById('cmpBareSpl');
    var suppEl = document.getElementById('cmpSuppSpl');
    var deltaEl = document.getElementById('cmpDelta');
    var noteEl = document.getElementById('cmpPathNote');
    if (!bareEl) return;

    bareEl.textContent = formatDb(levels.bareSPL);
    suppEl.textContent = levels.suppressedSPL == null ? '— (pick suppressor)' : formatDb(levels.suppressedSPL);
    if (levels.suppressedSPL != null && isFinite(levels.bareSPL)) {
      var d = levels.bareSPL - levels.suppressedSPL;
      deltaEl.textContent = d.toFixed(1) + ' dB' +
        (levels.suppressedPath && levels.suppressedPath.indexOf('same-host measured pair') >= 0 ? ' (same-host ApplySuppressor)' : (levels.suppressedPath && levels.suppressedPath.indexOf('host mismatch') >= 0 ? ' (host mismatch — ml_dba)' : ' (runtime Δ / ml_dba)'));
    } else {
      deltaEl.textContent = '—';
    }
    if (noteEl) {
      noteEl.innerHTML =
        '<strong>Bare:</strong> ' + levels.bareSource +
        '<br><strong>Suppressed path:</strong> ' + levels.suppressedPath +
        (levels.sourceNote ? '<br><span class="hint">' + levels.sourceNote + '</span>' : '');
    }
  }

  function envFromForm() {
    var maxDistRaw = parseOrDefault(document.getElementById('maxDistance').value, units === 'metric' ? 1000 : 3281);
    var tempRaw = parseOrDefault(document.getElementById('tempC').value, units === 'metric' ? 20 : 68);
    var humidityPct = parseOrDefault(document.getElementById('humidity').value, 50);
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
      maxDistance_m: maxDistance_m,
      tempC: tempC,
      humidityPct: humidityPct,
      terrain: terrain,
      windSpeed_mps: windSpeed_mps,
      windDirRad: windDirDeg * Math.PI / 180.0
    };
  }

  function readInputsAsSI() {
    var levels = resolveSourceLevels();
    var env = envFromForm();
    var mapSPL = mapSource === 'suppressed' && levels.suppressedSPL != null
      ? levels.suppressedSPL
      : levels.bareSPL;

    // If user asked for suppressed map but no suppressor, fall back to bare
    if (mapSource === 'suppressed' && levels.suppressedSPL == null) {
      mapSPL = levels.bareSPL;
    }

    return {
      startingSPL: mapSPL,
      bareSPL: levels.bareSPL,
      suppressedSPL: levels.suppressedSPL,
      reduction_dB: levels.reduction_dB,
      levels: levels,
      maxDistance_m: env.maxDistance_m,
      tempC: env.tempC,
      humidityPct: env.humidityPct,
      terrain: env.terrain,
      windSpeed_mps: env.windSpeed_mps,
      windDirRad: env.windDirRad
    };
  }

  function searchDistance(targetDb, rayAngleRad, muzzleSPL, env, usePeak) {
    if (muzzleSPL == null || !isFinite(muzzleSPL)) {
      return null;
    }
    if (!usePeak) {
      return Acoustics.DistanceToLevel(
        targetDb,
        env.maxDistance_m,
        muzzleSPL,
        env.tempC,
        env.humidityPct,
        env.terrain,
        false,
        env.windSpeed_mps,
        env.windDirRad,
        rayAngleRad
      );
    }

    var dMin = 1.0;
    var dMax = Math.max(dMin, env.maxDistance_m);

    function peakAt(d) {
      return Acoustics.PropagateWithPeak(
        muzzleSPL, d, env.tempC, env.humidityPct, env.terrain,
        false, env.windSpeed_mps, env.windDirRad, rayAngleRad
      ).peak;
    }

    if (peakAt(dMin) < targetDb) {
      return { distance_m: dMin, status: 'below_near' };
    }
    if (peakAt(dMax) >= targetDb) {
      return { distance_m: dMax, status: 'outside_map' };
    }

    var lo = dMin;
    var hi = dMax;
    for (var i = 0; i < 48; i++) {
      var mid = 0.5 * (lo + hi);
      if (peakAt(mid) >= targetDb) lo = mid;
      else hi = mid;
    }
    return { distance_m: 0.5 * (lo + hi), status: 'ok' };
  }

  /** Live distance-to-OSHA table: one source at a time (Bare | Suppressed tabs). */
  function updateOshaDistanceTable(inp) {
    if (!oshaDistanceBody || !inp) return;

    updateCompareSummary(inp.levels || resolveSourceLevels());

    var windDir = inp.windDirRad;
    var rays = {
      down: windDir,
      up: windDir + Math.PI,
      cross: windDir + Math.PI / 2
    };

    var env = {
      maxDistance_m: inp.maxDistance_m,
      tempC: inp.tempC,
      humidityPct: inp.humidityPct,
      terrain: inp.terrain,
      windSpeed_mps: inp.windSpeed_mps,
      windDirRad: inp.windDirRad
    };

    var sourceSPL = oshaView === 'suppressed' ? inp.suppressedSPL : inp.bareSPL;
    var rows = OSHA_LINES.concat([OSHA_PEAK_LINE]);
    var html = '';

    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var usePeak = !!row.peakSearch;
      var dDown = searchDistance(row.db, rays.down, sourceSPL, env, usePeak);
      var dUp = searchDistance(row.db, rays.up, sourceSPL, env, usePeak);
      var dCross = searchDistance(row.db, rays.cross, sourceSPL, env, usePeak);
      var rowClass = usePeak ? ' class="is-peak-row"' : '';
      html +=
        '<tr' + rowClass + '>' +
        '<td>' + row.label + '</td>' +
        '<td>' + formatDistCell(dDown) + '</td>' +
        '<td>' + formatDistCell(dUp) + '</td>' +
        '<td>' + formatDistCell(dCross) + '</td>' +
        '</tr>';
    }

    oshaDistanceBody.innerHTML = html;
  }

  function setOshaView(mode) {
    oshaView = mode === 'suppressed' ? 'suppressed' : 'bare';
    var btnB = document.getElementById('btnOshaBare');
    var btnS = document.getElementById('btnOshaSuppressed');
    if (btnB) {
      btnB.classList.toggle('is-active', oshaView === 'bare');
      btnB.setAttribute('aria-pressed', oshaView === 'bare' ? 'true' : 'false');
    }
    if (btnS) {
      btnS.classList.toggle('is-active', oshaView === 'suppressed');
      btnS.setAttribute('aria-pressed', oshaView === 'suppressed' ? 'true' : 'false');
    }
    if (lastInputs) updateOshaDistanceTable(lastInputs);
    else scheduleDistanceTableUpdate();
  }

  function scheduleDistanceTableUpdate() {
    if (distanceUpdateTimer) clearTimeout(distanceUpdateTimer);
    distanceUpdateTimer = setTimeout(function () {
      distanceUpdateTimer = null;
      var inp = readInputsAsSI();
      lastInputs = inp;
      updateOshaDistanceTable(inp);
    }, 120);
  }

  /* ——— Phase 4: A/B localStorage scenarios + CSV export ——— */

  function loadAbFromStorage() {
    abSlots = { A: null, B: null };
    try {
      var raw = localStorage.getItem(AB_STORAGE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        abSlots.A = parsed.A || null;
        abSlots.B = parsed.B || null;
      }
    } catch (err) {
      abSlots = { A: null, B: null };
    }
  }

  function persistAbSlots() {
    try {
      localStorage.setItem(AB_STORAGE_KEY, JSON.stringify(abSlots));
    } catch (err) {
      /* quota / private mode — ignore */
    }
  }

  function snapshotScenario(nameHint) {
    var levels = resolveSourceLevels();
    var env = envFromForm();
    var windDeg = parseOrDefault(document.getElementById('windDir').value, 0);
    var sup = selectedSuppressorId ? findSuppressorById(selectedSuppressorId) : null;
    var bare = selectedBareId !== 'custom' ? findBareById(selectedBareId) : null;
    var label =
      (mapSource === 'suppressed' ? 'Suppressed' : 'Bare') +
      (sup ? ' · ' + (sup.manufacturer || '') + ' ' + (sup.model || '') : '') +
      ' · wind ' + (units === 'metric'
        ? env.windSpeed_mps.toFixed(1) + ' m/s'
        : (env.windSpeed_mps / MPS_PER_MPH).toFixed(1) + ' mph') +
      '@' + Math.round(windDeg) + '°';

    return {
      savedAt: new Date().toISOString(),
      name: nameHint || label,
      units: units,
      mapSource: mapSource,
      selectedBareId: selectedBareId,
      selectedSuppressorId: selectedSuppressorId,
      form: {
        startingSPL: document.getElementById('startingSPL').value,
        maxDistance: document.getElementById('maxDistance').value,
        tempC: document.getElementById('tempC').value,
        humidity: document.getElementById('humidity').value,
        terrain: document.getElementById('terrain').value,
        windSpeed: document.getElementById('windSpeed').value,
        windDir: document.getElementById('windDir').value,
        caliberFilter: (document.getElementById('caliberFilter') || {}).value || '',
        suppressorSearch: (document.getElementById('suppressorSearch') || {}).value || ''
      },
      levels: {
        bareSPL: levels.bareSPL,
        suppressedSPL: levels.suppressedSPL,
        bareSource: levels.bareSource,
        suppressedPath: levels.suppressedPath,
        reduction_dB: levels.reduction_dB
      },
      env: {
        maxDistance_m: env.maxDistance_m,
        tempC: env.tempC,
        humidityPct: env.humidityPct,
        terrain: env.terrain,
        windSpeed_mps: env.windSpeed_mps,
        windDirRad: env.windDirRad,
        windDirDeg: windDeg
      },
      bareName: bare ? bare.name : 'Custom / manual',
      suppressorName: sup
        ? ((sup.manufacturer || '') + ' ' + (sup.model || '')).trim()
        : null
    };
  }

  function formatAbSlotSummary(slot) {
    if (!slot) return 'empty';
    var bare = slot.levels && slot.levels.bareSPL != null
      ? Number(slot.levels.bareSPL).toFixed(1) + ' dB'
      : '—';
    var supp = slot.levels && slot.levels.suppressedSPL != null
      ? Number(slot.levels.suppressedSPL).toFixed(1) + ' dB'
      : '—';
    var wind = slot.env
      ? (slot.units === 'imperial'
          ? (slot.env.windSpeed_mps / MPS_PER_MPH).toFixed(1) + ' mph'
          : slot.env.windSpeed_mps.toFixed(1) + ' m/s') +
        ' @ ' + Math.round(slot.env.windDirDeg || 0) + '°'
      : '—';
    return (
      '<strong>' + (slot.mapSource || '?') + '</strong> · bare ' + bare +
      ' · supp ' + supp + '<br>wind ' + wind +
      (slot.suppressorName ? '<br>' + slot.suppressorName : '')
    );
  }

  function refreshAbUi() {
    var elA = document.getElementById('abSlotA');
    var elB = document.getElementById('abSlotB');
    if (elA) {
      elA.innerHTML = formatAbSlotSummary(abSlots.A);
      elA.classList.toggle('is-filled', !!abSlots.A);
    }
    if (elB) {
      elB.innerHTML = formatAbSlotSummary(abSlots.B);
      elB.classList.toggle('is-filled', !!abSlots.B);
    }
  }

  function saveScenarioSlot(which) {
    var snap = snapshotScenario(which);
    abSlots[which] = snap;
    persistAbSlots();
    refreshAbUi();
  }

  function applyScenarioSlot(which) {
    var snap = abSlots[which];
    if (!snap || !snap.form) return;

    // Units first so displayed values match the snapshot's unit system
    if (snap.units && snap.units !== units) {
      // setUnits converts current values — set raw after instead
      units = snap.units;
      updateUnitLabels();
      var btnM = document.getElementById('btnMetric');
      var btnI = document.getElementById('btnImperial');
      if (btnM && btnI) {
        btnM.classList.toggle('is-active', units === 'metric');
        btnI.classList.toggle('is-active', units === 'imperial');
        btnM.setAttribute('aria-pressed', units === 'metric' ? 'true' : 'false');
        btnI.setAttribute('aria-pressed', units === 'imperial' ? 'true' : 'false');
      }
    }

    var f = snap.form;
    function setVal(id, v) {
      var el = document.getElementById(id);
      if (el && v != null) el.value = v;
    }
    setVal('startingSPL', f.startingSPL);
    setVal('maxDistance', f.maxDistance);
    setVal('tempC', f.tempC);
    setVal('humidity', f.humidity);
    setVal('terrain', f.terrain);
    setVal('windSpeed', f.windSpeed);
    setVal('windDir', f.windDir);
    setVal('caliberFilter', f.caliberFilter);
    setVal('suppressorSearch', f.suppressorSearch);

    selectedBareId = snap.selectedBareId || 'custom';
    selectedSuppressorId = snap.selectedSuppressorId || null;

    var pref = null;
    var sup = selectedSuppressorId ? findSuppressorById(selectedSuppressorId) : null;
    if (sup) pref = sup.host_key;
    populateBareHosts(pref);
    var bareSel = document.getElementById('bareHost');
    if (bareSel) bareSel.value = selectedBareId;
    applyBareSelection(false);
    // Restore exact Starting SPL from snapshot (applyBareSelection may overwrite cited guns)
    setVal('startingSPL', f.startingSPL);
    if (selectedBareId === 'custom') {
      var splEl = document.getElementById('startingSPL');
      if (splEl) {
        splEl.readOnly = false;
        splEl.title = 'Custom / manual Starting SPL override';
      }
    }
    renderSuppressorList();

    // Map source without auto-generate (we'll generate once)
    mapSource = snap.mapSource === 'suppressed' ? 'suppressed' : 'bare';
    var btnB = document.getElementById('btnMapBare');
    var btnS = document.getElementById('btnMapSuppressed');
    if (btnB && btnS) {
      btnB.classList.toggle('is-active', mapSource === 'bare');
      btnS.classList.toggle('is-active', mapSource === 'suppressed');
      btnB.setAttribute('aria-pressed', mapSource === 'bare' ? 'true' : 'false');
      btnS.setAttribute('aria-pressed', mapSource === 'suppressed' ? 'true' : 'false');
    }

    refreshAbUi();
    generateNoiseMap();
  }

  function clearAbSlots() {
    abSlots = { A: null, B: null };
    persistAbSlots();
    refreshAbUi();
  }

  function csvEscape(val) {
    var s = val == null ? '' : String(val);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function distCsvCell(result) {
    if (!result) return { m: '', status: 'n/a', display: '' };
    if (result.status === 'outside_map') {
      return { m: '', status: 'beyond_max', display: 'beyond max distance' };
    }
    if (result.status === 'below_near') {
      return {
        m: result.distance_m != null ? Number(result.distance_m).toFixed(3) : '',
        status: 'below_near',
        display: formatDist(result.distance_m)
      };
    }
    return {
      m: result.distance_m != null ? Number(result.distance_m).toFixed(3) : '',
      status: result.status || 'ok',
      display: formatDist(result.distance_m)
    };
  }

  function collectOshaRowsForScenario(tag, bareSPL, suppressedSPL, env) {
    var windDir = env.windDirRad;
    var rays = {
      down: windDir,
      up: windDir + Math.PI,
      cross: windDir + Math.PI / 2
    };
    var rows = OSHA_LINES.concat([OSHA_PEAK_LINE]);
    var out = [];
    var rayNames = ['down', 'up', 'cross'];
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var usePeak = !!row.peakSearch;
      for (var ri = 0; ri < rayNames.length; ri++) {
        var rn = rayNames[ri];
        var b = searchDistance(row.db, rays[rn], bareSPL, env, usePeak);
        var s = searchDistance(row.db, rays[rn], suppressedSPL, env, usePeak);
        var bc = distCsvCell(b);
        var sc = distCsvCell(s);
        out.push({
          scenario: tag,
          kind: 'osha',
          level_db: row.db,
          level_label: row.label,
          peak_search: usePeak ? 'yes' : 'no',
          ray: rn,
          series: 'bare',
          distance_m: bc.m,
          distance_display: bc.display,
          status: bc.status
        });
        out.push({
          scenario: tag,
          kind: 'osha',
          level_db: row.db,
          level_label: row.label,
          peak_search: usePeak ? 'yes' : 'no',
          ray: rn,
          series: 'suppressed',
          distance_m: sc.m,
          distance_display: sc.display,
          status: sc.status
        });
      }
    }
    return out;
  }

  function collectRadialRowsForScenario(tag, bareSPL, suppressedSPL, env) {
    var ringStepM = 50;
    var windDir = env.windDirRad;
    var rays = {
      down: windDir,
      up: windDir + Math.PI,
      cross: windDir + Math.PI / 2
    };
    var out = [];
    var rayNames = ['down', 'up', 'cross'];
    for (var dist = ringStepM; dist <= env.maxDistance_m; dist += ringStepM) {
      for (var ri = 0; ri < rayNames.length; ri++) {
        var rn = rayNames[ri];
        var ang = rays[rn];
        function splAt(muzzle) {
          if (muzzle == null || !isFinite(muzzle)) return null;
          return Acoustics.Propagate(
            muzzle, dist, env.tempC, env.humidityPct, env.terrain,
            false, env.windSpeed_mps, env.windDirRad, ang
          );
        }
        var bareSpl = splAt(bareSPL);
        var suppSpl = splAt(suppressedSPL);
        out.push({
          scenario: tag,
          kind: 'radial',
          level_db: '',
          level_label: 'ring',
          peak_search: 'no',
          ray: rn,
          series: 'bare',
          distance_m: dist.toFixed(3),
          distance_display: formatDist(dist),
          status: bareSpl == null ? 'n/a' : ('spl_db=' + bareSpl.toFixed(2))
        });
        out.push({
          scenario: tag,
          kind: 'radial',
          level_db: '',
          level_label: 'ring',
          peak_search: 'no',
          ray: rn,
          series: 'suppressed',
          distance_m: dist.toFixed(3),
          distance_display: formatDist(dist),
          status: suppSpl == null ? 'n/a' : ('spl_db=' + suppSpl.toFixed(2))
        });
      }
    }
    return out;
  }

  function scenarioEnvFromSnap(snap) {
    if (!snap || !snap.env) return null;
    return {
      maxDistance_m: snap.env.maxDistance_m,
      tempC: snap.env.tempC,
      humidityPct: snap.env.humidityPct,
      terrain: snap.env.terrain,
      windSpeed_mps: snap.env.windSpeed_mps,
      windDirRad: snap.env.windDirRad
    };
  }

  function buildExportRows() {
    var rows = [];
    var inp = readInputsAsSI();
    var env = {
      maxDistance_m: inp.maxDistance_m,
      tempC: inp.tempC,
      humidityPct: inp.humidityPct,
      terrain: inp.terrain,
      windSpeed_mps: inp.windSpeed_mps,
      windDirRad: inp.windDirRad
    };
    rows = rows.concat(
      collectOshaRowsForScenario('active', inp.bareSPL, inp.suppressedSPL, env)
    );
    rows = rows.concat(
      collectRadialRowsForScenario('active', inp.bareSPL, inp.suppressedSPL, env)
    );

    ['A', 'B'].forEach(function (key) {
      var snap = abSlots[key];
      if (!snap) return;
      var e = scenarioEnvFromSnap(snap);
      if (!e) return;
      var bare = snap.levels ? snap.levels.bareSPL : null;
      var supp = snap.levels ? snap.levels.suppressedSPL : null;
      var tag = 'slot_' + key;
      rows = rows.concat(collectOshaRowsForScenario(tag, bare, supp, e));
      rows = rows.concat(collectRadialRowsForScenario(tag, bare, supp, e));
    });
    return rows;
  }

  function exportDistancesCsv() {
    var rows = buildExportRows();
    var header = [
      'scenario', 'kind', 'level_db', 'level_label', 'peak_search',
      'ray', 'series', 'distance_m', 'distance_display', 'status'
    ];
    var lines = [header.join(',')];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      lines.push([
        csvEscape(r.scenario),
        csvEscape(r.kind),
        csvEscape(r.level_db),
        csvEscape(r.level_label),
        csvEscape(r.peak_search),
        csvEscape(r.ray),
        csvEscape(r.series),
        csvEscape(r.distance_m),
        csvEscape(r.distance_display),
        csvEscape(r.status)
      ].join(','));
    }
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    var stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = 'gsp-osha-radial-' + stamp + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
    var note = document.getElementById('exportNote');
    if (note) {
      var nScen = 1 + (abSlots.A ? 1 : 0) + (abSlots.B ? 1 : 0);
      note.textContent =
        'Exported ' + rows.length + ' rows (' + nScen +
        ' scenario' + (nScen > 1 ? 's' : '') +
        ': active' + (abSlots.A ? '+A' : '') + (abSlots.B ? '+B' : '') + ').';
    }
  }

  function wirePhase4Ui() {
    loadAbFromStorage();
    refreshAbUi();
    var map = [
      ['btnSaveA', function () { saveScenarioSlot('A'); }],
      ['btnSaveB', function () { saveScenarioSlot('B'); }],
      ['btnLoadA', function () { applyScenarioSlot('A'); }],
      ['btnLoadB', function () { applyScenarioSlot('B'); }],
      ['btnClearAB', clearAbSlots],
      ['btnExportCsv', exportDistancesCsv]
    ];
    for (var i = 0; i < map.length; i++) {
      var el = document.getElementById(map[i][0]);
      if (el) el.addEventListener('click', map[i][1]);
    }
  }

  function blankReadout() {
    cursorReadout.textContent =
      'Continuous: --- dB · Peak≈: --- dB · Dist: --- ' + distUnit() +
      ' · map=' + mapSource;
  }

  function generateNoiseMap() {
    var inp = readInputsAsSI();
    lastInputs = inp;

    var btn = document.getElementById('btnGenerate');
    btn.disabled = true;
    btn.textContent = 'Computing…';

    setTimeout(function () {
      lastGrid = generateGrid(
        inp.startingSPL, inp.tempC, inp.humidityPct, inp.terrain,
        inp.windSpeed_mps, inp.windDirRad, inp.maxDistance_m
      );
      renderGrid(lastGrid, inp.maxDistance_m);
      updateOshaDistanceTable(inp);
      btn.disabled = false;
      btn.textContent = 'Generate Noise Map';
      blankReadout();
    }, 20);
  }

  function onCanvasMove(e) {
    if (!lastGrid || !lastInputs) return;
    var rect = canvas.getBoundingClientRect();
    var clientX = e.touches ? e.touches[0].clientX : e.clientX;
    var clientY = e.touches ? e.touches[0].clientY : e.clientY;
    var px = clientX - rect.left;
    var py = clientY - rect.top;

    var size = lastGrid.size;
    var dispW = rect.width || canvas.width;
    var dispH = rect.height || canvas.height;
    var x = Math.floor(px / dispW * size);
    var y = Math.floor(py / dispH * size);

    if (x < 0 || y < 0 || x >= size || y >= size) {
      blankReadout();
      return;
    }

    var continuous = lastGrid.data[x * size + y];
    var center = size / 2;
    var dx = (x - center) * cellSize_m;
    var dy = (y - center) * cellSize_m;
    var dist_m = Math.sqrt(dx * dx + dy * dy);
    var distForProp = dist_m < 1.0 ? 1.0 : dist_m;
    var angleRad = Math.atan2(dy, dx);

    var peak = Acoustics.PropagateWithPeak(
      lastInputs.startingSPL,
      distForProp,
      lastInputs.tempC,
      lastInputs.humidityPct,
      lastInputs.terrain,
      false,
      lastInputs.windSpeed_mps,
      lastInputs.windDirRad,
      angleRad
    ).peak;

    cursorReadout.textContent =
      'Continuous: ' + continuous.toFixed(1) + ' dB · Peak≈: ' +
      peak.toFixed(1) + ' dB · Dist: ' + formatDist(dist_m) +
      ' · map=' + mapSource;
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

    if (lastGrid) {
      renderGrid(lastGrid, lastMaxDistance);
      if (gridInfo) {
        var cellLabel = units === 'metric'
          ? cellSize_m.toFixed(2) + ' m'
          : (cellSize_m / M_PER_FT).toFixed(2) + ' ft';
        gridInfo.textContent =
          'Grid: ' + lastGrid.size + '×' + lastGrid.size +
          ' · cell ≈ ' + cellLabel +
          ' · cap ' + MAX_CELLS_PER_AXIS + ' / axis' +
          ' · map=' + mapSource +
          ' · map = engineering broadband (not certified Lpeak/LAeq)';
      }
      blankReadout();
    }

    var inp = readInputsAsSI();
    lastInputs = inp;
    updateOshaDistanceTable(inp);
  }

  function setMapSource(next) {
    if (next !== 'bare' && next !== 'suppressed') return;
    mapSource = next;
    var btnB = document.getElementById('btnMapBare');
    var btnS = document.getElementById('btnMapSuppressed');
    if (btnB && btnS) {
      btnB.classList.toggle('is-active', mapSource === 'bare');
      btnS.classList.toggle('is-active', mapSource === 'suppressed');
      btnB.setAttribute('aria-pressed', mapSource === 'bare' ? 'true' : 'false');
      btnS.setAttribute('aria-pressed', mapSource === 'suppressed' ? 'true' : 'false');
    }
    // Regenerate map for the other series
    generateNoiseMap();
  }

  function populateCalibers() {
    var sel = document.getElementById('caliberFilter');
    if (!sel) return;
    sel.innerHTML = '';
    var optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'All calibers / hosts (' + suppressors.length + ')';
    sel.appendChild(optAll);
    for (var i = 0; i < caliberList.length; i++) {
      var opt = document.createElement('option');
      opt.value = caliberList[i];
      opt.textContent = caliberList[i];
      sel.appendChild(opt);
    }
  }

  function populateBareHosts(preferredHostKey) {
    var sel = document.getElementById('bareHost');
    if (!sel) return;
    var prev = selectedBareId;
    sel.innerHTML = '';
    var optCustom = document.createElement('option');
    optCustom.value = 'custom';
    optCustom.textContent = 'Custom / manual Starting SPL';
    sel.appendChild(optCustom);

    var matching = [];
    var others = [];
    for (var i = 0; i < hostBare.length; i++) {
      var h = hostBare[i];
      if (preferredHostKey && h.host_key === preferredHostKey) matching.push(h);
      else others.push(h);
    }
    var ordered = matching.concat(others);
    for (var j = 0; j < ordered.length; j++) {
      var g = ordered[j];
      var opt = document.createElement('option');
      opt.value = g.id;
      opt.textContent =
        g.muzzle_spl_dB.toFixed(1) + ' dB — ' + g.name + ' · ' + g.caliber;
      sel.appendChild(opt);
    }

    if (prev && (prev === 'custom' || findBareById(prev))) {
      sel.value = prev;
      selectedBareId = prev;
    } else {
      sel.value = 'custom';
      selectedBareId = 'custom';
    }
  }

  function renderSuppressorList() {
    var list = document.getElementById('suppressorList');
    var countEl = document.getElementById('suppressorCount');
    var calSel = document.getElementById('caliberFilter');
    var searchEl = document.getElementById('suppressorSearch');
    if (!list) return;

    var cal = calSel ? calSel.value : '';
    var q = (searchEl && searchEl.value ? searchEl.value : '').trim().toLowerCase();

    var items = [];
    for (var i = 0; i < suppressors.length; i++) {
      var s = suppressors[i];
      if (cal && s.caliber !== cal) continue;
      if (q) {
        var hay = (s.manufacturer + ' ' + s.model + ' ' + s.display_name + ' ' + s.caliber).toLowerCase();
        if (hay.indexOf(q) === -1) continue;
      }
      items.push(s);
    }

    // Cap DOM nodes for usability (~1600 rows) — show first 400 matches + note
    var CAP = 400;
    var shown = items.slice(0, CAP);
    if (countEl) {
      countEl.textContent = items.length > CAP
        ? '(' + items.length + ' match, showing ' + CAP + ' — refine search)'
        : '(' + items.length + ')';
    }

    var html = '';
    for (var j = 0; j < shown.length; j++) {
      var row = shown[j];
      var sel = row.id === selectedSuppressorId ? ' is-selected' : '';
      var red = row.reduction_dB != null
        ? ' · −' + Number(row.reduction_dB).toFixed(1) + ' dB'
        : '';
      html +=
        '<li role="option" tabindex="0" class="' + sel.trim() +
        '" data-id="' + row.id + '" aria-selected="' +
        (row.id === selectedSuppressorId ? 'true' : 'false') + '">' +
        '<span class="spl-tag">' + Number(row.ml_dba).toFixed(1) + '</span> ' +
        row.manufacturer + ' ' + row.model + red +
        '<br><span class="hint">' + row.caliber + '</span></li>';
    }
    if (!shown.length) {
      html = '<li class="hint" style="cursor:default">No suppressors match.</li>';
    }
    list.innerHTML = html;
  }

  function onSuppressorPick(id) {
    selectedSuppressorId = id;
    var sup = findSuppressorById(id);
    renderSuppressorList();

    var note = document.getElementById('suppressorPickNote');
    if (note && sup) {
      note.textContent =
        (sup.display_name || (sup.manufacturer + ' ' + sup.model)) +
        ' · ml_dba=' + Number(sup.ml_dba).toFixed(2) +
        (sup.reduction_dB != null
          ? ' · baked reduction ' + Number(sup.reduction_dB).toFixed(2) +
            ' dB vs ' + (sup.bare_ref_name || 'bare_ref')
          : ' · no baked bare_ref (uses ml_dba)') +
        ' — ' + (sup.source_note || '');
    }

    // Suggest matching cited gun when suppressor has bare_ref
    if (sup) {
      populateBareHosts(sup.host_key);
      if (sup.bare_ref_id && findBareById(sup.bare_ref_id)) {
        var bareSel = document.getElementById('bareHost');
        if (bareSel) {
          bareSel.value = sup.bare_ref_id;
          selectedBareId = sup.bare_ref_id;
          applyBareSelection(false);
        }
      }
    }

    scheduleDistanceTableUpdate();
  }

  function applyBareSelection(updateFromGun) {
    var gun = selectedBareId !== 'custom' ? findBareById(selectedBareId) : null;
    var splEl = document.getElementById('startingSPL');
    if (gun && splEl && updateFromGun !== false) {
      splEl.value = Number(gun.muzzle_spl_dB).toFixed(1);
      splEl.readOnly = true;
      splEl.title = gun.source_note || 'Cited Bare Muzzle measurement';
    } else if (splEl) {
      splEl.readOnly = false;
      splEl.title = 'Custom / manual Starting SPL override';
    }
    scheduleDistanceTableUpdate();
  }

  function wireProfilesUi() {
    populateCalibers();
    populateBareHosts(null);
    renderSuppressorList();

    var calSel = document.getElementById('caliberFilter');
    var searchEl = document.getElementById('suppressorSearch');
    var list = document.getElementById('suppressorList');
    var bareSel = document.getElementById('bareHost');

    if (calSel) {
      calSel.addEventListener('change', function () {
        var cal = calSel.value;
        var pref = cal ? hostKey(cal) : null;
        populateBareHosts(pref);
        renderSuppressorList();
      });
    }
    if (searchEl) {
      searchEl.addEventListener('input', function () {
        if (listFilterTimer) clearTimeout(listFilterTimer);
        listFilterTimer = setTimeout(renderSuppressorList, 80);
      });
    }
    if (list) {
      list.addEventListener('click', function (e) {
        var li = e.target.closest('li[data-id]');
        if (!li) return;
        onSuppressorPick(li.getAttribute('data-id'));
      });
      list.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        var li = e.target.closest('li[data-id]');
        if (!li) return;
        e.preventDefault();
        onSuppressorPick(li.getAttribute('data-id'));
      });
    }
    if (bareSel) {
      bareSel.addEventListener('change', function () {
        selectedBareId = bareSel.value || 'custom';
        applyBareSelection(true);
      });
    }

    var btnMapBare = document.getElementById('btnMapBare');
    var btnMapSupp = document.getElementById('btnMapSuppressed');
    if (btnMapBare) btnMapBare.addEventListener('click', function () { setMapSource('bare'); });
    if (btnMapSupp) btnMapSupp.addEventListener('click', function () { setMapSource('suppressed'); });

    var btnOshaBare = document.getElementById('btnOshaBare');
    var btnOshaSupp = document.getElementById('btnOshaSuppressed');
    if (btnOshaBare) btnOshaBare.addEventListener('click', function () { setOshaView('bare'); });
    if (btnOshaSupp) btnOshaSupp.addEventListener('click', function () { setOshaView('suppressed'); });
  }

  document.getElementById('btnGenerate').addEventListener('click', generateNoiseMap);
  document.getElementById('btnMetric').addEventListener('click', function () { setUnits('metric'); });
  document.getElementById('btnImperial').addEventListener('click', function () { setUnits('imperial'); });
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('touchmove', function (e) {
    e.preventDefault();
    onCanvasMove(e);
  }, { passive: false });

  var liveIds = ['startingSPL', 'maxDistance', 'tempC', 'humidity', 'terrain', 'windSpeed', 'windDir'];
  for (var li = 0; li < liveIds.length; li++) {
    var el = document.getElementById(liveIds[li]);
    if (!el) continue;
    el.addEventListener('input', scheduleDistanceTableUpdate);
    el.addEventListener('change', scheduleDistanceTableUpdate);
  }

  window.addEventListener('resize', function () {
    if (lastGrid) renderGrid(lastGrid, lastMaxDistance);
  });

  updateUnitLabels();
  wireProfilesUi();
  wirePhase4Ui();
  updateCompareSummary(resolveSourceLevels());

  requestAnimationFrame(function () {
    requestAnimationFrame(function () {
      generateNoiseMap();
    });
  });
})();
