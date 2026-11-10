---
kind: fixed
summary: layout migrate accepts a checkout that tracks a layout-named directory such as shared/
---

`layout migrate --to releases` no longer refuses with `layout-dirs-absent` when the checkout tracks `repo.git`, `releases`, `shared`, `current` or `previous` in `HEAD`. Such an entry is checkout content: a `reserve` step moves it into `.legacy-checkout` before the layout creates its own, and the reverse clears the layout's directory of that name and restores it in an `unreserve` step. An untracked entry with a layout name still refuses.
