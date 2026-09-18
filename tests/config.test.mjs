import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateConfig, approvals, resolveReferences } from '../scripts/lib/config.mjs';
import { config, check, toolkit } from './helpers.mjs';
import { resolve } from 'node:path';
const schema = JSON.parse(await readFile(resolve(toolkit, 'schemas/engineering.config.schema.json')));
const ajv = new Ajv2020({ strict: true, allErrors: true });
const validateSchema = ajv.compile(schema);

const invalidCases = [
  ['null', () => null], ['array', () => []], ['empty', () => ({})],
  ['schema version', c => ({ ...c, schemaVersion: 2 })],
  ['unknown top field', c => ({ ...c, typo: 1 })],
  ['empty name', c => ({ ...c, projectName: '  ' })],
  ['empty language', c => ({ ...c, outputLanguage: '' })],
  ['null language', c => ({ ...c, outputLanguage: null })],
  ['null references', c => ({ ...c, references: null })],
  ['unknown reference', c => ({ ...c, references: { maps: [] } })],
  ['parent reference', c => ({ ...c, references: { instructions: ['docs/../secret'] } })],
  ['absolute reference', c => ({ ...c, references: { design: ['/tmp/test'] } })],
  ['windows reference', c => ({ ...c, references: { design: ['C:\\test'] } })],
  ['duplicate reference', c => ({ ...c, references: { architecture: ['doc.md', 'doc.md'] } })],
  ['empty checks', c => ({ ...c, checks: [] })],
  ['null check', c => ({ ...c, checks: [null] })],
  ['unknown check field', c => ({ ...c, checks: [{ ...check(), shell: true }] })],
  ['missing args', c => { delete c.checks[0].args; return c; }],
  ['bad args', c => ({ ...c, checks: [check('x', '', { args: [3] })] })],
  ['nul arg', c => ({ ...c, checks: [check('x', '', { args: ['a\0b'] })] })],
  ['nul executable', c => ({ ...c, checks: [check('x', '', { executable: 'a\0' })] })],
  ['empty executable', c => ({ ...c, checks: [check('x', '', { executable: '' })] })],
  ['zero timeout', c => ({ ...c, checks: [check('x', '', { timeoutMs: 0 })] })],
  ['large timeout', c => ({ ...c, checks: [check('x', '', { timeoutMs: 2147483648 })] })],
  ['fraction timeout', c => ({ ...c, checks: [check('x', '', { timeoutMs: 1.5 })] })],
  ['string boolean', c => ({ ...c, checks: [check('x', '', { required: 'true' })] })],
  ['unknown phase', c => ({ ...c, checks: [check('x', '', { phases: ['other'] })] })],
  ['empty phases', c => ({ ...c, checks: [check('x', '', { phases: [] })] })],
  ['duplicate phases', c => ({ ...c, checks: [check('x', '', { phases: ['task', 'task'] })] })],
  ['identical check', c => ({ ...c, checks: [check(), check()] })],
  ['null manual array', c => ({ ...c, manualChecks: null })],
  ['unknown manual field', c => ({ ...c, manualChecks: [{ id: 'm', description: 'manual', phases: ['release'], required: true, extra: 1 }] })],
  ['missing manual description', c => ({ ...c, manualChecks: [{ id: 'm', phases: ['release'], required: true }] })],
  ['invalid approval', c => ({ ...c, approvalRequiredFor: ['delete'] })],
  ['duplicate approval', c => ({ ...c, approvalRequiredFor: ['push', 'push'] })],
  ['null approval', c => ({ ...c, approvalRequiredFor: null })]
];
for (const [label, mutate] of invalidCases) test(`schema/runtime reject ${label}`, () => {
  const input = mutate(config());
  assert.equal(validateSchema(input), false, JSON.stringify(validateSchema.errors));
  assert.throws(() => validateConfig(input), { code: 'CONFIG' });
});
test('valid fixtures, example and defaults agree without mutating input', async () => {
  const example = JSON.parse(await readFile(resolve(toolkit, 'templates/engineering.config.json')));
  const fixtures = [config(), example, { ...config([check('has,comma', '', { args: ['', 'repeat', 'repeat'] })]), outputLanguage: 'en', references: { design: ['docs/My Design.md'] }, approvalRequiredFor: [] }];
  for (const input of fixtures) {
    const original = structuredClone(input);
    assert.equal(validateSchema(input), true, JSON.stringify(validateSchema.errors));
    const normalized = validateConfig(input);
    assert.equal(validateSchema(normalized), true);
    assert.deepEqual(input, original);
  }
  const defaults = validateConfig(config());
  assert.equal(defaults.outputLanguage, 'tr');
  assert.deepEqual(defaults.references, {});
  assert.deepEqual(defaults.manualChecks, []);
  assert.deepEqual(defaults.approvalRequiredFor, approvals);
  for (const field of ['outputLanguage', 'references', 'manualChecks', 'approvalRequiredFor']) assert.deepEqual(defaults[field], schema.properties[field].default);
});
test('runtime additionally enforces projected ID uniqueness within and across lists', () => {
  const inputs = [
    config([check('same'), check('same', 'process.exit(1)')]),
    { ...config(), manualChecks: [{ id: 'test', description: 'distinct object', phases: ['release'], required: true }] },
    { ...config(), manualChecks: [true, false].map(required => ({ id: 'm', description: 'manual', phases: ['task'], required })) }
  ];
  for (const input of inputs) {
    assert.equal(validateSchema(input), true, 'Standard schema cannot project IDs; documented runtime invariant.');
    assert.throws(() => validateConfig(input), /duplicate ID/);
  }
});
test('reference resolution uses the explicit project root', () => {
  const input = validateConfig({ ...config(), references: { architecture: ['docs/architecture.md'] } });
  assert.deepEqual(resolveReferences(input, '/tmp/consumer'), { architecture: ['/tmp/consumer/docs/architecture.md'] });
});
