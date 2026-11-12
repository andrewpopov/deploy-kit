'use strict';

// PKG-313: elapsed timestamps on every `▸` step line and a closing `deploy timing:` table. One timeline is
// fed by the same ctx.onStep marks the history recorder reads, for the legacy and the releases pipeline alike.
const WRITERS_STOPPED = 'stop-writers';
const RESTART = 'pm2-restart';
const HEALTH = 'health';

const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

function createStepTiming({ clock = () => performance.now(), onStep, log }) {
  const started = clock();
  const marks = [];
  const elapsed = () => clock() - started;

  const forwardingOnStep = (event) => {
    marks.push({ step: String(event && event.step), at: elapsed() });
    if (typeof onStep === 'function') onStep(event);
  };

  const timedLog = {
    ...log,
    step: (msg) => log.step(`${msg} [+${seconds(elapsed())}]`),
  };

  const rows = (endAt) => marks.map((mark, index) => ({
    step: mark.step,
    startAt: mark.at,
    endAt: index + 1 < marks.length ? marks[index + 1].at : endAt,
  }));

  const downtime = (all, ok, endAt) => {
    const first = (name) => all.find((row) => row.step === name);
    const from = first(WRITERS_STOPPED) || first(RESTART);
    const to = first(HEALTH) || first(RESTART);
    if (!from) return null;
    if (!ok) return { ms: endAt - from.startAt, label: `${from.step} -> deploy ended (failed)` };
    return to ? { ms: to.endAt - from.startAt, label: `${from.step} -> ${to.step} done` } : null;
  };

  const report = (ok) => {
    try {
      const endAt = elapsed();
      const all = rows(endAt);
      const width = Math.max(5, ...all.map((row) => row.step.length));
      log.info('deploy timing:');
      for (const row of all) log.info(`  ${row.step.padEnd(width)}  ${seconds(row.endAt - row.startAt)}`);
      log.info(`  ${'total'.padEnd(width)}  ${seconds(endAt)}`);
      const window = downtime(all, ok, endAt);
      if (window) log.info(`  downtime window  ${seconds(window.ms)} (${window.label})`);
    } catch { /* timing output must never change a deploy's outcome */ }
  };

  return { onStep: forwardingOnStep, log: timedLog, marks, report };
}

module.exports = { createStepTiming };
