"""Independent reference for the normalized 1.5-bit/stage pipeline lesson."""

THRESHOLD = 0.25


def simulate(x: float, stages: int):
    residue = max(-1.0, min(1.0, x))
    decisions = []
    for _ in range(stages):
        d = -1 if residue < -THRESHOLD else 1 if residue > THRESHOLD else 0
        decisions.append(d)
        residue = 2 * residue - d
    coarse = sum(d / 2 ** (i + 1) for i, d in enumerate(decisions))
    reconstructed = coarse + residue / 2 ** stages
    code = max(0, min(2 ** stages - 1, int(((reconstructed + 1) / 2) * 2 ** stages)))
    return decisions, residue, reconstructed, code


print('input stages decisions final_residue reconstructed code')
for x, stages in [(-0.75, 3), (-0.25, 4), (0.0, 5), (0.37, 4), (0.81, 3)]:
    decisions, residue, reconstructed, code = simulate(x, stages)
    print(f'{x:.2f} {stages} {",".join(map(str, decisions))} {residue:.9f} {reconstructed:.9f} {code}')

