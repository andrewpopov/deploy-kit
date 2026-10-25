#!/bin/sh
# BRAIN-636 D8: install a deploy-kit npm tarball as THE global deploy-kit and record its identity.
#
#   scripts/install-artifact.sh <deploy-kit-X.Y.Z.tgz>
#
# Computes the tarball's sha256, installs it globally, and writes ARTIFACT.json
# {name, version, sha256, installedAt} and keeps a copy of the tarball as ARTIFACT.tgz in the installed package root
# (src/artifact.js reads them back and verifies the one against the other).
# Test seams, so a test never installs globally:
#   DEPLOY_KIT_INSTALL_CMD   the install command, run as `$DEPLOY_KIT_INSTALL_CMD <tarball>` (default `npm i -g`)
#   DEPLOY_KIT_PACKAGE_ROOT  the installed package root (default `$(npm root -g)/<name>`)
#   DEPLOY_KIT_NOW           installedAt (default: the current UTC time)
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: install-artifact.sh <deploy-kit-tarball.tgz>" >&2
  exit 2
fi
tarball=$1
if [ ! -f "$tarball" ]; then
  echo "install-artifact: $tarball is not a file" >&2
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  sha256=$(sha256sum "$tarball" | cut -d ' ' -f 1)
else
  sha256=$(shasum -a 256 "$tarball" | cut -d ' ' -f 1)
fi

manifest=$(tar -xzOf "$tarball" package/package.json)
field() { printf '%s' "$manifest" | node -p "JSON.parse(require('fs').readFileSync(0, 'utf8')).$1"; }
name=$(field name)
version=$(field version)

# Word splitting of the command is intended: it may carry arguments.
# shellcheck disable=SC2086
${DEPLOY_KIT_INSTALL_CMD:-npm i -g} "$tarball"

root=${DEPLOY_KIT_PACKAGE_ROOT:-$(npm root -g)/$name}
installed=$(ROOT=$root node -p "const f = require('path').join(process.env.ROOT, 'package.json'); require('fs').existsSync(f) ? JSON.parse(require('fs').readFileSync(f, 'utf8')).version : ''")
if [ "$installed" != "$version" ]; then
  echo "install-artifact: $root holds version '${installed:-none}' after the install, expected $version" >&2
  exit 1
fi

ARTIFACT_NAME=$name ARTIFACT_VERSION=$version ARTIFACT_SHA256=$sha256 ARTIFACT_AT=${DEPLOY_KIT_NOW:-$(date -u +%Y-%m-%dT%H:%M:%SZ)} \
  node -e "process.stdout.write(JSON.stringify({ name: process.env.ARTIFACT_NAME, version: process.env.ARTIFACT_VERSION, sha256: process.env.ARTIFACT_SHA256, installedAt: process.env.ARTIFACT_AT }, null, 2) + '\n')" \
  > "$root/ARTIFACT.json"
# The bytes behind that sha256, so readArtifact can recompute it and prove ARTIFACT.json describes what is installed.
cp "$tarball" "$root/ARTIFACT.tgz"
echo "install-artifact: $name@$version sha256 $sha256 -> $root/ARTIFACT.json"
