'use strict';

const fs = require('fs');
const path = require('path');
const { load: loadYaml } = require('js-yaml');

// A finite, documented set of regex spellings that cloudflared treats as
// "every request path" — not an attempt at general regex-equivalence
// detection. `^.+$` and `^(.+)$` belong here alongside the `.*` spellings
// because an HTTP request path is never empty (it is at minimum `/`), so
// `.+` is exactly as permissive as `.*` in this position.
const MATCH_ALL_PATHS = new Set(['.*', '^.*$', '^(.*)$', '/*', '^/.*$', '^.+$', '^(.+)$']);

function matchesEveryPath(rule) {
  return !rule.path || MATCH_ALL_PATHS.has(String(rule.path));
}

// Cloudflare Tunnel ingress hostnames are DNS-like: an exact hostname matches
// only itself, and a `*.example.com` wildcard matches one OR MORE subdomain
// labels ending in `.example.com` (app.example.com, deep.app.example.com) but
// never the apex `example.com` itself — verified against cloudflared 2026.6.1.
// Exact matching is case-insensitive, but wildcard prefix/suffix matching is
// case-SENSITIVE (`*.Example.com` does not match `deep.example.com`), and a
// trailing dot is never normalized away (`app.example.com.` does not match a
// request for `app.example.com`) — cloudflared does neither. `ruleHostname`
// must be a non-empty hostname/pattern; a hostless (catch-all) rule is
// handled separately by `ruleAppliesToHostname`.
//
// A bare `*` hostname is cloudflared's every-hostname wildcard, not a DNS
// pattern — it never counts as an explicit hostname *binding*, so it
// deliberately returns false here even though it matches every host in
// practice. That means a bare-`*` rule can never satisfy a host-scoped
// `requiredRules`/`requiredHostnameRules` entry (policy requires an exact
// hostname or a leading `*.`-suffix binding); its every-host reach is
// instead handled, like a hostless rule, by `ruleAppliesToHostname` for
// shadow detection.
function hostnameMatches(ruleHostname, hostname) {
  const rule = String(ruleHostname).trim();
  if (rule === '*') return false;
  const host = String(hostname).trim();
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(2);
    return host !== suffix && host.endsWith(`.${suffix}`);
  }
  return rule.toLowerCase() === host.toLowerCase();
}

// A rule with no hostname, or a bare `*` hostname, is cloudflared's global
// catch-all — it receives every host's traffic regardless of what it names.
// A rule WITH a specific hostname only applies to hosts its pattern (exact
// or wildcard) actually matches.
function ruleAppliesToHostname(ruleHostname, hostname) {
  return !ruleHostname || ruleHostname === '*' || hostnameMatches(ruleHostname, hostname);
}

// The earliest ingress rule that would intercept EVERY path for `hostname` —
// a global catch-all (no hostname), or an exact/wildcard-hosted rule scoped
// to this hostname with no path restriction of its own. Anything required for
// `hostname` listed after this index is unreachable.
function findShadowingCatchAllIndex(ingress, hostname) {
  return ingress.findIndex(
    (rule) => matchesEveryPath(rule) && ruleAppliesToHostname(rule.hostname, hostname),
  );
}

// A required path counts as "safely reducible" only when it is a plain
// anchored literal — `^/api/webhook$` — with no regex metacharacters beyond
// the anchors. Anything else (alternation, character classes, quantifiers)
// returns null so the overlap check below backs off rather than guessing
// what the pattern means.
const LITERAL_REQUIRED_PATH_PATTERN = /^\^(\/[A-Za-z0-9/_-]*)\$$/;

function literalRequiredPath(requiredPath) {
  const match = LITERAL_REQUIRED_PATH_PATTERN.exec(String(requiredPath));
  return match ? match[1] : null;
}

function compilePathRegexSafely(pattern) {
  try {
    return new RegExp(String(pattern));
  } catch {
    return null;
  }
}

// An earlier, hostname-applicable ingress rule whose path regex matches the
// required rule's literal route (e.g. `^/api(/.*)?$` matching the literal
// `/api/webhook`) intercepts the request before cloudflared ever reaches the
// later exact declaration. This is deliberately narrow: it only fires when
// the required path reduces to a single safe literal and the earlier rule's
// pattern compiles, so it never attempts general regex-overlap reasoning.
function findEarlierPathOverlapIndex(ingress, required, exactIndex) {
  const literal = literalRequiredPath(required.path);
  if (literal === null) return -1;
  for (let index = 0; index < exactIndex; index += 1) {
    const rule = ingress[index];
    if (matchesEveryPath(rule) || !rule.path) continue;
    if (!ruleAppliesToHostname(rule.hostname, required.hostname)) continue;
    const regex = compilePathRegexSafely(rule.path);
    if (regex && regex.test(literal)) return index;
  }
  return -1;
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
    // Only an explicitly-hosted rule (exact or wildcard match on this
    // required hostname) can satisfy a host-scoped requiredRules entry — a
    // hostless same-path rule may SHADOW it (handled below) but never
    // satisfies it on its own.
    const index = ingress.findIndex(
      (rule) => rule.hostname && hostnameMatches(rule.hostname, required.hostname) && rule.path === required.path,
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
    // own (a global fallback, matching every host) or its hostname matches
    // this required rule's hostname (exact or wildcard). A catch-all scoped
    // to an unrelated host never sees this required path's traffic and must
    // not be flagged.
    const shadowingCatchAllIndex = findShadowingCatchAllIndex(ingress, required.hostname);
    if (shadowingCatchAllIndex !== -1 && index > shadowingCatchAllIndex) {
      errors.push(`${required.path} is listed after a rule that matches every path`);
    } else {
      const overlapIndex = findEarlierPathOverlapIndex(ingress, required, index);
      if (overlapIndex !== -1) {
        errors.push(
          `${required.path} is listed after an earlier rule (${ingress[overlapIndex].path}) `
          + `whose path overlaps it`,
        );
      }
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
    // Explicitly-hosted rules (exact or wildcard) that actually apply to this
    // hostname — a hostless or bare-`*` global catch-all is never itself "the"
    // rule for a requiredHostnameRules entry, but it can still shadow one
    // (checked below). cloudflared evaluates ingress top-to-bottom and stops
    // at the first match, so when more than one declaration applies to this
    // hostname (e.g. an exact rule and a `*.`-wildcard fallback both naming
    // it) the FIRST one by ingress order is the one actually in effect —
    // later declarations are unreachable and irrelevant, not a policy error.
    const matches = ingress.filter((rule) => rule.hostname && hostnameMatches(rule.hostname, required.hostname));
    if (matches.length === 0) {
      errors.push(`${required.hostname} must have an ingress rule`);
      continue;
    }
    const matched = matches[0];
    const matchedIndex = ingress.indexOf(matched);
    // An earlier rule that matches every path for this hostname (a global
    // catch-all, or another wildcard/exact rule scoped to it with no path of
    // its own) intercepts the host's traffic before `matched` ever sees it —
    // so `matched`'s service/full-origin checks below would otherwise pass
    // against a rule cloudflared never actually routes to.
    const shadowingCatchAllIndex = findShadowingCatchAllIndex(ingress, required.hostname);
    if (shadowingCatchAllIndex !== -1 && shadowingCatchAllIndex < matchedIndex) {
      errors.push(`${required.hostname} is shadowed by an earlier rule that matches every path`);
      continue;
    }
    if (matched.service !== required.service) {
      errors.push(`${required.hostname} must route to ${required.service}, found: ${matched.service}`);
    }
    if (required.allowPath === false && matched.path) {
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

module.exports = { MATCH_ALL_PATHS, matchesEveryPath, hostnameMatches, verifyTunnelConfig };
