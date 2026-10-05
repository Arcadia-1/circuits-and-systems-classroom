import { TOPOLOGIES, type PipelineTopology } from './configurable';

export const ERROR_LIMIT = 0.25;
export const ERROR_STEP = 0.005;
export type StageErrors = { gainError: number; nonlinearity: number };
export type ErrorProfiles = Record<PipelineTopology['id'], StageErrors[]>;
export interface PipelineSnapshot {
  version: 1;
  topologyId: PipelineTopology['id'];
  input: number;
  errorStage: number;
  errorProfiles: ErrorProfiles;
  /** Mulberry32 state immediately before the next random draw. */
  randomState: number;
  mobileView: 'stages' | 'overall';
}

export function initialErrorProfiles(): ErrorProfiles {
  return Object.fromEntries(TOPOLOGIES.map(topology => [topology.id,
    topology.bits.slice(0, -1).map((_, stage) => ({ gainError: stage === 0 ? 0.1 : 0, nonlinearity: 0 })),
  ])) as ErrorProfiles;
}

/** Explicit state makes the next Random action reproducible after reloading. */
export function nextRandom(state: number): { state: number; value: number } {
  const next = (state + 0x6D2B79F5) >>> 0;
  let value = Math.imul(next ^ (next >>> 15), next | 1);
  value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
  return { state: next, value: ((value ^ (value >>> 14)) >>> 0) / 4294967296 };
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const finiteIn = (value: unknown, low: number, high: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= low && value <= high;

/** Validate every architecture before applying any replay state to the model. */
export function validateSnapshot(value: unknown): PipelineSnapshot | null {
  if (!record(value) || value.version !== 1) return null;
  const topology = TOPOLOGIES.find(candidate => candidate.id === value.topologyId);
  if (!topology || !finiteIn(value.input, 0, 1) ||
    !finiteIn(value.errorStage, 0, topology.bits.length - 2) || !Number.isInteger(value.errorStage) ||
    !finiteIn(value.randomState, 0, 0xFFFFFFFF) || !Number.isInteger(value.randomState) ||
    (value.mobileView !== 'stages' && value.mobileView !== 'overall') || !record(value.errorProfiles)) return null;

  const profiles = initialErrorProfiles();
  for (const candidate of TOPOLOGIES) {
    const errors = value.errorProfiles[candidate.id];
    if (!Array.isArray(errors) || errors.length !== candidate.bits.length - 1) return null;
    const validated: StageErrors[] = [];
    for (const error of errors) {
      if (!record(error) || !finiteIn(error.gainError, -ERROR_LIMIT, ERROR_LIMIT) ||
        !finiteIn(error.nonlinearity, -ERROR_LIMIT, ERROR_LIMIT)) return null;
      validated.push({ gainError: error.gainError, nonlinearity: error.nonlinearity });
    }
    profiles[candidate.id] = validated;
  }
  return { version: 1, topologyId: topology.id, input: value.input, errorStage: value.errorStage,
    errorProfiles: profiles, randomState: value.randomState, mobileView: value.mobileView };
}

export function replayHash(snapshot: PipelineSnapshot): string {
  const validated = validateSnapshot(snapshot);
  if (!validated) throw new Error('Invalid pipeline state.');
  return `#pipeline=${encodeURIComponent(JSON.stringify(validated))}`;
}

export function parseReplayHash(hash: string): PipelineSnapshot | null {
  if (!hash.startsWith('#pipeline=') || hash.length > 12000) return null;
  try { return validateSnapshot(JSON.parse(decodeURIComponent(hash.slice('#pipeline='.length)))); }
  catch { return null; }
}
