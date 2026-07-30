import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import { stepCheck as kitStepCheck } from '@andrewpopov/alert-kit';

const require = createRequire(__filename);
const { stepCheck: localStepCheck } = require('../monitor.js');

/**
 * Conformance: deploy-kit's `stepCheck` vs alert-kit's.
 *
 * alert-kit owns the canonical implementation (PKG-113). deploy-kit keeps a copy
 * because it declares ZERO runtime dependencies on purpose — a transitive `github:`
 * resolve onto ARM Pi hosts with no CI is a worse failure than the duplication. That
 * trade is only safe if the copy cannot drift silently, which is what this test is
 * for. alert-kit is a DEV dependency: nothing here reaches production.
 *
 * The matrix is exhaustive over every dimension the function branches on rather than
 * a hand-picked set of cases, because the drift this guards against is precisely the
 * edge nobody thought to write a case for.
 */
const NOW = 1_770_000_000_000;

const PHASES = ['healthy', 'alerted'] as const;
const LAST_ALERTED = [null, 'warn', 'crit'] as const;
const STATUSES = ['ok', 'warn', 'crit', 'unknown'] as const;

type AnyState = Record<string, unknown>;

function everyPriorState(): (AnyState | undefined)[] {
  const states: (AnyState | undefined)[] = [undefined];
  for (const notif of PHASES)
    for (const failStreak of [0, 1, 2, 3])
      for (const recoverStreak of [0, 1, 2])
        for (const lastAlertedStatus of LAST_ALERTED)
          for (const lastAlertAtMs of [0, NOW, NOW - 3_600_000])
            for (const meta of [undefined, { restart: 1 }])
              states.push({ notif, failStreak, recoverStreak, lastAlertedStatus, lastAlertAtMs, meta });
  return states;
}

describe('stepCheck conformance: deploy-kit copy vs alert-kit canonical', () => {
  it('agrees on every transition in the matrix', () => {
    const divergences: string[] = [];
    let compared = 0;

    for (const prev of everyPriorState())
      for (const status of STATUSES)
        for (const resultMeta of [undefined, { x: 99 }, { other: 5 }])
          for (const failAfterRuns of [1, 2, 3])
            for (const recoverAfterRuns of [1, 2])
              for (const reAlertAfterMinutes of [0, 10, 1440])
                for (const nowMs of [NOW, NOW + 11 * 60_000, NOW + 2 * 86_400_000]) {
                  const result = { id: 'x', status, message: 'm', meta: resultMeta };
                  const opts = { failAfterRuns, recoverAfterRuns, reAlertAfterMinutes, nowMs };
                  const mine = JSON.stringify(localStepCheck(prev ? { ...prev } : undefined, result, opts));
                  const kit = JSON.stringify(kitStepCheck(prev ? { ...prev } : undefined, result as never, opts));
                  compared += 1;
                  if (mine !== kit && divergences.length < 3) {
                    divergences.push(`prev=${JSON.stringify(prev)} result=${JSON.stringify(result)} opts=${JSON.stringify(opts)}\n  deploy-kit=${mine}\n  alert-kit =${kit}`);
                  }
                }

    expect(compared).toBeGreaterThan(100_000);
    expect(divergences, `deploy-kit's stepCheck has drifted from alert-kit's:\n${divergences.join('\n')}`).toEqual([]);
  });

  // The behaviour the header comment got wrong for months: it claimed `unknown`
  // CLEARS the streaks. Both implementations preserve them, and a monitor that lost
  // streak progress on one indeterminate run would never reach its alert threshold
  // on a flapping check.
  it('both PRESERVE the streaks through an unknown run', () => {
    const opts = { failAfterRuns: 2, recoverAfterRuns: 2, reAlertAfterMinutes: 0, nowMs: NOW };
    const first = localStepCheck(undefined, { id: 'x', status: 'crit', message: 'd' }, opts);
    const held = localStepCheck(first.next, { id: 'x', status: 'unknown', message: '?' }, opts);
    expect(held.next.failStreak).toBe(1);
    expect(held.alert).toBeUndefined();
    expect(JSON.stringify(held)).toBe(
      JSON.stringify(kitStepCheck(first.next as never, { id: 'x', status: 'unknown', message: '?' }, opts)),
    );
  });
});
