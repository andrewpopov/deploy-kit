'use strict';

const fs = require('fs');
const path = require('path');
const { load: loadYaml } = require('js-yaml');

const MATCH_ALL_PATHS = new Set(['.*', '^.*$', '/*', '^/.*$']);

function matchesEveryPath(rule) {
  return !rule.path || MATCH_ALL_PATHS.has(String(rule.path));
}

function validateTunnelPolicy(policy) {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('Guard config must define a `tunnel` object');
  }
  if (typeof policy.configFile !== 'string' || !policy.configFile.trim()) {
    throw new Error('tunnel.configFile must be a non-empty string');
  }
  if (!Array.isArray(policy.requiredRules)) {
    throw new Error('tunnel.requiredRules must be an array');
  }
  for (const [index, rule] of policy.requiredRules.entries()) {
    if (
      !rule
      || typeof rule.hostname !== 'string'
      || !rule.hostname.trim()
      || typeof rule.path !== 'string'
      || typeof rule.service !== 'string'
    ) {
      throw new Error(`tunnel.requiredRules[${index}] must define string hostname, path, and service values`);
    }
  }
  if (policy.requiredHostnameRules != null && !Array.isArray(policy.requiredHostnameRules)) {
    throw new Error('tunnel.requiredHostnameRules must be an array when provided');
  }
  if (policy.forbiddenServiceIncludes != null && !Array.isArray(policy.forbiddenServiceIncludes)) {
    throw new Error('tunnel.forbiddenServiceIncludes must be an array when provided');
  }
  if (policy.finalService != null && typeof policy.finalService !== 'string') {
    throw new Error('tunnel.finalService must be a string when provided');
  }
}

function verifyTunnelConfig({ projectRoot, policy }) {
  validateTunnelPolicy(policy);
  const configPath = path.resolve(projectRoot, policy.configFile);
  let document;
  try {
    document = loadYaml(fs.readFileSync(configPath, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, errors: [`cannot read ${policy.configFile}: ${message}`], configPath };
  }

  const ingress = document?.ingress;
  const errors = [];
  if (!Array.isArray(ingress) || ingress.length === 0) {
    return { ok: false, errors: ['no ingress rules found'], configPath };
  }

  const malformed = ingress.findIndex((rule) => !rule || typeof rule !== 'object' || Array.isArray(rule));
  if (malformed !== -1) {
    return { ok: false, errors: [`ingress rule ${malformed} is not a mapping`], configPath };
  }

  for (const required of policy.requiredRules) {
    const index = ingress.findIndex(
      (rule) => rule.hostname === required.hostname && rule.path === required.path,
    );
    if (index === -1) {
      errors.push(`no ingress rule for required hostname ${required.hostname} path ${required.path}`);
      continue;
    }
    if (ingress[index].service !== required.service) {
      errors.push(
        `${required.hostname} ${required.path} must route to ${required.service}, `
        + `found: ${ingress[index].service}`,
      );
    }
    // A pathless (catch-all) rule only shadows this required path if it would
    // actually receive the request first: either it has no hostname of its
    // own (a global fallback, matching every host) or its hostname is this
    // required rule's hostname. A catch-all scoped to a DIFFERENT host never
    // sees this required path's traffic and must not be flagged.
    const shadowingCatchAllIndex = ingress.findIndex(
      (rule) => matchesEveryPath(rule) && (!rule.hostname || rule.hostname === required.hostname),
    );
    if (shadowingCatchAllIndex !== -1 && index > shadowingCatchAllIndex) {
      errors.push(`${required.path} is listed after a rule that matches every path`);
    }
  }

  for (const required of policy.requiredHostnameRules ?? []) {
    if (
      !required
      || typeof required.hostname !== 'string'
      || !required.hostname.trim()
      || typeof required.service !== 'string'
    ) {
      throw new Error('each tunnel.requiredHostnameRules entry must define hostname and service strings');
    }
    const matches = ingress.filter((rule) => rule.hostname === required.hostname);
    if (matches.length !== 1) {
      errors.push(`${required.hostname} must have exactly one ingress rule`);
      continue;
    }
    if (matches[0].service !== required.service) {
      errors.push(`${required.hostname} must route to ${required.service}, found: ${matches[0].service}`);
    }
    if (required.allowPath === false && matches[0].path) {
      errors.push(`${required.hostname} must route the full origin without a path restriction`);
    }
  }

  for (const forbidden of policy.forbiddenServiceIncludes ?? []) {
    if (typeof forbidden !== 'string' || !forbidden) {
      throw new Error('tunnel.forbiddenServiceIncludes entries must be non-empty strings');
    }
    if (ingress.some((rule) => String(rule.service).includes(forbidden))) {
      errors.push(`ingress service must not include ${forbidden}`);
    }
  }

  if (policy.requireAnchoredPaths !== false) {
    for (const [index, rule] of ingress.entries()) {
      if (matchesEveryPath(rule)) continue;
      const pattern = String(rule.path);
      if (!pattern.startsWith('^') || !pattern.endsWith('$')) {
        errors.push(`rule ${index} path \`${pattern}\` is unanchored; anchor it as ^…$`);
      }
    }
  }

  if (policy.finalService != null) {
    const finalService = ingress.at(-1)?.service;
    if (finalService !== policy.finalService) {
      errors.push(`final rule must use service ${policy.finalService}, found: ${finalService}`);
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    configPath,
    checkedRules: policy.requiredRules.length + (policy.requiredHostnameRules?.length ?? 0),
  };
}

module.exports = { MATCH_ALL_PATHS, matchesEveryPath, verifyTunnelConfig };
