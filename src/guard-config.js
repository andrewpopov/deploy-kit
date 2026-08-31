'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_GUARD_CONFIG = 'deploy-kit.guards.json';

function loadGuardConfig({ projectRoot, configPath = DEFAULT_GUARD_CONFIG }) {
  const absolutePath = path.resolve(projectRoot, configPath);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Cannot read guard config ${absolutePath}: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Guard config ${absolutePath} must contain a JSON object`);
  }
  return { config: parsed, configPath: absolutePath };
}

module.exports = { DEFAULT_GUARD_CONFIG, loadGuardConfig };
