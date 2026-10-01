---
kind: fixed
summary: "monitor shares one ssh connection per run (ControlMaster) instead of one per command; docs say to run the on-host timer with --local"
---

A `deploy-kit monitor` pass issued one `ssh` per command (about 16 per run), each
writing ~8 journal lines on the target. In ssh mode a run now opens a single
connection (private per-run control socket, closed and removed at exit). A monitor
that runs on the target host itself should use `--local` and opens none.
