"""Executable NumPy reference for the 112G PAM4 SerDes link lesson.

The channel, CTLE and receiver front end are evaluated in the frequency domain, turned into a sampled pulse response
with an inverse real FFT, then equalized by an MMSE FFE (3 pre-cursor, 8 post-cursor taps) with optional ideal one-tap DFE.
The browser model in src/illustrations/serdes/model.ts is a TypeScript port; tests/serdes-model.test.ts compares it
with the numbers printed here.
"""
from math import erfc, sqrt

import numpy as np

BAUD = 56e9
FN = BAUD / 2
UI = 1 / BAUD
OS, NFFT, T0 = 32, 8192, 8
PS = (T0 - 3) * OS
EA = 5 / 9
PRE, POST, NFPRE, NFPOST = 6, 44, 3, 8
NF = NFPRE + NFPOST + 1
TX_FFE = (-0.10, 0.75, -0.15)
VPK, SIG_ADC, RJ = 0.5, 0.010, 0.2e-12
STX2 = EA * 10 ** (-28 / 10)
NP = 1 / 8.685889638
GAM = 0.9
CG, SG = np.cos(GAM * np.pi / 2), np.sin(GAM * np.pi / 2)


def poles(fp, n):
    return lambda f: (-0.5 * n * np.log1p((f / fp) ** 2), -n * np.arctan(f / fp))


def skin(loss_db):
    a = loss_db * NP * np.sqrt(2)
    def h(f):
        v = -a * np.sqrt(f / FN) / np.sqrt(2)
        return v, v
    return h


def diel(loss_db):
    b = loss_db * NP / CG
    def h(f):
        v = b * (f / FN) ** GAM
        return -v * CG, -v * SG
    return h


def echo(eps, delay_ui, seg_loss_db):
    def h(f):
        m = eps * np.exp(-seg_loss_db * NP * f / FN)
        th = -2 * np.pi * f * delay_ui * UI
        re, im = 1 + m * np.cos(th), m * np.sin(th)
        return 0.5 * np.log(re * re + im * im), np.arctan2(im, re)
    return h


def postcursor_echo(ratio, delay_ui=1):
    def h(f):
        z = (1 + ratio * np.exp(-2j * np.pi * f * delay_ui * UI)) / (1 + ratio)
        return np.log(np.abs(z)), np.angle(z)
    return h


def ctle(gdc_db, gdc2_db):
    g, g2 = 10 ** (gdc_db / 20), 10 ** (gdc2_db / 20)
    fz, fp1, fp2, flf = BAUD / 2.5, BAUD / 2.5, BAUD, BAUD / 80
    def h(f):
        a, b, c, d = f / fz, f / fp1, f / fp2, f / flf
        lm = 0.5 * (np.log(g * g + a * a) - np.log1p(b * b) - np.log1p(c * c) + np.log(g2 * g2 + d * d) - np.log1p(d * d))
        ph = np.arctan2(a, g) - np.arctan(b) - np.arctan(c) + np.arctan2(d, g2) - np.arctan(d)
        return lm, ph
    return h


def channel(loss_db, echo_ratio=0):
    return [poles(50e9, 2), skin(0.35 * loss_db), diel(0.65 * loss_db), echo(0.02, 9, 0.12 * loss_db), postcursor_echo(echo_ratio)]


def rx(gdc_db, gdc2_db):
    return [poles(45e9, 1), ctle(gdc_db, gdc2_db)]


def response(stages, f):
    lm, ph = np.zeros_like(f), np.zeros_like(f)
    for s in stages:
        a, b = s(f)
        lm, ph = lm + a, ph + b
    return lm, ph


def pulse(stages):
    """Response to a 1-UI rectangle, OS samples per UI, delayed by T0 UI."""
    k = np.arange(NFFT // 2 + 1)
    f = k * BAUD * OS / NFFT
    lm, ph = response(stages, f)
    ph = ph - 2 * np.pi * f * T0 * UI
    x = np.pi * k / NFFT
    box = np.empty(k.size, dtype=complex)
    box[0] = OS
    box[1:] = np.sin(x[1:] * OS) / np.sin(x[1:]) * np.exp(-1j * x[1:] * (OS - 1))
    spectrum = np.exp(lm + 1j * ph) * box
    return np.fft.irfft(spectrum, n=NFFT)


def with_tx_ffe(p, c):
    q = c[1] * p
    q[:-OS] += c[0] * p[OS:]
    q[OS:] += c[2] * p[:-OS]
    return q


KS = np.arange(-PRE - NFPRE, POST + NFPOST + 1)


def conv_matrix(h):
    """Rows k = −PRE−NFPRE … POST+NFPOST, columns FFE tap a: h[k − a + NFPRE]."""
    j = KS[:, None] - np.arange(NF)[None, :] + NFPRE
    inside = (j >= -PRE) & (j <= POST)
    return np.where(inside, h[np.clip(j + PRE, 0, PRE + POST)], 0.0)


def metrics(h, w, nz, dsp):
    f = conv_matrix(h) @ w
    f0, f1 = f[KS == 0][0], f[KS == 1][0]
    isi = np.sum(f[(KS != 0) & ((KS != 1) | (not dsp))] ** 2)
    g2 = f0 * f0
    wn = np.sum(w * w)
    parts = [EA * isi / g2, nz[0] * wn / g2, nz[1] * wn / g2, nz[2] * wn / g2, nz[3] * wn / g2, STX2 * np.sum(f * f) / g2]
    return f0, (f1 / f0 if dsp else 0.0), EA / sum(parts)


def design(h, nz, dsp, dfe=True):
    w = np.zeros(NF)
    if not dsp:
        w[NFPRE] = 1 / h[PRE]
    else:
        full = conv_matrix(h)
        m = full[KS != 1] if dfe else full
        rhs = EA * np.array([h[PRE + NFPRE - a] if -PRE <= NFPRE - a <= POST else 0.0 for a in range(NF)])
        # TX noise rides on every cursor, the DFE-cancelled one included, so it enters over all rows.
        w = np.linalg.solve(EA * m.T @ m + STX2 * full.T @ full + sum(nz) * np.eye(NF), rhs)
    f0, _, snr = metrics(h, w, nz, dsp and dfe)
    return w / f0, snr


def q(x):
    return 0.5 * erfc(x / sqrt(2))


def analyze(loss_db, xt_v, rxn_v, tx_ffe, auto, gdc, gdc2, dsp, dfe=True, echo_ratio=0, shared_front_end=False):
    c = TX_FFE if tx_ffe else (0.0, 1.0, 0.0)
    ch = channel(loss_db, echo_ratio)
    pad = with_tx_ffe(pulse(ch), c) * VPK
    df = BAUD * OS / NFFT
    f = np.arange(NFFT // 2 + 1) * df
    x = f / FN
    px = x * x / (1 + x ** 4)
    best = None
    for g in (range(0, -21, -1) if auto else [gdc]):
        for g2 in ((0, -3, -6) if auto else [gdc2]):
            p = with_tx_ffe(pulse(ch + rx(g, g2)), c)
            pi = PS + int(np.argmax(p[PS:PS + 24 * OS]))
            gg = np.exp(2 * response(rx(g, g2), f)[0])
            vga = 0.3 / np.sqrt(EA * np.sum(p[pi + np.arange(-PRE, POST + 1) * OS] ** 2))
            th2 = (vga * rxn_v / VPK) ** 2 * np.sum(gg) * df / FN
            xt2 = (vga * xt_v / VPK) ** 2 * np.sum(px * gg) / np.sum(px)
            for ts in range(pi - OS // 2, pi + OS // 2 + 1, 2):
                idx = ts + np.arange(-PRE, POST + 1) * OS
                h = p[idx] * vga
                slope = (p[idx + 1] - p[idx - 1]) * vga * OS / 2
                nz = (th2, xt2, SIG_ADC ** 2, EA * np.sum(slope ** 2) * (RJ / UI) ** 2)
                w, snr = design(h, nz, shared_front_end or dsp, False if shared_front_end else dfe)
                if best is None or snr > best[0]:
                    best = (snr, w, g, g2, ts, pi, vga, h, nz)
    snr, w, g, g2, ts, pi, vga, h, nz = best
    if shared_front_end:
        w, snr = design(h, nz, dsp, dfe)
    f0, b1, snr_check = metrics(h, w, nz, dsp and dfe)
    assert abs(f0 - 1) < 1e-9 and abs(snr_check / snr - 1) < 1e-9
    kept = pad[PS:PS + 56 * OS]
    return dict(gdc=g, gdc2=g2, phase=(ts - pi) / OS, vga=vga, h=h, pad_h0=kept.max(), snr=snr,
                ber=0.75 * q(np.sqrt(snr / 5)), b1=b1, w=w)


# The model's own identities: loss at f_N is exactly the setting, the pulse carries unit area, and the stages are causal.
for loss in (8, 28, 44):
    lm, _ = response([skin(0.35 * loss), diel(0.65 * loss)], np.array([FN]))
    assert np.isclose(lm[0] * 8.685889638, -loss, atol=1e-9)
    p = pulse([poles(50e9, 2), skin(0.35 * loss), diel(0.65 * loss)])
    assert np.isclose(p.sum() / OS, 1.0, atol=1e-9)
    # Before the onset only the wrapped-around end of the heavy tail remains: flat, and below 0.5 % of the peak.
    pre = p[:(T0 - 2) * OS]
    assert np.ptp(pre) < 1e-4 * p.max() and abs(pre.mean()) < 5e-3 * p.max()

print('loss_dB xt_mV rxn_mV txffe auto dsp gdc gdc2 phase_UI vga h_m1 h0 h1 pad_h0_mV snr_dB log10_ber b1 w0')
CASES = [
    (10, 1.5, 0.8, 1, 1, 0, 0, 1),
    (20, 1.5, 0.8, 1, 1, 0, 0, 1),
    (28, 1.5, 0.8, 1, 1, 0, 0, 1),
    (36, 1.5, 0.8, 1, 1, 0, 0, 1),
    (44, 1.5, 0.8, 1, 1, 0, 0, 1),
    (28, 1.5, 0.8, 0, 1, 0, 0, 1),
    (16, 1.5, 0.8, 1, 1, 0, 0, 0),
    (28, 1.5, 0.8, 1, 1, 0, 0, 0),
    (28, 1.5, 0.8, 1, 0, -12, -3, 1),
    (28, 0.0, 0.2, 1, 1, 0, 0, 1),
    (28, 4.0, 2.5, 1, 1, 0, 0, 1),
]
LINEAR_CASES = [
    (28, 1.5, 0.8, 1, 1, 0, 0, 1),
    (42, 2.1, 0.6, 0, 1, 0, 0, 1),
    (28, 1.5, 0.8, 0, 0, -12, -3, 1),
]
ECHO_CASES = [
    ('off', (12, 1.5, 0.8, 1, 1, 0, 0, 0), False),
    ('ffe', (12, 1.5, 0.8, 1, 1, 0, 0, 1), False),
    ('dfe', (12, 1.5, 0.8, 1, 1, 0, 0, 1), True),
]
reference_cases = [(case, True, 0, False, '') for case in CASES] + [(case, False, 0, False, 'ffe ') for case in LINEAR_CASES]
reference_cases += [(case, dfe, 0.85, True, f'echo-{mode} ') for mode, case, dfe in ECHO_CASES]
for case, dfe, echo_ratio, shared_front_end, prefix in reference_cases:
    loss, xt, rxn, txf, auto, gdc, gdc2, dsp = case
    r = analyze(loss, xt * 1e-3, rxn * 1e-3, txf, auto, gdc, gdc2, dsp, dfe, echo_ratio, shared_front_end)
    h = r['h']
    print(f"{prefix}{loss} {xt:.1f} {rxn:.1f} {txf} {auto} {dsp} {r['gdc']} {r['gdc2']} {r['phase']:.5f} {r['vga']:.6f} "
          f"{h[PRE - 1]:.6f} {h[PRE]:.6f} {h[PRE + 1]:.6f} {r['pad_h0'] * 1e3:.4f} {10 * np.log10(r['snr']):.5f} "
          f"{np.log10(max(r['ber'], 1e-300)):.4f} {r['b1']:.6f} {r['w'][NFPRE]:.6f}")


# PRBS13Q: x^13 + x^12 + x^2 + x + 1, bit pairs Gray-mapped 00→−3, 01→−1, 11→+1, 10→+3.
def prbs13q(seed, n):
    s, out = seed & 0x1FFF or 1, []
    def bit():
        nonlocal s
        b = ((s >> 12) ^ (s >> 11) ^ (s >> 1) ^ s) & 1
        s = ((s << 1) | b) & 0x1FFF
        return b
    for _ in range(n):
        msb, lsb = bit(), bit()
        out.append((2 if lsb else 3) if msb else (1 if lsb else 0))
    return out


seq = prbs13q(0x1D3, 2 * 8191)
assert seq[:8191] == seq[8191:]
assert all(seq[:p] != seq[p:2 * p] for p in (1, 3, 1170, 8191 // 7))
print('prbs13q period 8191 counts', ' '.join(str(seq[:8191].count(v)) for v in range(4)))
print('prbs13q first', ' '.join(str(v) for v in seq[:24]))
