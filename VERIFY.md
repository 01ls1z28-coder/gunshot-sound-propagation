# VERIFY — GSPS supersonic / shockwave UI toggle

**Branch:** `review/gsps-supersonic-toggle`  
**Base:** `main` @ live tip (SEO / hub-chrome)  
**Scope:** Expose existing `SupersonicShockwave` path via UI; no new physics; no profile rebake.

## What changed

- Checkbox **Include supersonic shockwave path** in Environment controls (`#isSupersonic`), **default unchecked (OFF)**.
- Disclaimer beside the control: engineering estimate; **not** hearing-safety; **not OSHA certified**.
- When OFF → all `Propagate` / `PropagateWithPeak` / `DistanceToLevel` callers pass `isSupersonic=false` (prior behavior).
- When ON → same callers pass `isSupersonic=true`, engaging existing pressure-domain shock merge in `js/acoustics.js` (`SupersonicShockwave`).
- A/B snapshot save/restore includes the checkbox state.
- Grid status line shows `shock=OFF` / `shock=ON`.

## Default-OFF regression

With the checkbox **unchecked** (page load default):

1. Map continuous SPL, OSHA distance table, cursor Peak≈, and CSV radial samples must match pre-tip behavior for the same bare/suppressed SPL + env + wind.
2. `Acoustics.SupersonicShockwave(..., false)` returns `0` → no shock pressure added.
3. Quick numeric check (Node, same inputs `165 dB @ 100 m`, Open Field, 20 °C, 50 % RH, no wind):

| isSupersonic | continuous dB | peak≈ dB |
|--------------|---------------|----------|
| `false` (default) | baseline B | baseline P |
| `true` | B_on ≥ B (shock merge) | P_on ≥ P |

Expect `B_on > B` and `P_on > P` at mid-field distances when ON; exact equality when OFF vs a pre-tip call with hardcoded `false`.

## Manual UI checks

1. Open `index.html` (or Pages preview of this branch). Checkbox starts **unchecked**.
2. Generate map → status includes `shock=OFF`. Map/OSHA look like live main.
3. Check the box → Generate → status `shock=ON`; map should brighten slightly / OSHA distances may shrink; **no console errors**.
4. Uncheck → Generate → back to prior SPL / distances.
5. Credits in header/footer remain **Jorge Guerra only**.
6. Static only: no tracking, no secrets, no network fetch for this tip.

## Intentional skips

- No Pages deploy from this tip; `main` not pushed.
- No caliber / suppressor rebake; no hub or PowerCurve changes.
- No new physics model beyond wiring the existing path.
