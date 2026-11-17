import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fixture, toolkit } from './helpers.mjs';
import { collect, compare, parseTask } from '../scripts/bench.mjs';

test('every benchmark task names a fixture that exists, a request and scoring criteria', async () => {
  const files = (await readdir(resolve(toolkit, 'benchmarks/tasks'))).filter(file => file.endsWith('.md'));
  assert.ok(files.length >= 4);
  for (const file of files) {
    const task = parseTask(await readFile(resolve(toolkit, 'benchmarks/tasks', file), 'utf8'));
    assert.equal(`${task.id}.md`, file);
    assert.ok(task.request.length > 40 && task.scoring.length >= 3 && task.expect, file);
    if (task.fixture !== 'empty') assert.ok((await readdir(resolve(toolkit, 'benchmarks/fixtures', task.fixture))).includes('package.json'), file);
  }
});

test('collect reads cost, rework, questions and decisions from a run directory', async t => {
  const directory = await fixture(t, null);
  assert.equal(await collect(directory), null, 'no state');
  const at = '2026-01-01T00:00:00.000Z';
  await writeFile(resolve(directory, 'state.json'), JSON.stringify({ run: '2026-01-01-x', type: 'app', tier: 'large', stage: 'release', verifyFailures: 1,
    gates: { spec: { status: 'approved', at }, architecture: { status: 'approved', at }, plan: { status: 'approved', at: '2026-01-01T01:00:00.000Z' } },
    evals: { spec: { verdict: 'PASS', round: 2 }, 'code-quality': { verdict: 'PASS', round: 3, carried: true }, ui: { verdict: 'FAIL', round: 1 } } }));
  await writeFile(resolve(directory, 'idea.md'), '# Idea\nA habit tracker.\n\n## Answers\n<!-- note -->\n- Platform? — web\n- Style? — calm\n');
  await writeFile(resolve(directory, 'usage.json'), JSON.stringify({ sessions: { a: '' }, calls: { m: [1, 2, 3, 4], e: [0, 10, 0, 90, 'peos:eval-code'] } }));
  await mkdir(resolve(directory, 'evals'));
  await writeFile(resolve(directory, 'evals/ui.json'), JSON.stringify({ findings: [{ severity: 'high' }, { severity: 'low' }, { severity: 'medium' }] }));
  await writeFile(resolve(directory, 'evals/ui.prev.json'), JSON.stringify({ findings: [{ severity: 'low' }] }));
  const numbers = await collect(directory);
  assert.deepEqual([numbers.finished, numbers.decisions, numbers.questions, numbers.evaluations, numbers.carried, numbers.reworkRounds, numbers.notPassed, numbers.nonBlockingFindings],
    [true, 2, 2, 3, 1, 4, ['ui'], 2]);
  assert.deepEqual([numbers.tokens, numbers.modelCalls, numbers.byAgent], [110, 2, { 'peos:eval-code': 100, main: 10 }]);
  assert.deepEqual(compare({ t: { ...numbers, scored: '3/8' } }, { t: { ...numbers, tokens: 55, reworkRounds: 1, scored: '7/8' }, u: numbers }),
    ['t: tokens 0.0M → 0.0M (-50%), rework 4 → 1, questions 2 → 2, decisions 2 → 2, scored 3/8 → 7/8, finished true → true',
      'u: tokens — → 0.0M (—), rework — → 4, questions — → 2, decisions — → 2, scored — → —, finished — → true']);
});

test('prepare makes a committed project from the fixture and prints the request', async t => {
  const into = resolve(await fixture(t, null), 'project');
  const result = spawnSync(process.execPath, [resolve(toolkit, 'scripts/bench.mjs'), 'prepare', '--task', 'feature-tag-filter', '--into', into], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/peos:start Let me filter the note list by tag/);
  assert.equal(spawnSync('git', ['status', '--porcelain'], { cwd: into, encoding: 'utf8' }).stdout, '');
  assert.ok((await readdir(into)).includes('package.json'));
  assert.equal(spawnSync(process.execPath, [resolve(toolkit, 'scripts/bench.mjs'), 'prepare', '--task', 'feature-tag-filter', '--into', into]).status, 2, 'never into a directory with files');
});
