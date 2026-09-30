'use strict';
const http = require('node:http');
const { execFileSync } = require('node:child_process');

// The release dir is a git worktree of repo.git, so HEAD is the deployed sha.
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: __dirname, encoding: 'utf8' }).trim();

http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end(sha);
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(3999, '127.0.0.1');
