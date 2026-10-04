import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { GENERATIONS, isolatedTlpNs, creditLimit, generation, linkGBps, measuredShare, payloadShare, simulateLink, stripe, tlpNs, type LinkParams } from '../src/illustrations/pcie/model';

const reference = readFileSync(new URL('../python/expected/serdes_pcie.txt', import.meta.url), 'utf8').trim().split('\n');
const rows = (header: string) => {
  const start = reference.findIndex((l) => l.startsWith(header)) + 1;
  const out: string[][] = [];
  for (let i = start; i < reference.length && /^[\d.]+ /.test(reference[i]); i++) out.push(reference[i].split(/\s+/));
  return out;
};
const params = (gen: number, lanes: number, payload: number, header: number, latencyNs: number, drainNs: number, credits: number): LinkParams => ({
  tlpNs: tlpNs(generation(gen), lanes, payload, header), latencyNs, drainNs, credits,
});
const BASE = params(3, 4, 256, 16, 100, 40, 8);

describe('PCIe numbers', () => {
  it('separates densely packed throughput from whole-FLIT serialization', () => {
    const g = generation(6);
    expect(g.gts * 16 / 8).toBe(128);
    expect(linkGBps(g, 16)).toBe(121);
    expect(isolatedTlpNs(g, 16, 16, 16)).toBe(2);
    expect(isolatedTlpNs(g, 16, 256, 16)).toBe(4);
    expect(tlpNs(g, 16, 256, 16)).toBeLessThan(4);
    expect(isolatedTlpNs(generation(3), 4, 256, 16)).toBe(tlpNs(generation(3), 4, 256, 16));
  });
  it('matches the reference rates of every generation', () => {
    const table = rows('gen GT/s');
    expect(table).toHaveLength(GENERATIONS.length);
    table.forEach(([gen, , , perLane, x16], i) => {
      expect(GENERATIONS[i].gen).toBe(Number(gen));
      expect(linkGBps(GENERATIONS[i], 1)).toBeCloseTo(Number(perLane), 5);
      expect(linkGBps(GENERATIONS[i], 16)).toBeCloseTo(Number(x16), 5);
    });
  });

  it('gives the familiar x16 figures', () => {
    expect(linkGBps(generation(1), 1)).toBeCloseTo(0.25, 9);
    expect(linkGBps(generation(3), 16)).toBeCloseTo(15.754, 3);
    expect(linkGBps(generation(5), 16)).toBeCloseTo(63.015, 3);
    expect(linkGBps(generation(6), 16)).toBeCloseTo(121, 9);
  });

  it('matches the reference payload share of a TLP', () => {
    for (const [payload, g3h3, g3h4, g6h4] of rows('payload share')) {
      const p = Number(payload);
      expect(payloadShare(generation(3), p, 12)).toBeCloseTo(Number(g3h3), 5);
      expect(payloadShare(generation(3), p, 16)).toBeCloseTo(Number(g3h4), 5);
      expect(payloadShare(generation(6), p, 16)).toBeCloseTo(Number(g6h4), 5);
    }
    const line = reference.find((l) => l.startsWith('tlp_ns gen3_x4_256B')) as string;
    expect(BASE.tlpNs).toBeCloseTo(Number(line.split(' ')[2]), 6);
  });

  it('deals bytes across the lanes like cards', () => {
    expect([0, 1, 2, 3, 4, 5].map((k) => stripe(k, 4))).toEqual([
      { lane: 0, slot: 0 }, { lane: 1, slot: 0 }, { lane: 2, slot: 0 }, { lane: 3, slot: 0 }, { lane: 0, slot: 1 }, { lane: 1, slot: 1 },
    ]);
  });
});

describe('PCIe link simulation', () => {
  it('matches the reference throughput for every number of credits', () => {
    for (const [credits, limit, measured] of rows('credits limit measured')) {
      const p = { ...BASE, credits: Number(credits) };
      const run = simulateLink(p, 20000);
      expect(creditLimit(p)).toBeCloseTo(Number(limit), 5);
      expect(measuredShare(run, p, 5000, 20000)).toBeCloseTo(Number(measured), 5);
    }
  });

  it('matches the reference replays, acknowledgements and credits', () => {
    const cases: Record<string, [LinkParams, number[]]> = {
      clean: [BASE, []],
      one_error: [BASE, [10]],
      error_in_replay: [BASE, [10, 16]],
      two_errors: [BASE, [10, 40]],
      x16_gen5: [params(5, 16, 256, 16, 100, 4, 32), [50]],
    };
    const start = reference.findIndex((l) => l.startsWith('case sends')) + 1;
    for (const line of reference.slice(start)) {
      const [name, sends, replays, accepted, acks, naks, credits, last] = line.split(' ');
      const [p, corrupt] = cases[name];
      const run = simulateLink(p, 4000, corrupt);
      const count = (k: string) => run.dllps.filter((d) => d.kind === k).length;
      const got = run.accepted.filter((a) => a !== undefined);
      expect([run.sends.length, run.sends.filter((s) => s.replay).length, got.length, count('ack'), count('nak'), count('credit')], name).toEqual(
        [sends, replays, accepted, acks, naks, credits].map(Number),
      );
      expect(Math.max(...got)).toBeCloseTo(Number(last), 5);
    }
  });

  it('resends from the damaged packet on and never delivers out of order', () => {
    const run = simulateLink(BASE, 4000, [10]);
    const hit = run.sends[10];
    expect(hit.fate).toBe('corrupt');
    // everything sent after it until the NAK arrives is dropped, then resent in order
    const again = run.sends.filter((s) => s.replay).map((s) => s.seq);
    expect(again[0]).toBe(hit.seq);
    expect(again).toEqual(again.map((_, i) => hit.seq + i));
    const order = run.accepted.map((a, seq) => ({ a, seq })).filter((x) => x.a !== undefined).sort((x, y) => x.a - y.a).map((x) => x.seq);
    expect(order).toEqual(order.map((_, i) => i));
    expect(run.dllps.filter((d) => d.kind === 'nak')).toHaveLength(1);
  });

  it('recovers through the replay timer when the resend is damaged too', () => {
    const first = simulateLink(BASE, 4000, [10]);
    const resend = first.sends.findIndex((s) => s.replay);
    const run = simulateLink(BASE, 4000, [10, resend]);
    expect(run.sends[resend].fate).toBe('corrupt');
    expect(run.accepted[run.sends[10].seq]).toBeGreaterThan(first.accepted[first.sends[10].seq]);
    expect(run.accepted.filter((a) => a !== undefined).length).toBeGreaterThan(20);
  });

  it('idles the link when the credits cannot cover the round trip', () => {
    const loop = BASE.tlpNs + 2 * BASE.latencyNs + BASE.drainNs;
    const needed = Math.ceil(loop / BASE.tlpNs);
    expect(creditLimit({ ...BASE, credits: needed })).toBe(1);
    expect(creditLimit({ ...BASE, credits: 2 })).toBeCloseTo((2 * BASE.tlpNs) / loop, 12);
    const starved = simulateLink({ ...BASE, credits: 2 }, 20000);
    expect(measuredShare(starved, { ...BASE, credits: 2 }, 5000, 20000)).toBeLessThan(0.5);
    // with a single credit only one TLP is ever in the device's hands or on its way
    const one = simulateLink({ ...BASE, credits: 1 }, 5000);
    for (let s = 1; s < one.firstStart.length; s++) expect(one.firstStart[s]).toBeGreaterThanOrEqual(one.drained[s - 1] + BASE.latencyNs - 1e-9);
  });
});

describe('PCIe lesson registration', () => {
  it('is a public SerDes lesson with its own thumbnail', async () => {
    const { featuredLessons } = await import('../src/data/illustrations');
    const { isLessonPath, isPublicLessonPath } = await import('../src/data/publication');
    const path = '/serdes/pci-express/';
    expect(isLessonPath(path)).toBe(true);
    expect(isPublicLessonPath(path)).toBe(true);
    expect(featuredLessons.find((x) => x.href === path)).toMatchObject({ category: 'SerDes', thumb: 'pcie' });
  });
});
