import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';

const require = createRequire(__filename);
const { withSshMux, SOCKET_BASE } = require('../ssh-mux.js');
const { monitor } = require('../monitor.js');
const kit = require('../index.js') as typeof import('../index');
const { mergeConfig, DEFAULT_CONFIG } = kit;

const sshConfig = () => mergeConfig(DEFAULT_CONFIG, {
  host: 'mizen@127.0.0.1', projectDir: '/srv/app', appNames: ['app'],
  monitor: { disk: { minFreeKiB: 1, minFreeInodes: 1 }, alert: { command: 'SINK', run: 'target' } },
});

// Records every ssh invocation; answers just enough for a quiet monitor pass.
function fakeRuntime() {
  const calls: { file: string; args: string[] }[] = [];
  const execFileSync = (file: string, args: string[]) => {
    calls.push({ file, args });
    const cmd = args[args.length - 1];
    if (cmd.includes('df -kP') || cmd.includes('df -iP')) return '9999999';
    if (cmd.includes('__DK_ABSENT__')) return '__DK_ABSENT__';
    return '';
  };
  return { calls, execFileSync };
}

const opt = (args: string[], key: string) => args.filter((a, i) => args[i - 1] === '-o' && a.startsWith(`${key}=`));

describe('PKG-197: withSshMux', () => {

  it('the default socket path fits the 104-byte unix-socket limit with ssh\'s ~17-byte temp suffix', () => {
    const rt = fakeRuntime();
    withSshMux(sshConfig(), (c: any) => monitor(c, {}, { runtime: rt, now: () => 1 }), { execFileSync: rt.execFileSync });
    const cp = opt(rt.calls[0].args, 'ControlPath')[0].slice('ControlPath='.length);
    expect(cp.startsWith(`${SOCKET_BASE}/dk-`)).toBe(true);
    // %C expands to a 40-char hash; ssh adds a ".XXXXXXXXXXXXXXXX" suffix while binding the master.
    expect(cp.replace('%C', 'x'.repeat(40)).length + 17).toBeLessThanOrEqual(104);
  });
  it('a remote monitor run shares ONE control socket across every ssh it issues', () => {
    const rt = fakeRuntime();
    const tmp = fs.mkdtempSync(`${os.tmpdir()}/dk-mux-test-`);
    withSshMux(sshConfig(), (c: any) => monitor(c, {}, { runtime: rt, now: () => 1 }), { execFileSync: rt.execFileSync, tmpdir: tmp });

    const work = rt.calls.filter((c) => !c.args.includes('-O'));
    expect(work.length).toBeGreaterThan(3);
    const paths = new Set(work.map((c) => opt(c.args, 'ControlPath').join()));
    expect(paths.size).toBe(1);
    for (const c of work) {
      expect(opt(c.args, 'ControlMaster')).toEqual(['ControlMaster=auto']);
      expect(opt(c.args, 'ControlPath')[0]).toMatch(/^ControlPath=.*\/dk-[^/]+\/%C$/);
    }
    // closed exactly once, on the same socket, and the private dir is gone
    const exits = rt.calls.filter((c) => c.args.includes('-O'));
    expect(exits).toHaveLength(1);
    expect(exits[0].args).toContain(`ControlPath=${[...paths][0].slice('ControlPath='.length)}`);
    expect(fs.readdirSync(tmp)).toEqual([]);
    fs.rmSync(tmp, { recursive: true });
  });

  it('cleans up even when the run throws', () => {
    const rt = fakeRuntime();
    const tmp = fs.mkdtempSync(`${os.tmpdir()}/dk-mux-test-`);
    expect(() => withSshMux(sshConfig(), () => { throw new Error('boom'); }, { execFileSync: rt.execFileSync, tmpdir: tmp })).toThrow('boom');
    expect(fs.readdirSync(tmp)).toEqual([]);
    expect(rt.calls.filter((c) => c.args.includes('-O'))).toHaveLength(1);
    fs.rmSync(tmp, { recursive: true });
  });

  it('local monitor (--local) issues 0 ssh invocations and opens no mux', () => {
    const rt = fakeRuntime();
    const local = { ...sshConfig(), mode: 'local' };
    withSshMux(local, (c: any) => monitor(c, {}, { runtime: rt, now: () => 1 }), { execFileSync: rt.execFileSync });
    expect(rt.calls.length).toBeGreaterThan(0);
    expect(rt.calls.filter((c) => c.file === 'ssh')).toHaveLength(0);
  });
});
