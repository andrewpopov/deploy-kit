import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SCRIPT = path.join(__dirname, '..', 'on-host', 'record.sh');
const RUN_ID = '20260930T120000Z-0123456789ab-deadbeef';
const INV = 'f'.repeat(32);

let runDir: string;
let parent: string;
beforeEach(() => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), 'dk-record-'));
  runDir = path.join(parent, RUN_ID);
  fs.mkdirSync(runDir, { mode: 0o700 });
});
afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

function record(env: Record<string, string> = {}) {
  return spawnSync('/bin/sh', [SCRIPT, runDir], {
    env: { PATH: process.env.PATH ?? '', INVOCATION_ID: INV, SERVICE_RESULT: 'success', EXIT_CODE: 'exited', EXIT_STATUS: '0', ...env },
    encoding: 'utf8',
  });
}
const read = (name: string) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
const exists = (name: string) => fs.existsSync(path.join(runDir, name));

describe('record.sh', () => {
  it('a matching invocation writes result.json', () => {
    fs.writeFileSync(path.join(runDir, 'started'), INV);
    expect(record().status).toBe(0);
    expect(read('result.json')).toMatchObject({
      runId: RUN_ID, invocationId: INV, serviceResult: 'success', exitCode: 'exited', exitStatus: '0',
    });
    expect(typeof read('result.json').finishedAt).toBe('number');
    expect(exists('result-unstarted.json')).toBe(false);
    expect(fs.readdirSync(runDir).filter((f) => f.includes('.tmp'))).toEqual([]);
  });
  it('a mismatched invocation is a no-op', () => {
    fs.writeFileSync(path.join(runDir, 'started'), 'e'.repeat(32));
    record();
    expect(fs.readdirSync(runDir)).toEqual(['started']);
  });
  it('started absent writes result-unstarted.json', () => {
    record({ SERVICE_RESULT: 'exit-code', EXIT_STATUS: '1' });
    expect(read('result-unstarted.json')).toMatchObject({ runId: RUN_ID, serviceResult: 'exit-code', exitStatus: '1' });
    expect(exists('result.json')).toBe(false);
  });
  it('never overwrites an existing result.json', () => {
    fs.writeFileSync(path.join(runDir, 'started'), INV);
    fs.writeFileSync(path.join(runDir, 'result.json'), 'ORIGINAL');
    record({ SERVICE_RESULT: 'signal' });
    expect(fs.readFileSync(path.join(runDir, 'result.json'), 'utf8')).toBe('ORIGINAL');
  });
  it('never overwrites an existing result-unstarted.json', () => {
    fs.writeFileSync(path.join(runDir, 'result-unstarted.json'), 'ORIGINAL');
    record();
    expect(fs.readFileSync(path.join(runDir, 'result-unstarted.json'), 'utf8')).toBe('ORIGINAL');
  });
  it('a hostile value becomes "invalid" and the file stays valid JSON', () => {
    fs.writeFileSync(path.join(runDir, 'started'), INV);
    record({ SERVICE_RESULT: 'a"b', EXIT_STATUS: '$(touch pwned)', EXIT_CODE: 'x\ny' });
    const r = read('result.json');
    expect(r).toMatchObject({ serviceResult: 'invalid', exitStatus: 'invalid', exitCode: 'invalid' });
    expect(exists('pwned')).toBe(false);
  });
  it('a missing value becomes "invalid"', () => {
    fs.writeFileSync(path.join(runDir, 'started'), INV);
    record({ EXIT_STATUS: '' });
    expect(read('result.json').exitStatus).toBe('invalid');
  });
});
