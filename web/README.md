# Circuits & Systems Classroom

Interactive lessons on data converters, PLLs, clocking and circuit analysis, served at
<https://circuits-and-systems.tokenzhang.com>. ADC pages run ports of
[ADCToolbox](https://github.com/Arcadia-1/ADCToolbox) models in the browser. The library's reference manual remains at
<https://adctoolbox.tokenzhang.com/doc/>.

The site is static [Astro](https://astro.build) with [Svelte 5](https://svelte.dev) islands in strict TypeScript.

## Commands

Run these in `web/` with Node 22.12 or newer and pnpm 11.

| Command | Action |
|---|---|
| `pnpm install` | Install dependencies |
| `pnpm dev` | Start the dev server at <http://localhost:4321> |
| `pnpm check` | Type-check Astro, Svelte and the analytics Worker, then run the model tests |
| `pnpm build` | Build the static site into `dist/` |
| `pnpm preview` | Serve `dist/` locally |
| `pnpm deploy:analytics` | Deploy the analytics Worker (needs a Cloudflare login with Workers access) |

## Layout

| Path | Contents |
|---|---|
| `src/pages/` | Home, 404 and one `.astro` route per illustration |
| `src/illustrations/<topic>/` | One illustration: `model.ts` with the simulation as pure functions, plus its Svelte components |
| `src/components/` | Shared controls in `ui/`, chart primitives in `chart/`, compact lesson links and the shared navigation/footer |
| `src/lib/` | Number formatting, seeded random numbers, FFT, scales |
| `src/styles/` | Design tokens and chart classes in `global.css`, the shared illustration page layout in `illustration.css` |
| `src/data/illustrations.ts` | Topics and entries on the home page |
| `src/data/columns.ts` | Courses on other sites, listed under External Links below the lessons; their cover images live in `public/external/` |
| `tests/` | Vitest checks of each TypeScript model against numbers from its Python reference |
| `python/` | Executable Python references: ADC models using ADCToolbox, plus PLL, amplifier and SerDes models using NumPy |
| `public/` | Favicon and Cloudflare Pages response headers |
| `analytics/` | Copied analytics module: tracking, dashboard, routes and Durable Object |
| `functions/` | Host-aware redirects from the former tutorial URLs to the new domain |
| `worker/` | Analytics Worker that mounts the same historical counter on both domains at `/api/*` |

## Illustrations

- **PLL introduction** at `/pll/introduction/`. An averaged phase-domain PLL with a linear detector, PI filter,
  bounded VCO tuning and feedback divider. Compare open loop, P-only phase offset, type-II locking, damping and a
  reference phase step. The clock sketch and chart cursor share frequency/phase state. Independent fine-step NumPy
  integration and analytical equilibrium checks validate the model; this is not a nonlinear PFD acquisition model.
- **Pipeline ADC** at `/adc/pipeline-adc/`. All stages appear as rows in one SVG strip. Each row plots against
  **original ADC input voltage**, with
  its own explicitly labeled bounds: the true input interval selected by the preceding stage decisions is expanded for
  the next row. A highlighted interval and connecting band show which part of one row becomes the following view.
  Linked markers follow the same input sample through every stage. Display magnification describes the horizontal view
  scale; the residue amplifier's circuit gain is specified separately. Residue rows show amplifier output voltage, and
  the final row shows the last flash digit.
  DNL, INL and overall ADC transfer occupy three rows on the right, with ADC transfer filling the third row.
  All three overall plots retain their full input or code range. DNL and INL use a minimum vertical range of
  −0.5 to +0.5 LSB, expanding symmetrically only when their data exceed that range. Every residue amplifier has independent
  gain and nonlinearity settings, and all configured errors act simultaneously. **Edit stage** selects the controls'
  editing target while preserving other stages' values; each architecture retains its own parameter profile. The final
  flash has no residue amplifier and is excluded from error injection. DNL, INL and ADC transfer use thresholds from
  the combined response of all stages.
  All sliders and action buttons share a bounded panel above the plots: reset/random error actions sit beside the error
  sliders, and input/random-all actions sit beside the input slider. Both error controls span ±0.25% in 0.005% increments.
  Each architecture starts with +0.10% gain error in its first stage and zero errors elsewhere. **Reset errors** clears
  every stage in the current architecture without moving the input. **Random input** changes only the input voltage;
  **Random errors** changes both errors only in the stage being edited; **Random all** changes the input and both errors
  in every residue stage of the current architecture. These actions pause the sweep and retain the architecture and
  selected editing stage.
  Within the nominal residue range 0–1 V, each amplifier uses `F(r) = (1 + g)r + 4nr(1 − r)(2r − 1)`, where `g` and `n`
  are its percentage settings divided by 100. Outside that range, the model extends the corresponding endpoint tangent,
  preserving a monotonic response without clipping analog residue. Subsequent quantizer decisions still saturate.
  The default architecture is four 3-bit stages, totaling 12 bits. Alternatives include ten stages (nine 1-bit stages
  plus a final 3-bit flash), three 4-bit stages, and a three-stage 6-bit preset. Endpoint fitting and reported extrema
  always use the full input range.
  The digital output concatenates actual decisions and never adds unquantized analog residue.
  Tests cover every 12-bit boundary, full-scale saturation, allocation invariance, true residue branches, analytical
  and independently bisected error-model thresholds, code-density widths, missing codes and observed-endpoint INL.
  This is the only Pipeline ADC page. Production middleware redirects `/adc/pipeline-introduction/` without generating
  a second static page. The course uses `Base viewport`: a 49 px header, flexible lesson area and 26 px visitor footer
  share `100dvh`, without page scrolling. Desktop shows every stage alongside the error plots. At widths of 850 px or
  less, **Stage curves** and **DNL / INL** tabs switch plot groups; the Stage curves strip still includes every stage.
  The visitor counter remains visible.
- **Nonlinear calibration** at `/adc/nonlinear-calibration/`. A known ramp trains a polynomial inverse using QR least
  squares; a new coherent sine and independent noise validate the frozen coefficients. The transfer, error, harmonics,
  SNDR and RMS error share the same data. Degree, coverage, noise, distortion and validation amplitude are adjustable.
  Device changes invalidate the old fit; training-setting changes require retraining; validation never refits.
  Explicit examples show extrapolation and clipping limits. NumPy lstsq and rfft provide independent references.

- **Open-loop & closed-loop gain** at `/amplifiers/open-loop-and-closed-loop/`. Adjust A₀ and β independently in two cases.
  In **Hold open loop**, chosen A₀ and fOL remain fixed as β changes the closed-loop gain and bandwidth.
  In **Hold closed-loop BW**, the target fCL stays fixed and the model solves `fOL = fCL/(1 + βA₀)` and the required GBW.
  Both cases share fixed frequency axes while A₀ or β moves. The lesson fills the viewport between header and visitor
  footer; narrow screens switch cases instead of stacking plots. No duplicate title, Reset or Model notes toolbar.
  Synchronized magnitude/phase plots distinguish gain error, −3 dB bandwidth and the two unity crossings. Complex-response values are checked against independent
  NumPy division; tests also verify the exact `T₀ × fCL = GBW` identity and weak-feedback limits. The source figure in
  `../code/plot_bandwidth_comparison.py` uses the same complex transfer function.
- **Integer-N vs fractional-N PLL** at `/pll/integer-vs-fractional/`. A reference-rate time-domain simulation of two loops that
  share one reference, loop filter and VCO. The fractional-N divider is an accumulator, a MASH 1-1-1, or a MASH 1-1-1 with a
  DTC that has adjustable INL.
- **Binary vs redundant SAR ADC** at `/adc/binary-vs-redundant-sar/`. The SAR conversion, unit-capacitor mismatch, sine-fit weight
  calibration and spectrum analysis are ports of [ADCToolbox](https://github.com/Arcadia-1/ADCToolbox), checked against it to
  0.001 ENOB. The page steps through one conversion and compares the output spectra of both converters before and after
  calibration. It grows out of [ADC_Visualization](https://github.com/Arcadia-1/ADC_Visualization).
- **112G PAM4 SerDes link** at `/serdes/112g-pam4-link/`. A Three.js scene of a chip-to-chip link: the transmitter die
  (MUX tree, SST driver, LC-PLL), the board channel and the receiver die (CTLE, 64-way SAR TI-ADC, FFE/DFE DSP, DEMUX
  tree), with the line voltage drawn in slow motion from the channel model. The model evaluates a causal channel
  (skin effect, dielectric loss and echoes), the IEEE 802.3ck COM-form CTLE, VGA and noise terms in the frequency
  domain, searches the CTLE and sampling phase for the best SNR and solves a 12-tap MMSE FFE with a one-tap DFE; the eye
  diagrams and model error budget follow from it. The default FFE mode optimizes all ISI cursors without decision
  feedback. Four channel-only options cover short (8 dB), lossy (28 dB), a strong 1-UI echo, and long (42 dB) paths;
  choosing one preserves noise, TX equalization and RX mode. The echo is the passive two-path response
  `(1 + r exp(-j 2π f UI))/(1 + r)`, with `r = 0.85` and 12 dB distributed loss in the example. Its extra Nyquist loss
  is included in the total loss, response plot and 3-D RX label. The travelling waveform ends at the same pulse response
  as the RX-pad eye. By default, “Same CTLE & clock” calibrates the analog front end for the best FFE and uses exactly
  the same ADC waveform and noise in every DSP mode; unchecking it restores per-mode optimization. A compact comparison
  reports model SNR assuming correct feedback. The echo case improves from about 16.1 to 21.3 dB with DFE, also checked
  against actual slicer decisions. Compare shows the RX-pad waveform, the receiver sampling eye and its four-level amplitude distribution.
  The sampling eye sweeps 32 clock phases per UI with fixed equalizer taps; in FFE + DFE mode each phase runs its own
  feedback decisions, including errors. It is a statistical phase-density plot, not an analog DFE waveform. The two-UI
  display repeats the measured one-UI distribution. The histogram is exactly the centre column of the same eye snapshot:
  both use the same amplitude bins and last 4,096 symbols as measured SNR and Gray-coded BER, including DFE error
  propagation. Stages retains the continuous ADC and FFE waveforms. Model SNR and Gaussian BER remain in Channel for
  comparison. Plain PAM4 remains a TX-only reference. Tests check echo passivity and its delayed pulse, shared front-end
  equality, numerical agreement with NumPy, measured DFE gain and error propagation, opening at repeated phases,
  independent feedback histories, rolling-window expiry and bin-for-bin eye/histogram agreement.
  `python/serdes_112g_link.py` is the NumPy
  reference. three.js loads only on this page, as a lazy chunk.
- **Clock and data recovery** at `/serdes/clock-and-data-recovery/`. A bang-bang CDR for 56 GBd NRZ, opened by a
  six-step guided tour for beginners on a slow-motion conveyor belt: bits ride past a reader and an edge checker, and each
  early/late verdict turns a timing knob (no clock, a clock error, steering by the edges, the integral path, jitter,
  the real link). The long view is a phase tunnel: height is time, the angle is the phase inside one UI, so a frequency
  offset winds the data edges into a helix and the recovered edge and data samplers turn with them. The loop votes
  early/late decisions over 1–32 UI and applies
  proportional and integral corrections to a 64-step phase interpolator after a set latency; the page shows phase
  tracking, eyes folded by the recovered and by a free-running clock, cycle slips and timing-margin violations, and the jitter-tolerance
  curve found by bisection with both margin violations and cycle slips as failures. The ideal transition-based
  early/late detector is explicitly distinguished from Alexander three-sample logic. Margin counting deduplicates
  bits across their two bounding edges, and RMS includes random jitter. Sweeps yield between frequencies. `python/serdes_cdr.py` reproduces the simulation bit for bit, random jitter included.
- **PCI Express** at `/serdes/pci-express/`. A guided eight-step tour of a PCIe link on a 3-D motherboard: lanes as a
  pair each way, bytes dealt across x1–x16, the rate and line code of generations 1–7 (8b/10b, 128b/130b, PAM4 flits),
  a TLP inside its envelopes, ACK/NAK replay after noise damages a packet, and credit-based flow control. The traffic is
  one direction of a Gen 1–5 link simulated event by event (packet-slot credit abstraction, sequence numbers, a replay
  buffer and timer). Gen 6–7 instead show the 256-byte FLIT fields, PAM4 baud rate and whole-FLIT isolated serialization;
  the packed-stream payload upper bound is separately identified. Raw, coded and payload rates use distinct labels;
  generation bars are linear. Device service time can cap utilization even with ample receive slots. The model explains
  the separate real header/data credit pools and cumulative ACK simplification, and
  `python/serdes_pcie.py` reproduces the rates, the payload shares and the simulated runs.

## Adding an illustration

1. Write the model in `src/illustrations/<topic>/model.ts`, a Python reference in `python/` and a test in `tests/`.
2. Build the page component next to the model from the shared `ui` and `chart` components.
3. Add a route in `src/pages/<topic>/` that renders the component with `client:load` and imports `illustration.css`.
4. List it in `src/data/illustrations.ts` and draw its thumbnail in `src/components/Thumb.astro`. Add reviewed lessons to
   `src/data/publication.ts` so they appear in the catalog and sitemap; register any new route prefix in `isLessonPath`
   and `functions/_middleware.js`.
5. Run `pnpm check` and `pnpm build`.

## Analytics

`analytics/` is the copyable first-party analytics module of analog-arena (`site/analytics` in Arcadia-1/analog-arena): the
tracking hook, the dashboard page and styles, the world-map data, the HTTP routes and the Durable Object. Host customizations
include the page title, navigation-safe cleanup and the user's required light-only appearance. When updating the copied
module, preserve those customizations and do not restore its theme switch. The host wires it in three places:

- `src/components/Visits.tsx` calls `useVisitStats` on every page through `Base.astro` and shows the totals in every shared
  page footer.
- `src/pages/analytics.astro` mounts the dashboard at `/analytics/` with the mono font, theme class and reset it expects.
- `worker/index.ts` registers the routes on Hono and exports the Durable Object. The Worker is routed on `/api/*` in
  front of the Pages site and deployed with `pnpm deploy:analytics`.

## Deploy

`.github/workflows/deploy-web.yml` installs, checks and builds the site for every pull request that touches `web/`. On `main` it
deploys `dist/` to the existing Cloudflare Pages project `ams-class`, ensures
`circuits-and-systems.tokenzhang.com` is attached, and preserves the host-aware redirects. The analytics Worker route for
both domains is declared in `worker/wrangler.jsonc` and deployed separately with `pnpm deploy:analytics`. The old host keeps
the ADCToolbox manual; its home page and tutorial paths redirect to the matching path on the new host.

## Editorial and visual direction

Use **Circuits & Systems Classroom** as the site brand. The public catalog is intentionally small: seven reviewed ADC
lessons, two PLL lessons, one amplifier lesson, three SerDes lessons and the selected Bode-plot tool. Other experiments remain available by direct URL with `noindex`
until they reach the same standard. The ADCToolbox manual remains the reference for the Python API and longer examples.

Each entry has its own schematic preview so readers can recognize the experiment at a glance; model provenance and example
names belong inside the lesson notes. Keep the two-column editorial layout on wide screens and one column on phones.

The shared header and footer, restrained borders, system sans font, Google Sans Code labels and green accent follow
Analog Design Bench. Plot series use distinct, readable colors. All pages use light mode only, including analytics.
There is no theme switch; legacy dark preferences are cleared before the first paint and Astro navigation swaps,
so WebGL scenes and eye diagrams match the page without a refresh.

## Numerical verification

See [the 2026-09-20 scientific audit](SCIENTIFIC-AUDIT-2026-09-20.md) for the scope, analytical checks, corrected
calculations and the external Bode tool's known marginal-stability limitation. `tests/scientific-audit.test.ts`
checks independent signal identities in addition to the Python regression comparisons.

For reproducible reference results, install the verified library revision from the repository root:

```sh
python -m pip install -r web/python/requirements.txt
```

The pin includes the time-interleaved ADC offset-spur correction, which is not in the PyPI 0.9.1 release.
Then verify every example:

```sh
MPLBACKEND=Agg python .github/toolbox-drift.py
```

CI also runs this check against ADCToolbox main to detect upstream changes.

This executes every script in `web/python/` and compares its output with `web/python/expected/`. The PLL script uses
a fixed random seed and leaves execution timing out of the output. Vitest separately checks the browser models
against Python reference values and physical invariants. The deployment waits for both checks to pass.

Only refresh expected output after investigating a difference and updating the corresponding browser model and tests.

## Keep the visitor counter

The shared footer must always show cumulative visitors and page views, with a link to `/analytics/`. Render the
counter before hydration; use “—” while totals are unavailable, and display real zero counts as zero. Never remove
the counter as part of a visual redesign.

`Visits.tsx` reads `/api/stats` without recording a visit, so the totals can still appear when the tracking request
is skipped or fails. The existing `/api/hit` hook records at most one visit per navigation. Preserve the existing
Worker name, Durable Object binding and object name, schema version and cookies documented in `analytics/README.md`
to keep the historical counts. A static local preview without the analytics Worker shows the placeholder.
