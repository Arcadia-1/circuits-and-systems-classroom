"""Independent fine-step RK4 reference for the averaged PLL lesson; time is in microseconds."""
import math
import numpy as np


def run(closed=True, integral=True, damping=.707, divider=4, kick=False):
    ref, free, kvco, dt = 10., 36., 12., .002
    wn, k = 2 * np.pi * .15, 2 * np.pi * kvco / divider
    kp, ki = 2 * damping * wn / k, wn * wn / k
    state = np.array([np.pi / 4, 0.])

    def values(z):
        requested = kp * z[0] + (z[1] if integral else 0) if closed else 0
        v = np.clip(requested, -1, 1)
        return requested, v, max(.1, free + kvco * v)

    def derivative(z):
        requested, v, freq = values(z)
        blocked = abs(requested) > 1 and z[0] * v > 0
        return np.array([2 * np.pi * (ref - freq / divider), ki * z[0] if closed and integral and not blocked else 0])

    for i in range(round(24 / dt)):
        if kick and i == round(10 / dt):
            state[0] += np.pi / 4
        a = derivative(state)
        b = derivative(state + dt * a / 2)
        c = derivative(state + dt * b / 2)
        d = derivative(state + dt * c)
        state += dt * (a + 2 * b + 2 * c + d) / 6
    _, voltage, frequency = values(state)
    return frequency, state[0], voltage


print('case frequency_MHz error_rad control_V')
for name, args in [('lock', {}), ('p_only', dict(integral=False)), ('ringing', dict(damping=.2)),
                   ('phase_step', dict(kick=True)), ('unreachable', dict(divider=6)), ('open', dict(closed=False))]:
    print(name, *(f'{v:.6f}' for v in run(**args)))

# Linear type-I equilibrium follows directly from e_dot = 0, rather than the solver.
k = 2 * math.pi * 12 / 4
kp = 2 * .707 * (2 * math.pi * .15) / k
assert abs(run(integral=False)[1] - (40 - 36) / (12 * kp)) < 1e-10
