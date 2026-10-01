'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync: nodeExecFileSync } = require('child_process');

// PKG-197: every runOnTarget() is its own `ssh` process, so a monitor pass opened
// ~16 connections (~8 journal lines each on the target). OpenSSH connection sharing
// folds a run into one: the first command becomes the master, the rest ride its
// socket. The socket lives in a private (0700) per-run directory and the master is
// told to exit, and the directory removed, when the run ends. ControlPersist is the
// backstop for a run killed before cleanup: the master dies after 60 idle seconds.
// Only ssh mode multiplexes; mode 'local' never reaches ssh at all.
// The socket lives under /tmp, not os.tmpdir(): a unix socket path is capped at 104
// bytes on macOS, and ssh appends a ~17-byte temp suffix while creating the master,
// so macOS's /var/folders/.../T/ (~49 bytes) + dk-XXXXXX + the 40-byte %C hash overflows.
// mkdtemp still makes the per-run directory private (0700).
const SOCKET_BASE = process.platform === 'win32' ? os.tmpdir() : '/tmp';

function withSshMux(config, fn, { execFileSync = nodeExecFileSync, tmpdir = SOCKET_BASE } = {}) {
  if (config.mode !== 'ssh' || !config.host) return fn(config);
  const dir = fs.mkdtempSync(path.join(tmpdir, 'dk-'));
  const controlPath = path.join(dir, '%C');
  const muxed = {
    ...config,
    ssh: {
      ...config.ssh,
      // Appended after the user's own options: for repeated -o keys OpenSSH keeps
      // the first, so a user-supplied ControlPath/ControlMaster still wins.
      options: [
        ...((config.ssh && config.ssh.options) || []),
        'ControlMaster=auto', `ControlPath=${controlPath}`, 'ControlPersist=60',
      ],
    },
  };
  try {
    return fn(muxed);
  } finally {
    try {
      execFileSync('ssh', ['-o', `ControlPath=${controlPath}`, '-O', 'exit', config.host], { stdio: 'ignore', timeout: 10000 });
    } catch { /* no master was ever started, or it already exited */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { withSshMux, SOCKET_BASE };
