"""Executable reference for the bang-bang PLL lesson.

A digital PLL at the reference rate: 100 MHz reference, divide-by-40, 4 GHz DCO. A 1-bit phase detector says late or
early; a proportional step beta and an integral step alpha (both in kHz at the DCO) act on each decision after a
latency of D reference cycles. Reference jitter sits in front of the detector; the DCO's white FM noise random-walks
the timing error. The noise uses the same mulberry32 generator and Box-Muller pairs as src/lib/rng.ts, so
src/illustrations/bbpll/model.ts reproduces these runs exactly; tests/bbpll-model.test.ts compares them.

The script also checks the page's closed-form claims against the simulation: the noise-free limit cycle of a
proportional-only loop, the pull-in range of the integral path, and the detector gain that jitter creates.
"""
import math

F_REF = 100e6
N_DIV = 40
F_OUT = F_REF * N_DIV
PS_PER_KHZ = (1e3 * 1e12) / (F_REF * F_OUT)
HALF_PS = 1e12 / F_REF / 2
CYCLES = 4000
SETTLED_FROM = CYCLES // 2
REF_SEED, DCO_SEED = 101, 202
DEFAULTS = dict(betaKHz=400, alphaKHz=4, latency=1, offsetKHz=2000, refJitterPs=0.3, dcoDbc=-95, noise=True)
PRESETS = {
    'acquire': DEFAULTS,
    'limit': dict(DEFAULTS, alphaKHz=0, offsetKHz=0, noise=False),
    'latency': dict(DEFAULTS, alphaKHz=0, offsetKHz=0, latency=3, noise=False),
    'dither': dict(DEFAULTS, offsetKHz=0, refJitterPs=3),
    'pullin': dict(DEFAULTS, offsetKHz=6000),
    'small': dict(DEFAULTS, betaKHz=50, alphaKHz=0.5, offsetKHz=0),
}
SWEEP_BETAS = [25, 50, 100, 200, 400, 800, 1600]
SWEEP_CYCLES, SWEEP_WARMUP = 12000, 2000
SWEEP_SEEDS = [(11, 12), (13, 14), (15, 16)]


def imul(a, b):
    return (a * b) & 0xFFFFFFFF


def mulberry32(seed):
    s = seed & 0xFFFFFFFF

    def rnd():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = imul(s ^ (s >> 15), s | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    return rnd


def gaussians(n, seed):
    rnd, out = mulberry32(seed), [0.0] * n
    for i in range(0, n, 2):
        u1 = rnd() or 1e-12
        u2 = rnd()
        r = math.sqrt(-2 * math.log(u1))
        out[i] = r * math.cos(2 * math.pi * u2)
        if i + 1 < n:
            out[i + 1] = r * math.sin(2 * math.pi * u2)
    return out


def dco_step_ps(dbc):
    """White FM: sigma(tau) = (f_m / f_0) * sqrt(10^(L/10) * tau), here over one reference period."""
    return (1e6 / F_OUT) * math.sqrt(10 ** (dbc / 10) / F_REF) * 1e12


def pull_in_khz(s):
    return s['betaKHz'] + (math.sqrt(2 * s['alphaKHz'] * HALF_PS / PS_PER_KHZ) if s['alphaKHz'] > 0 else 0)


def simulate(s, cycles=CYCLES, seeds=(REF_SEED, DCO_SEED)):
    gr, gw = gaussians(cycles, seeds[0]), gaussians(cycles, seeds[1])
    sr = s['refJitterPs'] if s['noise'] else 0
    sw = dco_step_ps(s['dcoDbc']) if s['noise'] else 0
    err, dec, freq, integ = [], [], [], []
    e = integral = 0.0
    slips = 0
    for k in range(cycles):
        err.append(e)
        d = 1 if e + sr * gr[k] >= 0 else -1
        dec.append(d)
        applied = dec[k - s['latency']] if k >= s['latency'] else 0
        integral += s['alphaKHz'] * applied
        integ.append(integral)
        f = s['offsetKHz'] + integral + s['betaKHz'] * applied
        freq.append(f)
        e += -PS_PER_KHZ * f + sw * gw[k]
        if e >= HALF_PS:
            e -= 2 * HALF_PS
            slips += 1
        elif e < -HALF_PS:
            e += 2 * HALF_PS
            slips += 1
    return dict(err=err, dec=dec, freq=freq, integ=integ, slips=slips)


def summarize(run, s, start=SETTLED_FROM):
    acquired = next((k for k, i in enumerate(run['integ']) if abs(s['offsetKHz'] + i) <= s['betaKHz']), None)
    tail, f = run['err'][start:], run['freq'][start:]
    mean = sum(tail) / len(tail)
    rms = math.sqrt(sum((v - mean) ** 2 for v in tail) / len(tail))
    # settled from the first cycle after which the error stays within 1.5 times the settled half's peak
    bound = 1.5 * max(abs(v) for v in tail)
    settled = None if run['slips'] else next((k + 1 for k in range(len(run['err']) - 1, -1, -1) if abs(run['err'][k]) > bound), 0)
    return dict(acquired=acquired, settled=settled, slips=run['slips'], rms=rms, pp=max(tail) - min(tail), mean_freq=sum(f) / len(f))


def period_of(seq):
    """Smallest p for which the settled sequence repeats."""
    for p in range(1, len(seq) // 2):
        if all(abs(seq[i] - seq[i + p]) < 1e-9 for i in range(len(seq) - p)):
            return p
    return None


def sweep(s):
    ratio = s['alphaKHz'] / s['betaKHz'] if s['betaKHz'] > 0 else 0
    rows = []
    for beta in SWEEP_BETAS:
        t = dict(s, betaKHz=beta, alphaKHz=beta * ratio, offsetKHz=0)
        noisy = sum(summarize(simulate(t, SWEEP_CYCLES, seeds), t, SWEEP_WARMUP)['rms'] for seeds in SWEEP_SEEDS) / len(SWEEP_SEEDS)
        clean = dict(t, noise=False)
        rows.append((beta, noisy, summarize(simulate(clean, 4000), clean, SWEEP_WARMUP)['rms']))
    return rows


print(f'ps per kHz per cycle {PS_PER_KHZ:.6f} | half period {HALF_PS:.1f} ps | DCO step at -95 dBc/Hz {dco_step_ps(-95):.6f} ps'
      f' | default pull-in {pull_in_khz(DEFAULTS):.1f} kHz')

print('noise-free proportional-only limit cycle, beta 400 kHz (one step = 1 ps):')
for latency in range(5):
    s = dict(PRESETS['limit'], latency=latency)
    tail = simulate(s)['err'][SETTLED_FROM:]
    pp, period = max(tail) - min(tail), period_of(tail)
    assert abs(pp - (2 * latency + 1) * s['betaKHz'] * PS_PER_KHZ) < 1e-9 and period == 4 * latency + 2
    print(f'  D {latency}: pp {pp:.6f} ps, period {period} cycles')

print('presets, whole run: preset acquired settled slips rms_ps pp_ps mean_freq_kHz (settled half)')
for name, s in PRESETS.items():
    m = summarize(simulate(s), s)
    none = lambda v: 'none' if v is None else v
    print(' ', name, none(m['acquired']), none(m['settled']), m['slips'], f"{m['rms']:.6f}", f"{m['pp']:.6f}", f"{m['mean_freq']:.6f}")

# The largest offset the noise-free default loop pulls in without slipping, against the closed form.
clean = dict(DEFAULTS, noise=False)
held = max(o for o in range(0, 8001, 100) if simulate(dict(clean, offsetKHz=o))['slips'] == 0)
print(f'pull-in: simulated {held} kHz (100 kHz grid), predicted {pull_in_khz(DEFAULTS):.1f} kHz')
assert abs(held - pull_in_khz(DEFAULTS)) < 300

# Jitter turns the sign into erf: the average decision at a fixed error, over many noise draws.
sigma = DEFAULTS['refJitterPs']
g = gaussians(200000, 7)
print(f'detector behind {sigma} ps rms jitter, slope {math.sqrt(2 / math.pi) / sigma:.6f} per ps at 0:')
for e in [-0.6, -0.3, -0.1, 0.1, 0.3, 0.6]:
    mean = sum(1 if e + sigma * v >= 0 else -1 for v in g) / len(g)
    expected = math.erf(e / (sigma * math.sqrt(2)))
    assert abs(mean - expected) < 0.01
    print(f'  e {e:+.1f} ps: mean decision {mean:+.4f}, erf {expected:+.4f}')

print('beta sweep at the defaults, locked from the start: beta_kHz rms_noisy_ps rms_clean_ps')
for beta, noisy, cln in sweep(DEFAULTS):
    print(f'  {beta} {noisy:.6f} {cln:.6f}')
