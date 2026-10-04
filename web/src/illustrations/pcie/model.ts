/**
 * PCI Express by the numbers: the per-lane rate and line code of each generation, what a transaction-layer packet (TLP)
 * costs on the wire, and one direction of a link simulated packet by packet, with ACK/NAK replay, a replay timer and
 * credit-based flow control. Times are in ns, sizes in bytes. python/serdes_pcie.py is the executable reference.
 */

export type LineCode = '8b/10b' | '128b/130b' | 'flit';

export interface Generation {
  gen: number;
  /** Gigatransfers per second on each lane: bits per ns, two bits per symbol from generation 6 on (PAM4). */
  gts: number;
  year: number;
  code: LineCode;
}

export const GENERATIONS: readonly Generation[] = [
  { gen: 1, gts: 2.5, year: 2003, code: '8b/10b' },
  { gen: 2, gts: 5, year: 2007, code: '8b/10b' },
  { gen: 3, gts: 8, year: 2010, code: '128b/130b' },
  { gen: 4, gts: 16, year: 2017, code: '128b/130b' },
  { gen: 5, gts: 32, year: 2019, code: '128b/130b' },
  { gen: 6, gts: 64, year: 2022, code: 'flit' },
  { gen: 7, gts: 128, year: 2025, code: 'flit' },
];

export const generation = (gen: number): Generation => GENERATIONS[Math.min(GENERATIONS.length, Math.max(1, gen)) - 1];

/** Framing token, sequence number and LCRC around every TLP before flit mode. */
export const TLP_WRAP = 8;
/** A flit is 256 bytes: 236 of TLPs, 6 of link-layer messages, 8 of CRC and 6 of FEC. */
export const FLIT = 256;
export const FLIT_TLP = 236;
export const FLIT_LINK = 242;

/** Share of the line rate left for packets: 8 of every 10 bits, 128 of 130, or 242 of the 256 bytes of a flit. */
export function codeEfficiency(code: LineCode): number {
  return code === '8b/10b' ? 0.8 : code === '128b/130b' ? 128 / 130 : FLIT_LINK / FLIT;
}

/** GB/s in each direction once the line code (or the flit's CRC and FEC) is paid. */
export function linkGBps(g: Generation, lanes: number): number {
  return (lanes * g.gts * codeEfficiency(g.code)) / 8;
}

/** Bytes one TLP occupies: header and payload, plus framing, sequence number and LCRC unless the flit carries them. */
export function wireBytes(g: Generation, payload: number, header: number): number {
  return header + payload + (g.code === 'flit' ? 0 : TLP_WRAP);
}

/** Share of the raw line rate that is payload. */
export function payloadShare(g: Generation, payload: number, header: number): number {
  const forPackets = g.code === 'flit' ? FLIT_TLP / FLIT : codeEfficiency(g.code);
  return (payload / wireBytes(g, payload, header)) * forPackets;
}

export function payloadGBps(g: Generation, lanes: number, payload: number, header: number): number {
  return ((lanes * g.gts) / 8) * payloadShare(g, payload, header);
}

/** Amortized ns per TLP in a continuous, densely packed stream; FLITs may contain multiple TLPs. */
export function tlpNs(g: Generation, lanes: number, payload: number, header: number): number {
  const forPackets = g.code === 'flit' ? FLIT_TLP / FLIT : codeEfficiency(g.code);
  return (wireBytes(g, payload, header) * 8) / (lanes * g.gts * forPackets);
}

/** Serialization of a TLP starting in an empty FLIT, including padding of its last FLIT.
 * Excludes scheduling, optional headers, SKP ordered sets and receiver latency. */
export function isolatedTlpNs(g: Generation, lanes: number, payload: number, header: number): number {
  return g.code === 'flit'
    ? Math.ceil((payload + header) / FLIT_TLP) * FLIT * 8 / (lanes * g.gts)
    : tlpNs(g, lanes, payload, header);
}

/** Byte k of a packet goes to lane k mod lanes, in the k div lanes-th byte time: dealt out like cards. */
export const stripe = (k: number, lanes: number): { lane: number; slot: number } => ({ lane: k % lanes, slot: Math.floor(k / lanes) });

export interface LinkParams {
  /** Time to send one TLP, time from its last byte to the receiver's check (and for a message back), and the time the
   * device needs per TLP before its buffer slot is free again. */
  tlpNs: number;
  latencyNs: number;
  drainNs: number;
  /** Receive-buffer slots the device advertises, one TLP each. */
  credits: number;
}

/** What the receiver did with a transmission; pending when it had not arrived by the horizon. */
export type Fate = 'accepted' | 'corrupt' | 'dropped' | 'pending';

export interface Send {
  seq: number;
  start: number;
  end: number;
  arrive: number;
  replay: boolean;
  corrupt: boolean;
  fate: Fate;
}

export interface Dllp {
  kind: 'ack' | 'nak' | 'credit';
  seq: number;
  sent: number;
  arrive: number;
}

export interface LinkRun {
  /** Every transmission in the order it started, and every message sent back, in the order it left. */
  sends: Send[];
  dllps: Dllp[];
  /** Per sequence number: when the device accepted it, when its buffer slot was free again, and when the sender
   * dropped its copy. Released and accepted times never decrease with the sequence number. */
  accepted: number[];
  drained: number[];
  released: number[];
  /** First transmissions only, as start times, in sequence order. */
  firstStart: number[];
  horizon: number;
}

/** Replay timer: some multiple of the round trip, as in the spec's REPLAY_TIMER limit. */
export const replayTimeout = (p: LinkParams): number => 3 * (p.tlpNs + 2 * p.latencyNs);

interface Event {
  t: number;
  n: number;
  kind: 'send' | 'arrive' | 'drain' | 'credit' | 'ack' | 'nak' | 'timer';
  x: number;
}

/**
 * One direction of a link, event by event up to `horizon`. The sender spends a credit on every new TLP and keeps a copy
 * until it is acknowledged; the receiver accepts TLPs in sequence, acknowledges each, and answers a bad or out-of-order
 * one with a single NAK, after which the sender resends every unacknowledged TLP. `corrupt` lists transmissions (by
 * their index in `sends`) that arrive damaged. Ties in time go in the order the events were scheduled.
 */
export function simulateLink(p: LinkParams, horizon: number, corrupt: readonly number[] = []): LinkRun {
  const bad = new Set(corrupt);
  const sends: Send[] = [], dllps: Dllp[] = [], accepted: number[] = [], drained: number[] = [], released: number[] = [], firstStart: number[] = [];
  const queue: Event[] = [];
  let count = 0;
  const push = (t: number, kind: Event['kind'], x = 0) => {
    const n = count++;
    let lo = 0, hi = queue.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (queue[mid].t < t || (queue[mid].t === t && queue[mid].n < n)) lo = mid + 1;
      else hi = mid;
    }
    queue.splice(lo, 0, { t, n, kind, x });
  };
  const timeout = replayTimeout(p);
  let credits = p.credits, nextSeq = 0, linkFree = 0, expected = 0, nakPending = false, deviceFree = 0, timer = 0, timing = false;
  const unacked: number[] = [];
  let resend: number[] = [];
  const arm = (t: number) => {
    timing = true;
    push(t + timeout, 'timer', ++timer);
  };
  const release = (upTo: number, t: number) => {
    let freed = false;
    while (unacked.length && unacked[0] <= upTo) {
      released[unacked.shift() as number] = t;
      freed = true;
    }
    if (!freed) return;
    if (unacked.length) arm(t);
    else {
      timing = false;
      timer++;
    }
  };
  const reply = (kind: Dllp['kind'], seq: number, t: number) => {
    dllps.push({ kind, seq, sent: t, arrive: t + p.latencyNs });
    push(t + p.latencyNs, kind, seq);
  };
  const replayAll = (t: number) => {
    resend = unacked.slice();
    if (linkFree <= t) push(t, 'send');
  };
  push(0, 'send');
  while (queue.length && queue[0].t <= horizon) {
    const { t, kind, x } = queue.shift() as Event;
    if (kind === 'send') {
      if (t < linkFree) continue;
      let seq: number, again = false;
      while (resend.length && released[resend[0]] !== undefined) resend.shift();
      if (resend.length) {
        seq = resend.shift() as number;
        again = true;
      } else if (credits > 0) {
        seq = nextSeq++;
        credits--;
        unacked.push(seq);
        firstStart.push(t);
      } else continue;
      const i = sends.length, end = t + p.tlpNs;
      sends.push({ seq, start: t, end, arrive: end + p.latencyNs, replay: again, corrupt: bad.has(i), fate: 'pending' });
      push(end + p.latencyNs, 'arrive', i);
      linkFree = end;
      push(end, 'send');
      if (!timing) arm(end);
    } else if (kind === 'arrive') {
      const s = sends[x];
      if (!s.corrupt && s.seq === expected) {
        s.fate = 'accepted';
        expected++;
        nakPending = false;
        accepted[s.seq] = t;
        reply('ack', s.seq, t);
        deviceFree = Math.max(deviceFree, t) + p.drainNs;
        push(deviceFree, 'drain', s.seq);
      } else if (!s.corrupt && s.seq < expected) {
        // a copy of one already taken: acknowledge again so the sender can let go
        s.fate = 'dropped';
        reply('ack', expected - 1, t);
      } else {
        s.fate = s.corrupt ? 'corrupt' : 'dropped';
        if (!nakPending) {
          nakPending = true;
          reply('nak', expected - 1, t);
        }
      }
    } else if (kind === 'drain') {
      drained[x] = t;
      reply('credit', x, t);
    } else if (kind === 'credit') {
      credits++;
      if (linkFree <= t) push(t, 'send');
    } else if (kind === 'ack') {
      release(x, t);
    } else if (kind === 'nak') {
      release(x, t);
      replayAll(t);
      arm(t);
    } else if (x === timer && unacked.length) {
      // no word from the receiver for too long: resend everything still unacknowledged
      replayAll(t);
      arm(t);
    }
  }
  return { sends, dllps, accepted, drained, released, firstStart, horizon };
}

/** Payload share of the link the credits allow when nothing goes wrong: a credit comes back one loop after it was spent. */
export function creditLimit(p: LinkParams): number {
  const loop = p.tlpNs + 2 * p.latencyNs + p.drainNs;
  return Math.min(1, (p.credits * p.tlpNs) / loop, p.drainNs > 0 ? p.tlpNs / p.drainNs : 1);
}

/** TLPs accepted per TLP time between t0 and t1: 1 is a link that never idles. */
export function measuredShare(run: LinkRun, p: LinkParams, t0: number, t1: number): number {
  let k = 0;
  for (const a of run.accepted) if (a !== undefined && a > t0 && a <= t1) k++;
  return (k * p.tlpNs) / (t1 - t0);
}
