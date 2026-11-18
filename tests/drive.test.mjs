import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { repository, toolkit } from './helpers.mjs';
import { classify, inputLines, runName } from '../scripts/peos-drive.mjs';

test('the driver classifies from the investigator report, and flags win', () => {
  const report = 'STATUS: REPORT\nAffected: src/query.js\nTrust boundary: no, a page count\nSuggested: type fix, tier trivial, because one line\nOpen: none';
  assert.deepEqual(classify(report), { type: 'fix', tier: 'trivial', open: '' });
  assert.deepEqual(classify(report, { tier: 'standard', type: 'change' }), { type: 'change', tier: 'standard', open: '' });
  // A change that itself alters a trust boundary is at least standard, unless the user chose the tier.
  const risky = 'Trust boundary: yes, it changes who may delete\nSuggested: type `feature`, tier `small`, because few files\nOpen: who may delete: owner only or any member?';
  assert.deepEqual(classify(risky), { type: 'feature', tier: 'standard', open: 'who may delete: owner only or any member?' });
  assert.equal(classify(risky, { tier: 'small' }).tier, 'small');
  assert.deepEqual(classify('Suggested: type app, tier small, because new'), { type: 'app', tier: 'large', open: '' });
  assert.deepEqual(classify('no usable report'), { type: 'change', tier: 'small', open: '' });
});

test('the driver names a run from the request and passes inputs one per line', () => {
  assert.equal(runName('With 25 notes and a page size of 10, the list says there are 2 pages'), 'notes-page-size-list');
  assert.match(runName('Günde iki litre su iç!'), /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.equal(runName('!!!'), 'run');
  assert.equal(inputLines({ spec: '/p/spec.md', steps: ['S1', 'S2'], design: undefined, focus: 'all' }), 'spec: /p/spec.md\nsteps: ["S1","S2"]\nfocus: all');
});

test('gate decisions are refused from inside a Claude Code session, and usage errors are plain', async t => {
  const project = await repository(t);
  const drive = (args, env = {}) => spawnSync(process.execPath, [resolve(toolkit, 'scripts/peos-drive.mjs'), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
  const refused = drive(['approve', '--project', project], { CLAUDECODE: '1' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /typed by the user in a terminal/);
  assert.match(drive(['start', '--project', project]).stderr, /Give the request/);
  assert.match(drive(['start']).stderr, /Usage/);
});
