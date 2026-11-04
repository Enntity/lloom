// SPDX-License-Identifier: MIT
import { integer, requireThat } from './common.mjs';

export const defaultWindowMs = 3600000;
export const maxWindowMs = 30 * 86400000;
export const windowCapability = 'reservation-windows-v1';

export function windowDuration(body) {
  requireThat(body.durationMs === undefined || body.leaseMs === undefined,
    'INVALID_INPUT', 'Choose durationMs for a bounded window or leaseMs for a supervised heartbeat, not both', 400);
  if (body.durationMs === undefined) return null;
  integer(body.durationMs, 'durationMs', 1000, maxWindowMs);
  return body.durationMs;
}
