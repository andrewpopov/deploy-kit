#!/bin/sh
# One-time host setup, run as dkapp at image build: upstream repo with 2 commits,
# then the releases-layout root deploy-kit's release preflight requires.
set -eu
export GIT_AUTHOR_NAME=harness GIT_AUTHOR_EMAIL=h@example.test GIT_COMMITTER_NAME=harness GIT_COMMITTER_EMAIL=h@example.test
UP=/srv/upstream/dkapp.git
git init -q --bare -b main "$UP"
W=$(mktemp -d)
git init -q -b main "$W"
cp /opt/seed/server.js /opt/seed/package.json /opt/seed/ecosystem.config.cjs "$W"/
git -C "$W" add -A && git -C "$W" commit -q -m "dkapp v1"
echo "// v2" >> "$W/server.js"
git -C "$W" commit -q -am "dkapp v2"
git -C "$W" push -q "$UP" main

APP=/srv/dkapp
git clone -q --bare "$UP" "$APP/repo.git"
mkdir -p "$APP/releases" "$APP/shared/cache/npm"
printf '{"layout":"releases","version":1}\n' > "$APP/.deploy-kit-layout"
# Stable ecosystem deploy-kit starts from (literal cwd: <root>/current)
cp /opt/seed/ecosystem.config.cjs "$APP/ecosystem.config.cjs"
