#!/usr/bin/env python3
"""Reference numbers for the lesson on how much training a calibration needs, computed with ADCToolbox.

    python -m pip install -r python/requirements.txt
    python3 python/adc_training_length.py

The lesson ports these ADCToolbox functions to TypeScript, and tests/training-model.test.ts checks the port against
the numbers printed here:
  models/sar.py          sar_apply_cap_mismatch, sar_convert, sar_reconstruct
  calibration/           calibrate_weight_sine
  spectrum/              quick_sndr, and analyze_spectrum for the before and after spectra
following the examples exp_d18 (a training-length sweep under cap mismatch), exp_d16 (the same mismatch model, binary
against redundant) and exp_d01 (calibrate and compare the spectra).

The mismatch and the phases come from the same deterministic generator as the lesson, mulberry32 through Box-Muller,
so both sides measure exactly the same chips.
"""
import contextlib
import io
import math
import warnings

import numpy as np
from adctoolbox import analyze_spectrum, calibrate_weight_sine, quick_sndr, sar_apply_cap_mismatch, sar_convert

# exp_d18's radix-1.8 array: eighteen weights spanning sixteen bits, so five of them are redundant
RAW = np.array([29127, 16182, 8990, 4995, 2775, 1542, 856, 476, 264, 147, 82, 45, 25, 14, 8, 4, 2, 1], float)
REDUNDANT = RAW / (RAW.sum() + RAW[-1])
BINARY = np.array([2.0 ** -(i + 1) for i in range(16)])
ARRAYS = {"redundant": REDUNDANT, "binary": BINARY}

N_TEST, TEST_BIN = 4096, 445
TRAIN_RATIO = 997 / 16384
AMP, DC = 0.499, 0.5
SIGMA = 0.01
TRIALS = 8
SEED = 20260525
# 24 samples is left out: with strict binary weights the fit there is singular, and what comes back is the
# solver's opinion rather than the converter's — numpy's least squares and the site's Cholesky disagree by 0.04 bits
LENGTHS = [32, 48, 64, 96, 128, 256, 512, 1024, 2048, 4096]


def gaussians(count, seed):
    """The standard normals of src/lib/rng.ts: mulberry32 uniforms through Box-Muller, in 32-bit unsigned arithmetic."""
    imul = lambda a, b: (a * b) & 0xFFFFFFFF
    state = seed & 0xFFFFFFFF

    def rnd():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = imul(state ^ (state >> 15), state | 1)
        t ^= (t + imul(t ^ (t >> 7), t | 61)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 2 ** 32

    out = np.zeros(count)
    for i in range(0, count, 2):
        r = math.sqrt(-2 * math.log(rnd() or 1e-12))
        u2 = rnd()
        out[i] = r * math.cos(2 * math.pi * u2)
        if i + 1 < count:
            out[i + 1] = r * math.sin(2 * math.pi * u2)
    return out


class Normals:
    """Just enough of a numpy Generator for sar_apply_cap_mismatch: the lesson's own normals, in order."""

    def __init__(self, values):
        self.values = values
        self.at = 0

    def standard_normal(self, count):
        out = self.values[self.at:self.at + count]
        self.at += count
        return out


def chip(nominal, trial, sigma=SIGMA):
    """One converter: every capacitor off by its own share of sigma / sqrt(units), the same chip for every length."""
    return sar_apply_cap_mismatch(nominal, sigma=sigma, rng=Normals(gaussians(len(nominal), SEED + trial)))


def phase_of(trial, n_train=0):
    """A starting phase per capture, so no two captures sample the same points."""
    return 2 * math.pi * (gaussians(2, SEED + 7919 * trial + n_train)[0] % 1)


def train_bin(n):
    """exp_d18's training bin: odd, coprime with the record, near the same fraction of fs at every length."""
    b = max(1, min(int(round(TRAIN_RATIO * n)), n // 2 - 1))
    if b % 2 == 0:
        b += 1 if b + 1 < n // 2 else -1
    while math.gcd(n, b) != 1 and b + 2 < n // 2:
        b += 2
    return b


def sine(n, bin_index, phase):
    return DC + AMP * np.sin(2 * np.pi * bin_index * np.arange(n) / n + phase)


def enob_of(trace):
    centred = trace - np.mean(trace)
    with contextlib.redirect_stdout(io.StringIO()):
        return quick_sndr(centred, fs=1.0, win_type="rectangular")["enob"]


def calibrate(bits, freq, nominal):
    with contextlib.redirect_stdout(io.StringIO()):
        return np.asarray(calibrate_weight_sine(bits, freq=freq, nominal_weights=nominal)["weight"], float)


def row(values, fmt):
    return " ".join(format(v, fmt) for v in values)


def own_row(values):
    # An exact overfit on a 32-sample training capture leaves residual power at float64 machine precision (~1e-30),
    # where LAPACK SVD rounding differs by ~0.1 bits across macOS Accelerate and Linux OpenBLAS.
    return " ".join(f"{'>25':>8s}" if v > 25.0 else f"{v:8.4f}" for v in values)


if __name__ == "__main__":
    warnings.simplefilter("ignore")
    print(f"a 16-bit SAR read {N_TEST} samples at bin {TEST_BIN}, its capacitors {SIGMA * 100:g} % off per unit, "
          f"{TRIALS} chips, calibrated from a shorter capture of its own")
    print(f"  redundant weights, 18 of them: {row(REDUNDANT[:6], '.9f')} ...")
    print(f"  binary weights, 16 of them:    {row(BINARY[:6], '.9f')} ...")
    print(f"  chip 0's redundant array, as built: {row(chip(REDUNDANT, 0)[:6], '.9f')} ...")
    print(f"  training bins: " + row([train_bin(n) for n in LENGTHS], "5d"))
    print()

    for name, nominal in ARRAYS.items():
        print(f"[{name}: training length, then the calibrated ENOB on a capture it has never seen — "
              f"min, median, max over {TRIALS} chips — then the same weights on the training capture itself]")
        chips = [chip(nominal, t) for t in range(TRIALS)]
        tests = [sar_convert(sine(N_TEST, TEST_BIN, phase_of(t)), w) for t, w in enumerate(chips)]
        raw = [enob_of(b @ nominal) for b in tests]
        print(f"  uncalibrated: " + row(sorted(raw)[:1] + [float(np.median(raw))] + sorted(raw)[-1:], "8.4f"))
        for n in LENGTHS:
            b = train_bin(n)
            out, own = [], []
            for t, w in enumerate(chips):
                bits = sar_convert(sine(n, b, phase_of(t, n)), w)
                cal = calibrate(bits, b / n, nominal)
                out.append(enob_of(tests[t] @ cal))
                own.append(enob_of(bits @ cal))
            print(f"  {n:6d} " + row([np.min(out), np.median(out), np.max(out)], "8.4f")
                  + "   " + own_row([np.min(own), np.median(own), np.max(own)]))
        print()

    print("[chip 0 of the redundant array, before and after a calibration trained on 128 samples]")
    w0 = chip(REDUNDANT, 0)
    bits_test = sar_convert(sine(N_TEST, TEST_BIN, phase_of(0)), w0)
    b128 = train_bin(128)
    cal = calibrate(sar_convert(sine(128, b128, phase_of(0, 128)), w0), b128 / 128, REDUNDANT)
    for label, weights in (("nominal", REDUNDANT), ("calibrated", cal)):
        trace = bits_test @ weights
        with contextlib.redirect_stdout(io.StringIO()):
            s = analyze_spectrum(trace - trace.mean(), fs=1.0, win_type="rectangular", side_bin=0, max_harmonic=5,
                                 nf_method=3, create_plot=False)
        print(f"  {label:11s} SNDR {s['sndr_dbc']:9.4f}, SFDR {s['sfdr_dbc']:9.4f}, ENOB {s['enob']:8.4f}")
    print(f"  the array as built, as a share of nominal: {row(w0[:8] / REDUNDANT[:8], '.9f')} ...")
    print(f"  what the calibration recovered, rescaled:  {row((cal[:8] / cal.sum()) / (REDUNDANT[:8] / REDUNDANT.sum()), '.9f')} ...")
    print(f"  trace at 0 ... 3: {row((bits_test @ REDUNDANT)[:4], '.9f')}")
