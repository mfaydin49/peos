// Options accepted by each peos-run action (besides --json). Plugin tests check skills against this table.
export const runActions = {
  init: ['project', 'name', 'type', 'tier'],
  status: ['project', 'run'],
  brief: ['project', 'run'],
  fingerprint: ['project'],
  'record-checks': ['project', 'run', 'phase', 'checks'],
  'record-eval': ['project', 'run', 'report'],
  approve: ['project', 'run', 'gate'],
  revise: ['project', 'run', 'gate'],
  'reset-eval': ['project', 'run', 'key'],
  advance: ['project', 'run', 'to'],
  step: ['project', 'run', 'step', 'status'],
  begin: ['project', 'run', 'step'],
  finish: ['project', 'run', 'step'],
  grant: ['project', 'action', 'target', 'run'],
  changes: ['project', 'run'],
  'record-baseline': ['project', 'run'],
  map: ['project', 'run'],
  setup: ['project']
};
