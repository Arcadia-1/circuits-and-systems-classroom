"""Executable reference for the clock-and-data-recovery lesson.

A bang-bang CDR for 56 GBd NRZ: ideal transition-based early/late decisions on every transition, a digital loop filter that votes
over `decim` UI and applies proportional and integral corrections after `latency` updates, and a 64-step phase
interpolator. The random jitter uses the same mulberry32 generator and Box-Muller transform as the browser, so
src/illustrations/cdr/model.ts reproduces these numbers exactly; tests/cdr-model.test.ts compares them.
"""
import math

BAUD = 56e9
NPI = 64
EYE_CLOSURE = 0.2
DEFAULTS = dict(ppm=300, sjUipp=0.3, sjHz=10e6, rjUi=0.015, pattern='prbs31', cdr=True, kp=1, integral=True,
                kiLog2=-6, decim=32, latency=2)
JTOL_HZ = [2e6, 5e6, 10e6, 20e6, 50e6, 100e6, 200e6, 500e6, 1e9]


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


def normals(seed):
    rnd, spare = mulberry32(seed), [None]

    def draw():
        if spare[0] is not None:
            v, spare[0] = spare[0], None
            return v
        u = rnd() or 1e-12
        th = 2 * math.pi * rnd()
        r = math.sqrt(-2 * math.log(u))
        spare[0] = r * math.sin(th)
        return r * math.cos(th)
    return draw


def wrap(x):
    return x - math.floor(x + 0.5)


class Bits:
    """PRBS7 (x^7+x^6+1), PRBS31 (x^31+x^28+1), or PRBS7 with 72 identical bits every 1000."""

    def __init__(self, pattern, seed=1):
        self.pattern, self.count = pattern, 0
        self.s = (seed & 0x7FFFFFFF or 1) if pattern == 'prbs31' else (seed & 0x7F or 1)

    def next(self):
        if self.pattern == 'cid':
            k = self.count
            self.count += 1
            if k % 1000 < 72:
                return 0
        if self.pattern == 'prbs31':
            b = ((self.s >> 30) ^ (self.s >> 27)) & 1
            self.s = ((self.s << 1) | b) & 0x7FFFFFFF
            return b
        b = ((self.s >> 6) ^ (self.s >> 5)) & 1
        self.s = ((self.s << 1) | b) & 0x7F
        return b


class Cdr:
    def __init__(self, s, seed=1):
        self.s, self.n = dict(s), 0
        self.code, self.acc, self.integ = 0, 0.0, 0.0
        self.slips = self.errors = 0
        self.vote = self.in_block = 0
        self.queue = []
        self.bits = Bits(s['pattern'], (0x2468ACE1 * seed) & 0xFFFFFFFF)
        self.gauss = normals(seed * 7919 + 13)
        self.prev_bit = self.bits.next()
        self.prev_theta = 0.0
        self.last_error_bit = -1
        self.lock = 0
        self.offset_phase = 0.0
        self.sj_arg = 0.0

    def start_jitter(self, uipp):
        self.s['sjUipp'] = uipp
        self.sj_arg = 0.0

    def flag(self, bit):
        if bit >= 0 and bit > self.last_error_bit:
            self.last_error_bit = bit
            self.errors += 1

    def step(self):
        s, n = self.s, self.n
        self.n += 1
        bit = self.bits.next()
        transition = bit != self.prev_bit
        phi = self.offset_phase + 0.5 * s['sjUipp'] * math.sin(self.sj_arg)
        edge = phi + s['rjUi'] * self.gauss()
        self.offset_phase += s['ppm'] * 1e-6
        self.sj_arg += (2 * math.pi * s['sjHz']) / BAUD
        theta = self.code / NPI if s['cdr'] else 0.0
        decision = 0
        if transition:
            e = wrap(edge - theta)
            decision = 1 if e > 0 else -1 if e < 0 else 0
            if 0.5 + wrap(edge - self.prev_theta) < EYE_CLOSURE:
                self.flag(n - 1)
            if 0.5 - e < EYE_CLOSURE:
                self.flag(n)
        self.prev_bit, self.prev_theta = bit, theta
        d = phi - theta - self.lock
        while d > 0.75:
            self.lock += 1
            self.slips += 1
            d -= 1
        while d < -0.75:
            self.lock -= 1
            self.slips += 1
            d += 1
        self.vote += decision
        self.in_block += 1
        if self.in_block >= s['decim']:
            self.queue.append((self.vote > 0) - (self.vote < 0))
            self.vote = self.in_block = 0
            while len(self.queue) > s['latency']:
                self.apply(self.queue.pop(0))
        return edge, theta

    def apply(self, v):
        s = self.s
        if not s['cdr']:
            return
        if s['integral']:
            self.integ += 2.0 ** s['kiLog2'] * v
        else:
            self.integ = 0.0
        self.acc += s['kp'] * v + self.integ
        self.code = math.floor(self.acc + 0.5)

    def tracked_ppm(self):
        return self.integ / (NPI * self.s['decim']) * 1e6


def run(s, n, seed=1):
    sim, sum2, peak, count = Cdr(s, seed), 0.0, 0.0, 0
    for i in range(n):
        phi, theta = sim.step()
        if i >= n / 2:
            e = wrap(phi - theta)
            sum2 += e * e
            peak = max(peak, abs(e))
            count += 1
    return sim, math.sqrt(sum2 / count), peak


def jtol_at(s, hz, seed=7):
    length = max(4000, math.ceil((1.5 * BAUD) / hz))

    def ok(uipp):
        sim = Cdr(dict(s, sjUipp=0, sjHz=hz), seed)
        for _ in range(4000):
            sim.step()
        sim.start_jitter(uipp)
        before, slips_before = sim.errors, sim.slips
        for _ in range(length):
            sim.step()
        return sim.errors == before and sim.slips == slips_before

    lo, hi = 0.02, 20.0
    if not ok(lo):
        return 0.0
    if ok(hi):
        return hi
    for _ in range(8):
        mid = math.sqrt(lo * hi)
        if ok(mid):
            lo = mid
        else:
            hi = mid
    return lo


# PRBS7 repeats every 127 bits with 64 ones; the CID pattern holds 72 zeros at the start of every 1000 bits.
p7 = Bits('prbs7')
seq = [p7.next() for _ in range(254)]
assert seq[:127] == seq[127:] and sum(seq[:127]) == 64
cid = Bits('cid')
assert all(cid.next() == 0 for _ in range(72))
p31 = Bits('prbs31', 0x2468ACE1)
print('prbs7 period 127 ones 64')
print('prbs31 first', ''.join(str(p31.next()) for _ in range(48)))

print('case slips errors tracked_ppm rms_mUI peak_mUI code')
CASES = [
    ('default', {}),
    ('p_only_300ppm', dict(integral=False)),
    ('p_only_800ppm', dict(integral=False, ppm=800)),
    ('cdr_off', dict(cdr=False)),
    ('sj_2MHz_4UIpp', dict(sjUipp=4, sjHz=2e6)),
    ('sj_500MHz_0.8UIpp', dict(sjUipp=0.8, sjHz=500e6)),
    ('cid72', dict(pattern='cid')),
    ('prbs7', dict(pattern='prbs7')),
]
for name, change in CASES:
    sim, rms, peak = run(dict(DEFAULTS, **change), 40000)
    print(f'{name} {sim.slips} {sim.errors} {sim.tracked_ppm():.3f} {rms * 1e3:.4f} {peak * 1e3:.4f} {sim.code}')

print('jtol_MHz uipp')
for hz in JTOL_HZ:
    print(f'{hz / 1e6:g} {jtol_at(DEFAULTS, hz):.5f}')
