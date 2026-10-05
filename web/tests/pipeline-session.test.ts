import { describe, expect, it } from 'vitest';
import { TOPOLOGIES } from '../src/illustrations/pipeline-intro/configurable';
import { convertWithErrors } from '../src/illustrations/pipeline-intro/errors';
import { initialErrorProfiles, nextRandom, parseReplayHash, replayHash, validateSnapshot, type PipelineSnapshot } from '../src/illustrations/pipeline-intro/session';

function example(): PipelineSnapshot {
  const errorProfiles = initialErrorProfiles();
  for (const topology of TOPOLOGIES) {
    errorProfiles[topology.id] = errorProfiles[topology.id].map((_, stage) => ({
      gainError: stage % 2 ? -0.25 : 0.125,
      nonlinearity: stage % 2 ? 0.005 : -0.25,
    }));
  }
  return { version: 1, topologyId: 'ten', input: 0.683456, errorStage: 8,
    errorProfiles, randomState: 0xFFFFFFFF, mobileView: 'overall' };
}

describe('pipeline replay state', () => {
  it.each(TOPOLOGIES)('restores all errors and the conversion for $id', topology => {
    const original = example();
    original.topologyId = topology.id;
    original.errorStage = topology.bits.length - 2;
    const state = parseReplayHash(replayHash(original))!;
    expect(state).toEqual(original);
    const settings = state.errorProfiles[topology.id].map((errors, stage) => ({ stage, ...errors }));
    expect(convertWithErrors(state.input, topology.bits, settings)).toEqual(convertWithErrors(
      original.input, topology.bits, original.errorProfiles[topology.id].map((errors, stage) => ({ stage, ...errors })),
    ));
    state.errorProfiles[topology.id][0].gainError = 0;
    expect(original.errorProfiles[topology.id][0].gainError).toBe(0.125);
  });

  it('continues the random sequence at the exact saved position', () => {
    let uninterrupted = 49201;
    for (let index = 0; index < 17; index++) uninterrupted = nextRandom(uninterrupted).state;
    const state = example();
    state.randomState = uninterrupted;
    let resumed = parseReplayHash(replayHash(state))!.randomState;
    const sequence: number[] = [];
    for (let index = 0; index < 100; index++) {
      const expected = nextRandom(uninterrupted), actual = nextRandom(resumed);
      expect(actual).toEqual(expected);
      sequence.push(actual.value);
      uninterrupted = expected.state;
      resumed = actual.state;
    }
    expect(new Set(sequence).size).toBe(100);
    expect(sequence.every(value => value >= 0 && value < 1)).toBe(true);
    expect(nextRandom(0)).not.toEqual(nextRandom(1));
  });

  it.each([0, 1])('accepts input endpoint %s and seed zero', input => {
    expect(validateSnapshot({ ...example(), input, randomState: 0 })).not.toBeNull();
  });

  it.each([
    null, [], {}, { version: 2 }, { input: -0.1 }, { input: 1.1 }, { input: NaN },
    { input: Infinity }, { input: '0.5' }, { errorStage: 9 }, { errorStage: 0.5 },
    { topologyId: 'unknown' }, { randomState: -1 }, { randomState: 0x100000000 },
    { randomState: 0.1 }, { mobileView: 'unknown' }, { errorProfiles: {} },
  ])('rejects malformed or unsupported state %j', invalid => {
    const candidate = invalid && !Array.isArray(invalid) ? { ...example(), ...invalid } : invalid;
    // {} alone is also invalid; do not merge it into a valid snapshot.
    expect(validateSnapshot(invalid && Object.keys(invalid).length ? candidate : invalid)).toBeNull();
  });

  it('rejects out-of-range errors or the wrong number of amplifiers in any architecture', () => {
    for (const topology of TOPOLOGIES) {
      const state = example();
      state.errorProfiles[topology.id][0].gainError = 0.251;
      expect(validateSnapshot(state)).toBeNull();
      state.errorProfiles[topology.id][0].gainError = 0;
      state.errorProfiles[topology.id][0].nonlinearity = -0.251;
      expect(validateSnapshot(state)).toBeNull();
      state.errorProfiles[topology.id] = [];
      expect(validateSnapshot(state)).toBeNull();
    }
  });

  it.each(['', '#elsewhere', '#pipeline=%zz', '#pipeline=null', '#pipeline=%7B', '#pipeline=' + 'x'.repeat(12000)])(
    'ignores invalid URL state without throwing', hash => expect(parseReplayHash(hash)).toBeNull(),
  );
});
