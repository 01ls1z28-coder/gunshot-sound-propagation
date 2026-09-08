# Gunshot Sound Propagation Simulator (static web)

Static GitHub Pages port of Jorge Guerra’s WPF **GunshotSoundPropagationSimulator**.

**Created by Jorge Guerra.** Static rebuild by Sati.

## Live / Pages

Enable **Settings → Pages → Deploy from branch `main` / root** (or the feature branch Seraph clears). No build step — open `index.html` or serve the repo root.

## Controls (same as desktop MainWindow)

| Control | Default | Notes |
|--------|---------|--------|
| Starting SPL (dB @ 1m) | 165 | Muzzle / source level at 1 m |
| Max Distance (m) | 1000 | Half-domain radius; map spans 2× this |
| Temp (°C) | 20 | Atmospheric absorption |
| Humidity (%) | 50 | Atmospheric absorption |
| Terrain | Open Field | Open Field / Forest / Urban / Indoor |
| Wind speed (m/s) | 0 | Directional gain/loss |
| Wind direction (°) | 0 | Meteorological angle used as in desktop |
| Generate Noise Map | — | Rebuilds canvas heatmap |
| Show Legend | — | SPL color legend modal |

Hover / touch the map for cursor SPL and distance readout.

## Grid performance cap

Desktop WPF used **1 m cells** over a `(2 × maxDistance)²` domain (e.g. 2000×2000 at 1000 m), which freezes browsers.

This build caps **`MAX_CELLS_PER_AXIS = 180`**. Cell size scales as:

`cellSize_m = (2 × maxDistance) / gridSize`

Documented in the UI status line under the buttons (`js/app.js`).

## Physics fidelity

`js/acoustics.js` is a line-faithful port of `Acoustics.cs`:

- Spherical spreading (20 log₁₀)
- Three-band atmospheric absorption (125 / 1000 / 4000 Hz) with weights 0.45 / 0.35 / 0.20
- Terrain loss (Open Field / Forest / Urban / Indoor)
- Ground reflection (source height 1.5 m, R = 0.6)
- Wind factor
- Supersonic shockwave path present (desktop UI passes `isSupersonic = false`)

GunProfile / SuppressorProfile exist in the WPF tree but were not wired in MainWindow — not wired here either.

## Disclaimer

Compiled engineering estimates for visualization and education — **not** laboratory-certified hearing-protection or regulatory numbers.

## Stack

HTML / CSS / vanilla JS only. No server, no database, no network fetches, no tracking.
