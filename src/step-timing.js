'use strict';

// PKG-313: elapsed timestamps on every `▸` step line and a closing `deploy timing:` table. One timeline is
// fed by the same ctx.onStep marks the history recorder reads, for the legacy and the releases pipeline alike.
const WRITERS_STOPPED = 'stop-writers';
const RESTART = 'pm2-restart';
const HEALTH = 'health';
const RESUME = 'resume-writers';

const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

function createStepTiming({ clock = () => performance.now(), onStep, log }) {
  const started = clock();
  const marks = [];
  const elapsed = () => clock() - started;

  const forwardingOnStep = (event) => {
    const step = String(event && event.step);
    marks.push({ step, at: elapsed() });
    if (step === RESUME) endWindow(RESUME);
    if (typeof onStep === 'function') onStep(event);
  };

  const timedLog = Object.assign(Object.create(log), {
    step: (msg) => log.step(`${msg} [+${seconds(elapsed())}]`),
  });

  let windowEnd = null;
  const endWindow = (name) => { if (!windowEnd) windowEnd = { name, at: elapsed() }; };

  const rows = (endAt) => marks.map((mark, index) => ({
    step: mark.step,
    note: mark.note,
    startAt: mark.at,
    endAt: index + 1 < marks.length ? marks[index + 1].at : endAt,
  }));

  const downtime = (all, ok, endAt) => {
    const first = (name) => all.find((row) => row.step === name);
    const from = first(WRITERS_STOPPED) || first(RESTART);
    if (!from) return null;
    if (windowEnd) {
      const named = windowEnd.name === RESUME ? RESUME : `${windowEnd.name} done`;
      return { ms: windowEnd.at - from.startAt, label: `${from.step} -> ${named}` };
    }
    if (!ok) return { ms: endAt - from.startAt, label: `${from.step} -> deploy ended (failed)` };
    const to = first(HEALTH) || first(RESTART);
    return to ? { ms: to.endAt - from.startAt, label: `${from.step} -> ${to.step} done` } : null;
  };

  const report = (ok) => {
    try {
      const endAt = elapsed();
      const all = rows(endAt);
      const width = Math.max(5, ...all.map((row) => row.step.length));
      log.info('deploy timing:');
      for (const row of all) log.info(`  ${row.step.padEnd(width)}  ${seconds(row.endAt - row.startAt)}${row.note ? ` (${row.note})` : ''}`);
      log.info(`  ${'total'.padEnd(width)}  ${seconds(endAt)}`);
      const window = downtime(all, ok, endAt);
      if (window) log.info(`  downtime window  ${seconds(window.ms)} (${window.label})`);
    } catch { /* timing output must never change a deploy's outcome */ }
  };

  const annotate = (note) => { if (marks.length) marks[marks.length - 1].note = note; };

  return { onStep: forwardingOnStep, log: timedLog, marks, endWindow, annotate, report };
}

module.exports = { createStepTiming };
