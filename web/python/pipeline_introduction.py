"""Ideal radix-4 ADC; verify digits against a direct 6-bit quantizer."""
import math

print('input code digits estimate error_LSB')
for x in [0, .125, .25, .499, .68, .9375, 1]:
    residue, digits = x, []
    for _ in range(3):
        digit = min(3, math.floor(4 * residue))
        digits.append(digit)
        residue = 4 * residue - digit
    code = digits[0] * 16 + digits[1] * 4 + digits[2]
    assert code == min(63, math.floor(x * 64))
    assert abs(x - (code + residue) / 64) < 1e-14
    estimate = (code + .5) / 64
    print(f'{x:.6f} {code} {digits[0]}{digits[1]}{digits[2]} {estimate:.8f} {(estimate-x)*64:.6f}')
