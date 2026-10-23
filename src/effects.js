'use strict';

// BRAIN-636 D4d: what each pipeline step may do to production, in one table. deployRelease reports every
// step to ctx.onStep({step, class}) BEFORE running it; the classes of the steps that ran decide whether a
// failed pipeline left production untouched (`effectsClean`, and so `aborted-clean`).
//
//   staging    objects fetched into the bare repo; nothing a release or production reads
//   candidate  writes only inside the new, not yet serving release directory
//   read-only  reads only
//   live       may change production (anything not proven otherwise)

const CLASSES = ['staging', 'candidate', 'read-only', 'live'];
const DECLARABLE_CLASSES = ['candidate', 'read-only', 'live'];
const CLEAN_CLASSES = ['staging', 'candidate', 'read-only'];

// Built in: the class is fixed in code and a config cannot change it.
const BUILT_IN_STEPS = {
  'staging-fetch': 'staging', // host-run's bounded fetch of the exact sha, before acceptance
  fetch: 'staging', // the pipeline's own fetch into the bare repo
  preflight: 'read-only',
  preDeployChecks: 'read-only', // plan section 4.1 step 6: declared read-only
  'worktree-add': 'candidate',
  'shared-links': 'candidate', // symlinks created inside the candidate directory
  'verify-pins': 'read-only',
  'recover-interrupted': 'live', // an interrupted deploy's journal exists: production state is uncertain
  'stop-writers': 'live',
  backup: 'live',
  'pending-migrations': 'live', // runs with the writers stopped
  migrate: 'live',
  'previous-pointer': 'live',
  'current-pointer': 'live',
  preRestartChecks: 'live',
  'pm2-restart': 'live',
  postDeployChecks: 'live',
  prune: 'live',
};

// User hooks: `live` unless `layout.effects` declares them.
const USER_HOOK_STEPS = ['install', 'generate', 'build', 'releaseChecks', 'preMigrationChecks'];

function stepClass(config, step) {
  if (Object.hasOwn(BUILT_IN_STEPS, step)) return BUILT_IN_STEPS[step];
  if (!USER_HOOK_STEPS.includes(step)) throw new Error(`unknown pipeline step "${step}"`);
  const declared = config.layout && config.layout.effects && config.layout.effects[step];
  return declared || 'live';
}

const isClean = (stepClasses) => stepClasses.every((cls) => CLEAN_CLASSES.includes(cls));

module.exports = {
  CLASSES, DECLARABLE_CLASSES, CLEAN_CLASSES, BUILT_IN_STEPS, USER_HOOK_STEPS, stepClass, isClean,
};
