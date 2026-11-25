// Deterministic traffic-signal timing shared by renderer and traffic AI (no network sync needed).
import { hashInt } from '../math';

export const SIGNAL_CYCLE = 30;
/** 0 = red, 1 = yellow, 2 = green for the given phase group (0 or 1) of a junction. */
export function signalColor(nodeId: number, phase: number, time: number): 0 | 1 | 2 {
  const off = (hashInt(nodeId * 7919) % 300) / 10;
  let t = (time + off + phase * (SIGNAL_CYCLE / 2)) % SIGNAL_CYCLE;
  if (t < 0) t += SIGNAL_CYCLE;
  if (t < 11.5) return 2;
  if (t < 14) return 1;
  return 0;
}
