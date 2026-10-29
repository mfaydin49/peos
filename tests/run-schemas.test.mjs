import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import Ajv2020 from 'ajv/dist/2020.js';
import { validateState } from '../scripts/lib/run-state.mjs';
import { validateEvalReport } from '../scripts/lib/eval-report.mjs';
import { toolkit } from './helpers.mjs';
const ajv = new Ajv2020({ strict: true, allErrors: true });
const load = async name => ajv.compile(JSON.parse(await readFile(resolve(toolkit, 'schemas', name))));
const stateSchema = await load('state.schema.json');
const evalSchema = await load('eval-report.schema.json');
const hex = 'a'.repeat(64);

const state = (overrides = {}) => ({ schemaVersion: 1, run: '2026-10-29-avatar-upload', type: 'feature', tier: 'standard',
  stage: 'plan', gates: { spec: { status: 'approved', by: 'human', artifactHash: `sha256:${hex}`, at: '2026-10-29T10:00:00.000Z' },
    plan: { status: 'pending' } }, steps: { S1: 'done', S2: 'in_progress' },
  evals: { spec: { verdict: 'PASS', round: 1, subject: `sha256:${hex}` } }, checkpoints: ['b'.repeat(40)],
  createdAt: '2026-10-29T09:00:00.000Z', updatedAt: '2026-10-29T10:00:00Z', ...overrides });
const report = (overrides = {}) => ({ schemaVersion: 1, evaluator: 'code', focus: 'acceptance', verdict: 'PASS', mode: 'full',
  subject: `fp:${hex}`, criteria: [{ id: 'AC-1', status: 'met', evidence: 'api/avatar.test.ts rejects gif' }],
  findings: [{ id: 'F1', severity: 'medium', file: 'app/Profile.tsx', line: 88, problem: 'p', impact: 'i', fix: 'f' }],
  notAssessed: [], ...overrides });

function agree(schema, runtime, input, valid, label) {
  assert.equal(schema(input), valid, `${label}: ${JSON.stringify(schema.errors)}`);
  if (valid) assert.doesNotThrow(() => runtime(structuredClone(input)), label);
  else assert.throws(() => runtime(structuredClone(input)), label);
}

test('state schema and runtime validator agree', () => {
  const valid = [state(), state({ tier: 'trivial', gates: {}, steps: {}, evals: {}, checkpoints: [] }),
    state({ gates: { spec: { status: 'revision_requested' } }, checkpoints: ['c'.repeat(64)] })];
  for (const input of valid) agree(stateSchema, validateState, input, true, 'valid state');
  const invalid = {
    'unknown field': state({ extra: 1 }), 'bad run': state({ run: 'avatar' }), 'bad type': state({ type: 'bug' }),
    'bad tier': state({ tier: 'huge' }), 'bad stage': state({ stage: 'deploy' }),
    'unknown gate': state({ gates: { deploy: { status: 'pending' } } }),
    'approval without hash': state({ gates: { spec: { status: 'approved', by: 'human', at: '2026-10-29T10:00:00Z' } } }),
    'approval by agent': state({ gates: { spec: { status: 'approved', by: 'agent', artifactHash: `sha256:${hex}`, at: '2026-10-29T10:00:00Z' } } }),
    'bad step id': state({ steps: { step1: 'done' } }), 'bad step status': state({ steps: { S1: 'finished' } }),
    'round above limit': state({ evals: { spec: { verdict: 'FAIL', round: 4, subject: `sha256:${hex}` } } }),
    'bad subject': state({ evals: { code: { verdict: 'PASS', round: 1, subject: 'HEAD' } } }),
    'duplicate checkpoint': state({ checkpoints: ['b'.repeat(40), 'b'.repeat(40)] }),
    'local timestamp': state({ updatedAt: '2026-10-29 10:00' })
  };
  for (const [label, input] of Object.entries(invalid)) agree(stateSchema, validateState, input, false, label);
});

test('eval report schema and runtime validator agree, including verdict invariants', () => {
  const valid = [report(), report({ focus: 'all', findings: [] }),
    report({ evaluator: 'spec', focus: undefined, subject: `sha256:${hex}` }),
    report({ evaluator: 'plan', focus: 'architecture', subject: `sha256:${hex}` }),
    report({ evaluator: 'security', focus: undefined, verdict: 'FAIL', findings: [{ id: 'F1', severity: 'critical', problem: 'p', impact: 'i', fix: 'f' }] }),
    report({ evaluator: 'performance', focus: undefined, verdict: 'BLOCKED', mode: 'degraded', notAssessed: ['No budgets configured.'] })
  ].map(input => JSON.parse(JSON.stringify(input)));
  for (const input of valid) agree(evalSchema, validateEvalReport, input, true, `valid ${input.evaluator}`);
  const invalid = {
    'PASS with high finding': report({ findings: [{ id: 'F1', severity: 'high', problem: 'p', impact: 'i', fix: 'f' }] }),
    'PASS with unmet criterion': report({ criteria: [{ id: 'AC-1', status: 'not_met', evidence: 'missing retry' }] }),
    'degraded without gaps': report({ mode: 'degraded' }),
    'code without focus': report({ focus: undefined }),
    'spec with focus': report({ evaluator: 'spec', subject: `sha256:${hex}` }),
    'plan with code focus': report({ evaluator: 'plan', focus: 'quality', subject: `sha256:${hex}` }),
    'code judging artifact': report({ subject: `sha256:${hex}` }),
    'spec judging code': report({ evaluator: 'spec', focus: undefined }),
    'escaping file': report({ findings: [{ id: 'F1', severity: 'low', file: '../x', problem: 'p', impact: 'i', fix: 'f' }] }),
    'zero line': report({ findings: [{ id: 'F1', severity: 'low', line: 0, problem: 'p', impact: 'i', fix: 'f' }] }),
    'blank evidence': report({ criteria: [{ id: 'AC-1', status: 'met', evidence: ' ' }] }),
    'bad criterion id': report({ criteria: [{ id: 'AC1', status: 'met', evidence: 'e' }] }),
    'too many findings': report({ findings: Array.from({ length: 21 }, (_, i) => ({ id: `F${i + 1}`, severity: 'low', problem: 'p', impact: 'i', fix: 'f' })) }),
    'unknown field': report({ score: 9 }), 'bad evaluator': report({ evaluator: 'style' })
  };
  for (const [label, input] of Object.entries(invalid)) agree(evalSchema, validateEvalReport, JSON.parse(JSON.stringify(input)), false, label);
});
