'use strict';

const { runOnTarget, shQuote } = require('./exec');

// Storage primitive only: durable bytes in, bounded parsed JSON out. It does NOT
// validate journal schema, state or chain; the caller must do that on what read()
// returns and before write().
const JOURNAL_FILE = '.deploy-kit-transition-journal.json';
const MAX_JOURNAL_BYTES = 128 * 1024;
const TIMEOUT_SECONDS = 20;
const RELEASE_PHASE_FILE = '.deploy-kit-state.json';
// The only two files this backend can ever address; callers pick one, never a path.
const FIXED_FILES = Object.freeze({ journal: JOURNAL_FILE, phase: RELEASE_PHASE_FILE });

// Static node script run on the target (cwd = projectDir). stdin is
// "<op>\n<payload bytes>"; nothing variable is ever in the command line. stdout is
// one JSON envelope. Any failure other than read ENOENT exits 1 with no output.
const buildStorageScript = (file) => [
  "const fs=require('fs'),crypto=require('crypto');",
  `const FILE=${JSON.stringify(file)},MAX=${MAX_JOURNAL_BYTES};`,
  'const out=(o)=>process.stdout.write(JSON.stringify(o));',
  '(function(){',
  ' let fd=-1,tmp=null,renamed=false;',
  ' try{',
  '  const inp=fs.readFileSync(0);',
  '  const nl=inp.indexOf(10);',
  '  if(nl<0)throw new Error("x");',
  '  const op=inp.subarray(0,nl).toString("latin1"),body=inp.subarray(nl+1);',
  '  if(op==="read"){',
  '   try{fd=fs.openSync(FILE,"r");}catch(e){if(e&&e.code==="ENOENT"){out({v:1,k:"absent"});return;}throw e;}',
  '   const buf=Buffer.alloc(MAX+1);let n=0;',
  '   while(n<buf.length){const r=fs.readSync(fd,buf,n,buf.length-n,null);if(r<=0)break;n+=r;}',
  '   if(n>MAX)throw new Error("x");',
  '   fs.closeSync(fd);fd=-1;',
  '   out({v:1,k:"data",b64:buf.subarray(0,n).toString("base64")});return;',
  '  }',
  '  if(op!=="write"||body.length>MAX)throw new Error("x");',
  '  tmp=FILE+".tmp-"+crypto.randomBytes(16).toString("hex");',
  '  fd=fs.openSync(tmp,"wx",0o600);',
  '  let off=0;',
  '  while(off<body.length){const w=fs.writeSync(fd,body,off,body.length-off);if(!(w>0))throw new Error("x");off+=w;}',
  '  fs.fsyncSync(fd);fs.closeSync(fd);fd=-1;',
  '  fs.renameSync(tmp,FILE);renamed=true;',
  '  fd=fs.openSync(".","r");fs.fsyncSync(fd);fs.closeSync(fd);fd=-1;',
  '  out({v:1,k:"written",bytes:body.length});',
  ' }catch(e){',
  '  if(fd>=0){try{fs.closeSync(fd);}catch(_){}}',
  '  if(tmp&&!renamed){try{fs.unlinkSync(tmp);}catch(_){}}',
  '  process.exitCode=1;',
  ' }',
  '})();',
].join('\n');
const TRANSITION_JOURNAL_SCRIPT = buildStorageScript(JOURNAL_FILE);

function journalFailed() {
  const error = new Error('deploy-kit: transition journal storage failed');
  error.code = 'JOURNAL_FAILED';
  return error;
}

// `allowed` maps each accepted envelope kind to its exact extra field names.
function parseEnvelope(res, allowed) {
  if (!res.ok || typeof res.output !== 'string' || res.output.length > MAX_JOURNAL_BYTES * 2) throw journalFailed();
  let env;
  try { env = JSON.parse(res.output); } catch { throw journalFailed(); }
  if (!env || typeof env !== 'object' || Array.isArray(env) || env.v !== 1
    || !Object.prototype.hasOwnProperty.call(allowed, env.k)) throw journalFailed();
  if (Object.keys(env).sort().join() !== ['k', 'v', ...allowed[env.k]].sort().join()) throw journalFailed();
  return env;
}

function decodeJournal(b64) {
  if (typeof b64 !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64)) throw journalFailed();
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length > MAX_JOURNAL_BYTES) throw journalFailed();
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw journalFailed();
    return value;
  } catch { throw journalFailed(); }
}

function assertWritableJson(json) {
  if (typeof json !== 'string' || Buffer.byteLength(json, 'utf8') > MAX_JOURNAL_BYTES
    || Buffer.from(json, 'utf8').toString('utf8') !== json) throw journalFailed();
  let value;
  try { value = JSON.parse(json); } catch { throw journalFailed(); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw journalFailed();
}

function createFixedFileStorage(selection, config, { runtime } = {}) {
  if (!Object.prototype.hasOwnProperty.call(FIXED_FILES, selection)) throw journalFailed();
  const command = `node -e ${shQuote(buildStorageScript(FIXED_FILES[selection]))}`;
  const dryRun = Boolean(runtime && runtime.dryRun === true);
  const run = (input) => runOnTarget(command, config, { capture: true, runtime, input, timeoutSeconds: TIMEOUT_SECONDS });

  return {
    read() {
      if (dryRun) return null;
      const env = parseEnvelope(run('read\n'), { absent: [], data: ['b64'] });
      return env.k === 'absent' ? null : decodeJournal(env.b64);
    },
    write(json) {
      assertWritableJson(json);
      if (dryRun) return { status: 'planned' };
      const bytes = Buffer.byteLength(json, 'utf8');
      const env = parseEnvelope(run(`write\n${json}`), { written: ['bytes'] });
      if (env.bytes !== bytes) throw journalFailed();
      return { status: 'written', bytes };
    },
  };
}

function createTransitionJournalStorage(config, options) {
  return createFixedFileStorage('journal', config, options);
}

// Durable protected release-phase record (.deploy-kit-state.json), rooted at config.projectDir.
function createReleasePhaseStorage(config, options) {
  return createFixedFileStorage('phase', config, options);
}

module.exports = {
  createTransitionJournalStorage, createReleasePhaseStorage, TRANSITION_JOURNAL_SCRIPT, MAX_JOURNAL_BYTES, JOURNAL_FILE,
};
