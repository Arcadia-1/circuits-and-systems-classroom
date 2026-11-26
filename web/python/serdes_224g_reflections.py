"""Executable NumPy reference for the 224G reflections & equalization lesson.

Independently implements:
  1) Exact 2-port ABCD transmission-line cascade (with bridged T-coil vs bare ESD pad cap)
  2) Passivity, causality, TDR and 1-D wave-splitting lattice cross-validation
  3) 224G PAM4 COM-form CTLE, 12..44-tap MMSE FFE, 1-tap DFE and 4-state PAM4 Viterbi MLSE
     using the exact same deterministic mulberry32 + Box-Muller stream as TypeScript.

tests/serdes-reflections.test.ts verifies the browser model against every number printed here.
"""
from math import erfc, sqrt
import numpy as np

BAUD = 112e9
FN = BAUD / 2
UI = 1.0 / BAUD
Z0 = 50.0
PS_PER_MM = 6.0
OS = 16
NFFT = 8192
T0 = 16
PRE, POST, NFPRE = 4, 44, 3
LEVELS = np.array([-1.0, -1.0 / 3.0, 1.0 / 3.0, 1.0])
EA = 5.0 / 9.0
TX_FFE = (-0.12, 0.76, -0.12)
VPK, SIG_ADC, RJ = 0.5, 0.010, 0.12e-12
STX2 = EA * 10 ** (-28.0 / 10.0)
PKG_MM, VIA_MM, CONN_MM, CABLE_VIS_MM, RX_STUB_MM = 4.0, 1.6, 2.4, 4.0, 6.0
CAVITY_LOSS_DB_PER_MM = 0.10
LATTICE_DX_MM = 0.1
LATTICE_DT = LATTICE_DX_MM * PS_PER_MM * 1e-12
NP = 1.0 / 8.685889638
GAM = 0.9
CG, SG = np.cos(GAM * np.pi / 2), np.sin(GAM * np.pi / 2)
GRAY = (0b00, 0b01, 0b11, 0b10)


def mulberry32(seed):
    s = seed & 0xFFFFFFFF
    def nxt():
        nonlocal s
        s = (s + 0x6D2B79F5) & 0xFFFFFFFF
        t = s
        t = ((t ^ (t >> 15)) * (t | 1)) & 0xFFFFFFFF
        t = (t ^ ((t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296.0
    return nxt


def make_normals(seed):
    rnd = mulberry32(seed)
    spare = None
    def nxt():
        nonlocal spare
        if spare is not None:
            v = spare
            spare = None
            return v
        u1 = rnd() or 1e-12
        u2 = rnd()
        r = sqrt(-2.0 * np.log(u1))
        spare = r * np.sin(2.0 * np.pi * u2)
        return r * np.cos(2.0 * np.pi * u2)
    return nxt


def physical_segments(loss_db, z_via, z_conn, pcb_mm):
    cav_mm = PKG_MM + VIA_MM + pcb_mm + CONN_MM + RX_STUB_MM
    cav_loss = min(loss_db * 0.5, CAVITY_LOSS_DB_PER_MM * cav_mm)
    cable_loss = max(0.0, loss_db - cav_loss)
    per_mm = cav_loss / cav_mm
    return [
        (PKG_MM, Z0, PKG_MM * per_mm),
        (VIA_MM, z_via, VIA_MM * per_mm),
        (pcb_mm, Z0, pcb_mm * per_mm),
        (CONN_MM, z_conn, CONN_MM * per_mm),
        (CABLE_VIS_MM, Z0, cable_loss),
        (RX_STUB_MM, Z0, RX_STUB_MM * per_mm),
    ]


def eval_abcd(f, segs, pad_cap_ff, tcoil):
    A = np.ones_like(f, dtype=complex)
    B = np.zeros_like(f, dtype=complex)
    C = np.zeros_like(f, dtype=complex)
    D = np.ones_like(f, dtype=complex)
    x = f / FN
    sx = np.sqrt(x)
    px = np.power(x, GAM)
    for length_mm, zc, seg_loss in segs:
        skin_v = 0.35 * seg_loss * NP * sx
        diel_v = (0.65 * seg_loss * NP / CG) * px
        alpha = skin_v + diel_v * CG
        beta = 2.0 * np.pi * f * (length_mm * PS_PER_MM * 1e-12) + skin_v + diel_v * SG
        gl = alpha + 1j * beta
        ch, sh = np.cosh(gl), np.sinh(gl)
        A, B, C, D = (
            A * ch + B * (sh / zc),
            A * (zc * sh) + B * ch,
            C * ch + D * (sh / zc),
            C * (zc * sh) + D * ch,
        )
    cp = pad_cap_ff * 1e-15
    if not tcoil and cp > 0:
        yc = 1j * 2.0 * np.pi * f * cp
        C, D = C + yc * A, D + yc * B
        A, C = A + yc * B, C + yc * D
    denom = A + B / Z0 + C * Z0 + D
    s21_pass = 2.0 / denom
    s11 = (A + B / Z0 - C * Z0 - D) / denom
    if tcoil and cp > 0:
        s = 1j * 2.0 * np.pi * f
        htc = 1.0 / (1.0 + 0.5 * s * Z0 * cp + 0.125 * (s * Z0 * cp) ** 2)
        s21 = s21_pass * (htc ** 2)
    else:
        s21 = s21_pass
    return s11, s21, s21_pass


def ctle_H(f, gdc, gdc2):
    g, g2 = 10 ** (gdc / 20.0), 10 ** (gdc2 / 20.0)
    fz, fp1, fp2, flf = BAUD / 2.5, BAUD / 2.5, BAUD, BAUD / 80.0
    s = 1j * f
    return (g + s / fz) / ((1.0 + s / fp1) * (1.0 + s / fp2)) * (g2 + s / flf) / (1.0 + s / flf)


def pulse_from_H(H, flight_sec):
    k = np.arange(NFFT // 2 + 1)
    f = k * BAUD * OS / NFFT
    x = np.pi * k / NFFT
    box = np.empty(k.size, dtype=complex)
    box[0] = OS
    box[1:] = np.sin(x[1:] * OS) / np.sin(x[1:]) * np.exp(-1j * x[1:] * (OS - 1))
    shift = np.exp(-1j * 2.0 * np.pi * f * (T0 * UI - flight_sec))
    return np.fft.irfft(H * box * shift, n=NFFT)


def with_tx(p, c):
    q = c[1] * p
    q[:-OS] += c[0] * p[OS:]
    q[OS:] += c[2] * p[:-OS]
    return q


def solve_mmse(h, nz_sum, nf_post, pr1):
    nf = NFPRE + nf_post + 1
    ks = np.arange(-PRE - NFPRE, POST + nf_post + 1)
    j = ks[:, None] - np.arange(nf)[None, :] + NFPRE
    inside = (j >= -PRE) & (j <= POST)
    full = np.where(inside, h[np.clip(j + PRE, 0, PRE + POST)], 0.0)
    m = full[ks != 1] if pr1 else full
    rhs = EA * np.array([h[PRE + NFPRE - a] if -PRE <= NFPRE - a <= POST else 0.0 for a in range(nf)])
    w = np.linalg.solve(EA * m.T @ m + STX2 * full.T @ full + nz_sum * np.eye(nf), rhs)
    fv = full @ w
    f0 = fv[ks == 0][0]
    w = w / f0
    fv = fv / f0
    f1 = fv[ks == 1][0]
    isi = np.sum(fv[(ks != 0) & ((ks != 1) | (not pr1))] ** 2)
    wn = np.sum(w ** 2)
    tot = EA * isi + nz_sum * wn + STX2 * np.sum(fv ** 2)
    return w, (f1 if pr1 else 0.0), EA / tot, wn


def slice_pam4(z):
    return 0 if z < -2.0 / 3.0 else (1 if z < 0.0 else (2 if z < 2.0 / 3.0 else 3))


def run_viterbi(y, alpha, start, end):
    pm = np.zeros(4)
    tb = np.zeros((len(y), 4), dtype=np.int8)
    for n in range(start, end):
        yn = y[n]
        nxt = np.empty(4)
        for sc in range(4):
            ac = LEVELS[sc]
            best_m = 1e30
            best_p = 0
            for sp in range(4):
                diff = yn - (ac + alpha * LEVELS[sp])
                m = pm[sp] + diff * diff
                if m < best_m:
                    best_m = m
                    best_p = sp
            nxt[sc] = best_m
            tb[n, sc] = best_p
        pm = nxt - np.min(nxt)
    dec = np.zeros(len(y), dtype=np.int8)
    st = int(np.argmin(pm))
    for n in range(end - 1, start - 1, -1):
        dec[n] = st
        st = tb[n, st]
    return dec


def analyze_case(loss_db, z_via, z_conn, pcb_mm, pad_ff, tcoil, tx_ffe, ctle_on, ffe_post, rx_mv, xt_mv, n_sym=8000, seed=0x224A):
    segs = physical_segments(loss_db, z_via, z_conn, pcb_mm)
    df = BAUD * OS / NFFT
    f = np.arange(NFFT // 2 + 1) * df
    s11, s21, s21_pass = eval_abcd(f, segs, pad_ff, tcoil)
    max_passivity = float(np.max(np.abs(s11) ** 2 + np.abs(s21_pass) ** 2))
    assert max_passivity <= 1.0 + 1e-10
    flight_sec = (PKG_MM + VIA_MM + pcb_mm + CONN_MM + CABLE_VIS_MM + RX_STUB_MM) * PS_PER_MM * 1e-12
    H_drv = 1.0 / (1.0 + 1j * f / 95e9) ** 2
    H_afe = 1.0 / (1.0 + 1j * f / 90e9)
    c = TX_FFE if tx_ffe else (0.0, 1.0, 0.0)
    gdcs = [0, -2, -4, -6, -8, -10, -12, -14, -16, -18, -20] if ctle_on else [0]
    gdc2s = [0, -3, -6] if ctle_on else [0]
    x = f / FN
    px = x ** 2 / (1.0 + x ** 4)
    rx_v, xt_v = rx_mv * 1e-3, xt_mv * 1e-3

    best = None
    for g in gdcs:
        for g2 in gdc2s:
            H_rx = H_afe * (ctle_H(f, g, g2) if ctle_on else 1.0)
            p = with_tx(pulse_from_H(H_drv * s21 * H_rx, flight_sec), c)
            lo, hi = max(PRE * OS + 2, (T0 - 4) * OS), min(NFFT - (POST + 2) * OS, (T0 + 16) * OS)
            pi = lo + int(np.argmax(p[lo:hi]))
            r2 = float(np.sum(p[pi + np.arange(-PRE, POST + 1) * OS] ** 2))
            vga = 0.3 / sqrt(EA * r2)
            gg = np.abs(H_rx) ** 2
            th2 = (vga * rx_v / VPK) ** 2 * float(np.sum(gg)) * df / FN
            xt2 = (vga * xt_v / VPK) ** 2 * float(np.sum(px * gg) / np.sum(px))
            for ts in range(pi - OS // 2, pi + OS // 2 + 1, 2):
                idx = ts + np.arange(-PRE, POST + 1) * OS
                h = p[idx] * vga
                slope = (p[idx + 1] - p[idx - 1]) * vga * OS / 2.0
                nz = th2 + xt2 + SIG_ADC ** 2 + EA * float(np.sum(slope ** 2)) * (RJ / UI) ** 2
                _, _, snr, _ = solve_mmse(h, nz, ffe_post, False)
                if best is None or snr > best[0]:
                    best = (snr, g, g2, ts, pi, vga, nz, h)

    _, g, g2, ts, pi, vga, nz, h = best
    w12, _, snr12, _ = solve_mmse(h, nz, 8, False)
    w44, _, snr44, _ = solve_mmse(h, nz, ffe_post, False)
    wd, b1, snrd, _ = solve_mmse(h, nz, ffe_post, True)

    # Identical Monte-Carlo stream as TypeScript
    pad = 64
    n_total = n_sym + 2 * pad
    start, end = pad, pad + n_sym
    rnd = mulberry32(seed)
    gauss = make_normals(seed ^ 0x9E3779B9)
    syms = np.zeros(n_total, dtype=np.int8)
    tx_lv = np.zeros(n_total)
    stx = sqrt(STX2)
    for n in range(n_total):
        s_sym = min(3, int(rnd() * 4))
        syms[n] = s_sym
        tx_lv[n] = LEVELS[s_sym] + gauss() * stx
    y_adc = np.zeros(n_total)
    sig_adc = sqrt(nz)
    for n in range(n_total):
        v = 0.0
        for k in range(-PRE, POST + 1):
            idx = n - k
            if 0 <= idx < n_total:
                v += h[k + PRE] * tx_lv[idx]
        y_adc[n] = v + gauss() * sig_adc

    def apply_ffe(w):
        out = np.zeros(n_total)
        nf = len(w)
        for n in range(start - 4, end + 4):
            s_val = 0.0
            for a in range(nf):
                idx = n - a + NFPRE
                if 0 <= idx < n_total:
                    s_val += w[a] * y_adc[idx]
            out[n] = s_val
        return out

    y_ffe = apply_ffe(w44)
    y_pr1 = apply_ffe(wd)
    dec_ffe = np.zeros(n_total, dtype=np.int8)
    dec_dfe = np.zeros(n_total, dtype=np.int8)
    for n in range(start, end):
        dec_ffe[n] = slice_pam4(y_ffe[n])
        prev = dec_dfe[n - 1] if n > start else syms[n - 1]
        dec_dfe[n] = slice_pam4(y_pr1[n] - b1 * LEVELS[prev])
    dec_mlse = run_viterbi(y_pr1, b1, start, end)

    def err_count(dec):
        return int(np.sum(dec[start:end] != syms[start:end]))

    idx56 = int(np.argmin(np.abs(f - FN)))
    s21_56_db = 20.0 * np.log10(abs(s21[idx56]))
    band = (f >= 4e9) & (f <= 56e9)
    s11_max_db = 20.0 * np.log10(max(1e-6, float(np.max(np.abs(s11[band])))))
    return dict(
        s21_56_db=s21_56_db, s11_max_db=s11_max_db, gdc=g, gdc2=g2,
        snr12_db=10 * np.log10(snr12), snr44_db=10 * np.log10(snr44), snrd_db=10 * np.log10(snrd),
        b1=b1, err_ffe=err_count(dec_ffe), err_dfe=err_count(dec_dfe), err_mlse=err_count(dec_mlse),
    )


# Analytical passivity and bridged T-coil constant-resistance verification
f_check = np.linspace(1e6, 112e9, 200)
s11_tc, s21_tc, s21_p = eval_abcd(f_check, physical_segments(0.0, Z0, Z0, 14.5), 140.0, True)
assert np.max(np.abs(s11_tc)) < 1e-12
assert np.max(np.abs(np.abs(s11_tc) ** 2 + np.abs(s21_p) ** 2 - 1.0)) < 1e-12

print("case s21_56_dB s11_max_dB gdc gdc2 snr12_dB snr44_dB snrd_dB b1 err_ffe err_dfe err_mlse")
CASES = [
    ("matched", 18.0, 50.0, 50.0, 14.5, 140.0, True, True, True, 40, 0.6, 1.2),
    ("tcoil_off", 30.0, 34.0, 72.0, 14.5, 140.0, False, True, True, 40, 0.6, 1.2),
    ("tcoil_on", 30.0, 34.0, 72.0, 14.5, 140.0, True, True, True, 40, 0.6, 1.2),
    ("far_echo", 30.0, 28.0, 78.0, 14.5, 140.0, True, True, True, 40, 0.4, 0.8),
    ("stress_40db", 40.0, 32.0, 74.0, 14.5, 140.0, True, True, True, 40, 0.6, 1.2),
]
for name, *params in CASES:
    r = analyze_case(*params)
    print(
        f"{name} {r['s21_56_db']:.4f} {r['s11_max_db']:.4f} {r['gdc']} {r['gdc2']} "
        f"{r['snr12_db']:.4f} {r['snr44_db']:.4f} {r['snrd_db']:.4f} {r['b1']:.5f} "
        f"{r['err_ffe']} {r['err_dfe']} {r['err_mlse']}"
    )
