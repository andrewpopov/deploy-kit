---
kind: fixed
summary: "auto-cut streams the release push and commit live instead of buffering them, and failures say why"
---

auto-cut ran every local command with Node's default 1 MB output buffer, so a
pre-push hook that printed more than that (about 2.2 MB in one consumer) killed
the release push with ENOBUFS, and the error showed only the command. The release
`git commit` and `git push` now stream their output live to stderr with no cap,
other commands get a 64 MB buffer, and a failed command's error now includes the
error code, signal or exit status, stderr, and the last 4000 characters of stdout.
