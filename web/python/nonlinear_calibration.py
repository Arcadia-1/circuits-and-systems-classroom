"""Known-ramp inverse using NumPy lstsq, validated on independent coherent data and NumPy rfft."""
import math
import numpy as np


def normals(n, seed):
    state = seed

    def rnd():
        nonlocal state
        state = (state + 0x6D2B79F5) & 0xFFFFFFFF
        t = ((state ^ (state >> 15)) * (state | 1)) & 0xFFFFFFFF
        t ^= (t + (((t ^ (t >> 7)) * (t | 61)) & 0xFFFFFFFF)) & 0xFFFFFFFF
        return ((t ^ (t >> 14)) & 0xFFFFFFFF) / 4294967296
    output = []
    while len(output) < n:
        r = math.sqrt(-2 * math.log(rnd() or 1e-12))
        a = 2 * math.pi * rnd()
        output.extend([r * math.cos(a), r * math.sin(a)])
    return np.array(output[:n])


def measure(y, x):
    power = 4 * abs(np.fft.rfft(y - np.mean(y))) ** 2 / len(y) ** 2
    power[[0, -1]] /= 2
    signal = power[53]
    noise = np.sum(np.delete(power, [0, 53]))
    return 10 * np.log10(signal / noise), np.sqrt(np.mean((y-x)**2)) * 1000


def run(a2=.06, a3=-.16, noise=.3, coverage=.95, degree=5):
    def adc(x, g):
        y = x + a2 * x*x + a3 * x*x*x + g * noise / 1000
        return np.clip(np.floor(y * 2048 + .5), -2048, 2047) / 2048
    x = np.linspace(-coverage, coverage, 512)
    y = adc(x, normals(len(x), 71))
    scale = max(np.max(abs(y)), .01)
    coefficients = np.linalg.lstsq(np.vander(y/scale, degree+1, increasing=True), x, rcond=None)[0]
    xv = .85 * np.sin(2*np.pi*53*np.arange(2048)/2048+.37)
    raw = adc(xv, normals(len(xv), 903))
    calibrated = np.polynomial.polynomial.polyval(raw/scale, coefficients)
    return (*measure(raw, xv), *measure(calibrated, xv), int(np.sum((raw == -1) | (raw == 2047/2048))))


print('case raw_SNDR raw_RMS_mV calibrated_SNDR calibrated_RMS_mV clipped')
for name, args in [('smooth', {}), ('linear_only', dict(degree=1)), ('narrow', dict(coverage=.35)),
                   ('clipping', dict(a2=.08, a3=.35)), ('noise', dict(noise=3))]:
    *metrics, clipped = run(**args)
    print(name, *(f'{v:.6f}' for v in metrics), clipped)
