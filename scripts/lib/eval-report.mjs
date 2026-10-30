import { fail } from './cli.mjs';
import { referencePattern } from './config.mjs';

// Mirrors schemas/eval-report.schema.json; tests check both agree on fixtures.
const evaluators = ['spec', 'plan', 'code', 'security', 'performance'];
const filePattern = new RegExp(referencePattern);
function invalid(where, reason) { fail('EVAL_REPORT', `${where}: ${reason}`); }
function object(value, allowed, required, where) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(where, 'expected an object');
  if (Object.keys(value).some(key => !allowed.includes(key))) invalid(where, 'unknown field');
  if (required.some(key => !Object.hasOwn(value, key))) invalid(where, 'missing required field');
}
function text(value, where, max) {
  if (typeof value !== 'string' || !/\S/.test(value) || value.length > max) invalid(where, `expected non-blank text up to ${max} characters`);
}
function oneOf(value, allowed, where) {
  if (!allowed.includes(value)) invalid(where, 'unsupported value');
}
export function validateEvalReport(input) {
  object(input, ['schemaVersion', 'evaluator', 'focus', 'verdict', 'mode', 'subject', 'criteria', 'findings', 'notAssessed'],
    ['schemaVersion', 'evaluator', 'verdict', 'mode', 'subject', 'criteria', 'findings', 'notAssessed'], 'report');
  if (input.schemaVersion !== 1) invalid('schemaVersion', 'expected integer 1');
  oneOf(input.evaluator, evaluators, 'evaluator');
  oneOf(input.verdict, ['PASS', 'FAIL', 'BLOCKED'], 'verdict');
  oneOf(input.mode, ['full', 'degraded'], 'mode');
  const artifact = ['spec', 'plan'].includes(input.evaluator);
  if (typeof input.subject !== 'string' || !(artifact ? /^sha256:[0-9a-f]{64}$/ : /^fp:[0-9a-f]{64}$/).test(input.subject)) {
    invalid('subject', artifact ? 'spec and plan evaluations judge an artifact (sha256:<hex>)' : 'code evaluations judge a code state (fp:<hex>)');
  }
  const hasFocus = Object.hasOwn(input, 'focus');
  if (input.evaluator === 'code') {
    if (!hasFocus) invalid('focus', 'required for the code evaluator');
    oneOf(input.focus, ['acceptance', 'quality', 'tests', 'all'], 'focus');
  } else if (input.evaluator === 'plan') {
    if (hasFocus) oneOf(input.focus, ['architecture'], 'focus');
  } else if (hasFocus) invalid('focus', 'not allowed for this evaluator');
  if (!Array.isArray(input.criteria)) invalid('criteria', 'expected an array');
  for (const [index, entry] of input.criteria.entries()) {
    const where = `criteria[${index}]`;
    object(entry, ['id', 'status', 'evidence'], ['id', 'status', 'evidence'], where);
    if (typeof entry.id !== 'string' || !/^AC-[1-9][0-9]*$/.test(entry.id)) invalid(`${where}.id`, 'expected AC-<n>');
    oneOf(entry.status, ['met', 'not_met', 'not_assessed'], `${where}.status`);
    text(entry.evidence, `${where}.evidence`, 500);
  }
  if (!Array.isArray(input.findings) || input.findings.length > 20) invalid('findings', 'expected an array of at most 20 findings');
  for (const [index, entry] of input.findings.entries()) {
    const where = `findings[${index}]`;
    object(entry, ['id', 'severity', 'file', 'line', 'problem', 'impact', 'fix'], ['id', 'severity', 'problem', 'impact', 'fix'], where);
    if (typeof entry.id !== 'string' || !/^F[1-9][0-9]*$/.test(entry.id)) invalid(`${where}.id`, 'expected F<n>');
    oneOf(entry.severity, ['critical', 'high', 'medium', 'low'], `${where}.severity`);
    if (Object.hasOwn(entry, 'file') && (typeof entry.file !== 'string' || !filePattern.test(entry.file))) invalid(`${where}.file`, 'expected a contained project-relative path');
    if (Object.hasOwn(entry, 'line') && (!Number.isSafeInteger(entry.line) || entry.line < 1)) invalid(`${where}.line`, 'expected a positive integer');
    for (const field of ['problem', 'impact', 'fix']) text(entry[field], `${where}.${field}`, 500);
  }
  if (!Array.isArray(input.notAssessed)) invalid('notAssessed', 'expected an array');
  for (const [index, entry] of input.notAssessed.entries()) text(entry, `notAssessed[${index}]`, 500);
  if (input.verdict === 'PASS') {
    if (input.findings.some(entry => ['critical', 'high'].includes(entry.severity))) invalid('verdict', 'PASS cannot coexist with a critical or high finding');
    if (input.criteria.some(entry => entry.status === 'not_met')) invalid('verdict', 'PASS cannot coexist with an unmet criterion');
  }
  if (input.mode === 'degraded' && input.notAssessed.length === 0) invalid('notAssessed', 'a degraded evaluation must name what it could not assess');
  return input;
}
// State key for an evaluation, e.g. "code-acceptance" or "plan-architecture".
export function evalKey(report) {
  return report.focus ? `${report.evaluator}-${report.focus}` : report.evaluator;
}
