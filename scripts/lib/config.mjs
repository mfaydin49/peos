import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fail } from './cli.mjs';

export const approvals = ['commit', 'push', 'pull-request', 'deploy', 'publish', 'migration', 'external-write'];
// Portable slash-separated paths, contained lexically within the target project.
export const referencePattern = '^(?!/)(?!.*(?:^|/)\\.\\.(?:/|$))[^\\\\:\\u0000-\\u001f]+$';
const pathPattern = new RegExp(referencePattern);
function invalid(where, reason) { fail('CONFIG', `${where}: ${reason}`); }
function object(value, allowed, required, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(where, 'expected an object');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(where, 'unknown field');
  if (required.some(key => !Object.hasOwn(value, key))) invalid(where, 'missing required field');
}
function string(value, where) {
  if (typeof value !== 'string' || !value.trim()) invalid(where, 'expected a non-empty string');
}
function array(value, where, { nonempty = false, allowed } = {}) {
  if (!Array.isArray(value) || (nonempty && value.length === 0)) invalid(where, 'expected a non-empty array where required');
  if (new Set(value).size !== value.length) invalid(where, 'duplicate set value');
  for (const item of value) {
    string(item, where);
    if (allowed && !allowed.includes(item)) invalid(where, 'unsupported value');
  }
}
export function validateConfig(input) {
  object(input, ['schemaVersion', 'projectName', 'outputLanguage', 'references', 'checks', 'manualChecks', 'approvalRequiredFor'], ['schemaVersion', 'projectName', 'checks'], 'config');
  if (input.schemaVersion !== 1) invalid('schemaVersion', 'expected integer 1');
  string(input.projectName, 'projectName');
  const config = structuredClone(input);
  config.outputLanguage ??= 'tr';
  // Null is not omission: schema defaults apply only to absent properties.
  if (Object.hasOwn(input, 'outputLanguage')) string(input.outputLanguage, 'outputLanguage');
  string(config.outputLanguage, 'outputLanguage');
  config.references = Object.hasOwn(input, 'references') ? config.references : {};
  object(config.references, ['instructions', 'architecture', 'design'], [], 'references');
  for (const [kind, paths] of Object.entries(config.references)) {
    array(paths, `references.${kind}`);
    if (paths.some(path => !pathPattern.test(path))) invalid(`references.${kind}`, 'expected contained project-relative paths using forward slashes');
  }
  if (!Array.isArray(config.checks) || config.checks.length === 0) invalid('checks', 'expected a non-empty array');
  config.manualChecks = Object.hasOwn(input, 'manualChecks') ? config.manualChecks : [];
  if (!Array.isArray(config.manualChecks)) invalid('manualChecks', 'expected an array');
  const ids = new Set();
  for (const [kind, entries] of [['checks', config.checks], ['manualChecks', config.manualChecks]]) {
    for (const [index, entry] of entries.entries()) {
      const where = `${kind}[${index}]`;
      const fields = kind === 'checks' ? ['id', 'executable', 'args', 'phases', 'required', 'timeoutMs'] : ['id', 'description', 'phases', 'required'];
      object(entry, fields, fields, where);
      string(entry.id, `${where}.id`);
      if (ids.has(entry.id)) invalid(where, 'duplicate ID (IDs must be unique across automated and manual checks)');
      ids.add(entry.id);
      array(entry.phases, `${where}.phases`, { nonempty: true, allowed: ['task', 'release'] });
      if (typeof entry.required !== 'boolean') invalid(where, 'required must be boolean');
      if (kind === 'checks') {
        string(entry.executable, `${where}.executable`);
        if (entry.executable.includes('\0')) invalid(where, 'executable must not contain NUL');
        if (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) invalid(where, 'args must be strings without NUL');
        if (!Number.isSafeInteger(entry.timeoutMs) || entry.timeoutMs <= 0 || entry.timeoutMs > 2147483647) invalid(where, 'timeoutMs must be an integer from 1 to 2147483647');
      } else string(entry.description, `${where}.description`);
    }
  }
  config.approvalRequiredFor = Object.hasOwn(input, 'approvalRequiredFor') ? config.approvalRequiredFor : [...approvals];
  array(config.approvalRequiredFor, 'approvalRequiredFor', { allowed: approvals });
  return config;
}
export async function loadConfig(project) {
  let source;
  try { source = await readFile(resolve(project, '.project-os/engineering.config.json'), 'utf8'); }
  catch { fail('CONFIG_MISSING', 'Cannot read .project-os/engineering.config.json in the explicit target project.'); }
  let input;
  try { input = JSON.parse(source); } catch { fail('CONFIG', 'Configuration must be valid JSON.'); }
  return validateConfig(input);
}
export function resolveReferences(config, project) {
  return Object.fromEntries(Object.entries(config.references).map(([kind, paths]) => [kind, paths.map(path => resolve(project, path))]));
}
