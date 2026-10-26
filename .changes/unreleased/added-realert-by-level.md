---
kind: added
summary: monitor.reAlertAfterMinutes accepts { warn, crit } so warn and crit reminders run on different intervals
---

`monitor.reAlertAfterMinutes` can now be an object such as `{ "warn": 360, "crit": 60 }` to remind about still-failing warn and crit checks on separate intervals. A level left out of the object gets no reminders. A plain number behaves as before and applies to both levels.
