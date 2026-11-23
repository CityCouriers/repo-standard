'use strict';
// Bramka audytu: parametry z pliku (RED i GREEN), kontrola etykiet, wyłączenia, werdykt względem triage, dziennik
// powodów i kontrakt workflow. Dane wyłącznie syntetyczne, bez sieci i bez dostępu do prawdziwego klienta GitHub.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gate = require('../.github/standard/audit/issue-audit-gate');
const params = require('../.github/standard/common/params');
const { workflowFindings } = require('./workflow-policy');
const { REPO_ROOT, tmpDir, rmDir, writeFile, blockLines, sparseCheckoutList } = require('./helpers');

const PARAMS_FILE = path.join(REPO_ROOT, '.github', 'repo-standard.json');
const WORKFLOW_FILE = path.join(REPO_ROOT, '.github', 'workflows', 'issue-audit.yml');
const SCRIPT = path.join(REPO_ROOT, '.github', 'standard', 'audit', 'issue-audit-gate.js');
const GPT_APP = 'ChatGPT Codex Connector';
const SIGN_CLAUDE = '_— Claude Code (agent lokalny)_';
const SIGN_GPT = '_— ChatGPT_';
// Mutant aktywny w procesie testowym (Stryker) musi być widoczny także w procesach potomnych uruchamianych z własnym env.
const MUTANT = process.env.__STRYKER_ACTIVE_MUTANT__ === undefined ? {} : { __STRYKER_ACTIVE_MUTANT__: process.env.__STRYKER_ACTIVE_MUTANT__ };
const REAL_PARAMS = fs.readFileSync(PARAMS_FILE, 'utf8');
const ALL_LABELS = ['P0', 'P1', 'P2', 'P3', 'T1', 'T2', 'T3', 'area:process', 'by:agent', 'needs-triage', 'audit:pending', 'audit:ok', 'audit:changes'];

// --- plik parametrów tego repozytorium (AC-3 GREEN) ----------------------------------------------------------------

const EXPECTED_PARAMS = {
  schema: 1,
  standard: { version: 'v0.0.0', sha: '0000000000000000000000000000000000000000' },
  audit: { active_since: '2026-11-15T00:00:00Z' },
  triage: { active_since: '2026-11-15T00:00:00Z' },
  quality_gate: {
    workflow: 'ci.yml',
    jobs: ['tests', 'privacy', 'secret-scan'],
    required: {
      pull_request: ['tests', 'privacy', 'secret-scan'],
      push: ['tests', 'privacy', 'secret-scan'],
      workflow_dispatch: ['tests', 'privacy', 'secret-scan']
    }
  },
  review_gate: { protected_paths: [] },
  drift: { strict: false },
  overrides: []
};

test('prawdziwy .github/repo-standard.json ma dokładnie uzgodnioną treść i przechodzi load() z B1', () => {
  assert.deepEqual(params.parseJsonObject(REAL_PARAMS), EXPECTED_PARAMS);
  assert.deepEqual(params.load(REAL_PARAMS), EXPECTED_PARAMS);
  assert.deepEqual(params.validate(EXPECTED_PARAMS), []);
});

test('znacznik „brak wydania” nie jest wydaniem: v0.0.0, SHA z zer i ci.yml z realnymi jobami', () => {
  const real = params.load(REAL_PARAMS);
  assert.equal(real.standard.version, 'v0.0.0');
  assert.match(real.standard.sha, /^0{40}$/);
  const ci = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', real.quality_gate.workflow), 'utf8');
  for (const job of real.quality_gate.jobs) assert.match(ci, new RegExp('^  ' + job + ':$', 'm'), job);
});

test('bramka czyta obie daty z prawdziwego pliku', () => {
  assert.deepEqual(gate.loadConfig(PARAMS_FILE, file => fs.readFileSync(file, 'utf8')),
    { gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z' });
});

// --- atrapa klienta i uruchomienie ---------------------------------------------------------------------------------

const BODY_HTML = '<h2>Triage</h2><table><thead><tr><th>pole</th><th>wartość</th></tr></thead><tbody>' +
  '<tr><td>priorytet</td><td><strong>P2</strong></td></tr><tr><td>ryzyko</td><td><strong>T2</strong></td></tr>' +
  '<tr><td>obszar</td><td><code>area:process</code></td></tr></tbody></table>';

const issueInput = (over = {}) => Object.assign({
  state: 'open', labels: ['by:agent'], createdAt: '2026-11-15T10:00:00Z', barrier: '2026-11-15T10:00:00Z',
  bodyHtml: BODY_HTML, body: 'Treść.\n\n' + SIGN_CLAUDE, app: '', comments: [], labelEvents: [], repoLabels: ALL_LABELS
}, over);

function harness(input, paramsText = REAL_PARAMS, env = {}) {
  const calls = { fetch: [], apply: [], read: [] };
  const logs = [];
  const errors = [];
  const deps = {
    fetch: (repo, issue) => { calls.fetch.push([repo, issue]); return input; },
    apply: (repo, issue, changes) => { calls.apply.push([repo, issue, changes]); },
    readFile: file => {
      calls.read.push(file);
      if (paramsText === null) throw Object.assign(new Error('x'), { code: 'ENOENT' });
      return paramsText;
    },
    env, log: line => logs.push(line), error: line => errors.push(line), now: () => '2026-11-15T10:00:05.123Z'
  };
  return { deps, calls, logs, errors, run: argv => gate.run(argv, deps) };
}

const ARGS = ['--issue', '7', '--repo', 'o/n'];
const withParams = over => JSON.stringify(Object.assign({}, EXPECTED_PARAMS, over), null, 2);

test('run: komplet etykiet i poprawne parametry: kod 0, jeden zapis triage i audit:pending', () => {
  const h = harness(issueInput({ labels: ['by:agent', 'P2', 'T2'], bodyHtml: BODY_HTML }));
  assert.equal(h.run(ARGS), 0);
  assert.deepEqual(h.calls.fetch, [['o/n', '7']]);
  assert.deepEqual(h.calls.read, ['.github/repo-standard.json']);
  assert.deepEqual(h.calls.apply, [['o/n', '7', { add: ['area:process', 'audit:pending'], remove: [] }]]);
  assert.deepEqual(h.errors, []);
  assert.equal(h.logs.length, 2);
  assert.match(h.logs[0], /^#7 triage: \+area:process - triage kompletny; z tabeli: area:process$/);
  assert.match(h.logs[1], /^#7: set -> audit:pending - /);
});

test('run: --dry-run nie zapisuje, --params wskazuje inny plik, repozytorium z GITHUB_REPOSITORY', () => {
  const h = harness(issueInput(), REAL_PARAMS, { GITHUB_REPOSITORY: 'x/y' });
  assert.equal(h.run(['--issue', '3', '--dry-run', '--params', 'inny.json']), 0);
  assert.deepEqual(h.calls.read, ['inny.json']);
  assert.deepEqual(h.calls.fetch, [['x/y', '3']]);
  assert.deepEqual(h.calls.apply, []);
});

test('run: ścieżka pliku parametrów domyślnie to PARAMS_PATH z B1', () => {
  assert.equal(params.PARAMS_PATH, '.github/repo-standard.json');
  assert.equal(gate.parseArgs(['--issue', '1']).params, params.PARAMS_PATH);
});

test('run: wynik trafia do GITHUB_OUTPUT i GITHUB_STEP_SUMMARY', () => {
  const dir = tmpDir();
  try {
    const out = path.join(dir, 'out.txt');
    const summary = path.join(dir, 'summary.txt');
    const h = harness(issueInput({ labels: ['by:agent', 'P2', 'T2', 'area:process', 'audit:ok'] }), REAL_PARAMS, { GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: summary });
    assert.equal(h.run(ARGS), 0);
    assert.equal(fs.readFileSync(out, 'utf8'), 'action=set\nlabel=audit:pending\nprevious=audit:ok\n');
    assert.equal(fs.readFileSync(summary, 'utf8'), h.logs.join('\n') + '\n');
  } finally { rmDir(dir); }
});

// --- RED: brak pliku, pól, zły format, data spoza kalendarza (AC-3) -------------------------------------------------

function assertStop(h, argv, pattern) {
  assert.equal(h.run(argv), 2);
  assert.equal(h.calls.fetch.length, 0, 'zero odczytów zgłoszenia');
  assert.equal(h.calls.apply.length, 0, 'zero zmian etykiet');
  assert.equal(h.errors.length, 1);
  assert.match(h.errors[0], /^::error::/);
  assert.match(h.errors[0], pattern);
  assert.equal(h.logs.length, 0);
}

test('RED: brak pliku parametrów to kod 2 i zero zmian', () => {
  assertStop(harness(issueInput(), null), ARGS, /brak pliku parametrów \.github\/repo-standard\.json \(ENOENT\)/);
});

test('RED: brak pliku parametrów bez kodu błędu systemowego', () => {
  const h = harness(issueInput());
  h.deps.readFile = () => { throw new Error('x'); };
  assert.equal(gate.run(ARGS, h.deps), 2);
  assert.match(h.errors[0], /\(błąd odczytu\)/);
});

test('RED: brak pola audit, triage albo ich active_since wskazuje nazwę pola', () => {
  const cases = [
    [p => { delete p.audit; }, /brak klucza 'audit'/],
    [p => { delete p.triage; }, /brak klucza 'triage'/],
    [p => { delete p.audit.active_since; }, /audit: brak klucza 'active_since'/],
    [p => { delete p.triage.active_since; }, /triage: brak klucza 'active_since'/],
    [p => { delete p.standard; }, /brak klucza 'standard'/]
  ];
  for (const [mutate, pattern] of cases) {
    const copy = JSON.parse(REAL_PARAMS);
    mutate(copy);
    assertStop(harness(issueInput(), JSON.stringify(copy)), ARGS, pattern);
  }
});

test('RED: null, zły typ, zły format i data spoza kalendarza w active_since', () => {
  const values = [null, 5, true, [], {}, '2026-11-15', '2026-11-15T00:00:00', '2026-11-15 00:00:00Z', '2026-9-8T00:00:00Z',
    '2026-02-30T00:00:00Z', '2026-11-15T24:00:00Z', ' 2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z ', 'wczoraj', '0'];
  for (const field of ['audit', 'triage']) {
    for (const value of values) {
      const text = withParams({ [field]: { active_since: value } });
      assertStop(harness(issueInput(), text), ARGS, new RegExp(field + '\\.active_since'));
    }
  }
});

test('RED: niepoprawny JSON i powtórzony klucz to kod 2', () => {
  assertStop(harness(issueInput(), '{'), ARGS, /nie jest poprawnym JSON/);
  assertStop(harness(issueInput(), '{"schema":1,"schema":1}'), ARGS, /powtórzony klucz/);
});

test('RED: brak numeru zgłoszenia albo repozytorium, nieznany argument i flaga bez wartości', () => {
  assertStop(harness(issueInput()), [], /użycie/);
  assertStop(harness(issueInput()), ['--issue', '1'], /użycie/);
  assertStop(harness(issueInput()), ['--repo', 'o/n'], /użycie/);
  assertStop(harness(issueInput()), [...ARGS, '--gate-active-since', '2026-11-15T00:00:00Z'], /nieznany argument: --gate-active-since/);
  for (const flag of ['--issue', '--repo', '--params']) {
    assertStop(harness(issueInput()), [flag], new RegExp(flag + ' podano bez wartości'));
    assertStop(harness(issueInput()), [flag, ''], new RegExp(flag + ' podano bez wartości'));
  }
});

test('resolveConfig: bez dat nie ma wartości domyślnej, a data musi mieć kształt schematu albo być pustym napisem', () => {
  assert.throws(() => gate.resolveConfig({}), gate.ConfigError);
  assert.throws(() => gate.resolveConfig({ gateActiveSince: '2026-11-15T00:00:00Z' }), /config\.triageActiveSince/);
  assert.throws(() => gate.resolveConfig({ triageActiveSince: '' }), /config\.gateActiveSince/);
  for (const bad of [null, undefined, 5, '2026-11-15', '2026-02-30T00:00:00Z']) {
    assert.throws(() => gate.resolveConfig({ gateActiveSince: bad, triageActiveSince: '' }), /config\.gateActiveSince/, String(bad));
    assert.throws(() => gate.resolveConfig({ gateActiveSince: '', triageActiveSince: bad }), /config\.triageActiveSince/, String(bad));
  }
  const cfg = gate.resolveConfig({ gateActiveSince: '', triageActiveSince: '' });
  assert.equal(cfg.gateActiveSince, '');
  assert.deepEqual(cfg.triageRequired, ['P', 'T', 'area']);
  assert.equal(gate.DEFAULT_CONFIG.gateActiveSince, undefined);
  assert.equal(gate.DEFAULT_CONFIG.triageActiveSince, undefined);
});

test('reconcile i reconcileTriage bez dat rzucają ConfigError, zamiast zgadywać', () => {
  assert.throws(() => gate.reconcile(issueInput(), {}), gate.ConfigError);
  assert.throws(() => gate.reconcileTriage(issueInput(), {}), gate.ConfigError);
  assert.throws(() => gate.reconcileIssue(issueInput(), {}), gate.ConfigError);
});

// --- pusty active_since: świadome wyłączenie ------------------------------------------------------------------------

const input2 = () => issueInput({ labels: ['by:agent', 'P2', 'T2', 'audit:ok'], bodyHtml: BODY_HTML });

test('pusty audit.active_since wyłącza tylko audyt: triage działa, etykiety audit:* nietknięte, nigdy audit:ok', () => {
  const h = harness(input2(), withParams({ audit: { active_since: '' } }));
  assert.equal(h.run(ARGS), 0);
  assert.deepEqual(h.calls.apply, [['o/n', '7', { add: ['area:process'], remove: [] }]]);
  // Etykieta audit:ok jest tą, którą zgłoszenie już miało; wyłączona część jej nie nadaje i nie zdejmuje.
  assert.match(h.logs.join('\n'), /#7: none -> audit:ok - wylaczone parametrem audit\.active_since/);
  assert.ok(!h.calls.apply[0][2].add.some(name => name.startsWith("audit:")) && !h.calls.apply[0][2].remove.some(name => name.startsWith("audit:")));
});

test('pusty audit.active_since: preflight nie wymaga etykiet audit:*', () => {
  const h = harness(input2(), withParams({ audit: { active_since: '' } }));
  h.deps.fetch = () => Object.assign(input2(), { repoLabels: ['P2', 'T2', 'area:process', 'needs-triage'] });
  assert.equal(h.run(ARGS), 0);
});

test('pusty triage.active_since wyłącza tylko triage: audyt działa, brak zmian etykiet triage', () => {
  const h = harness(issueInput({ labels: ['by:agent', 'P2'], bodyHtml: BODY_HTML }), withParams({ triage: { active_since: '' } }));
  assert.equal(h.run(ARGS), 0);
  assert.deepEqual(h.calls.apply, [['o/n', '7', { add: ['audit:pending'], remove: [] }]]);
  assert.match(h.logs.join('\n'), /#7 triage: bez zmian - wylaczone parametrem triage\.active_since/);
});

test('pusty triage.active_since: preflight nie wymaga needs-triage', () => {
  const h = harness(issueInput({ labels: ['by:agent', 'P2'] }), withParams({ triage: { active_since: '' } }));
  h.deps.fetch = () => issueInput({ labels: ['by:agent', 'P2'], repoLabels: ['P2', 'audit:pending', 'audit:ok', 'audit:changes'] });
  assert.equal(h.run(ARGS), 0);
});

test('oba active_since puste: kod 0 przed odczytem zgłoszenia i preflightem, zero wywołań klienta i zapisów', () => {
  const h = harness(input2(), withParams({ audit: { active_since: '' }, triage: { active_since: '' } }));
  assert.equal(h.run(ARGS), 0);
  assert.equal(h.calls.fetch.length, 0);
  assert.equal(h.calls.apply.length, 0);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(h.logs, [
    '::notice::wylaczone parametrem audit.active_since i wylaczone parametrem triage.active_since: brak zmian',
    'wylaczone parametrem audit.active_since', 'wylaczone parametrem triage.active_since'
  ]);
});

// --- kontrola etykiet (AC-4) ---------------------------------------------------------------------------------------

function assertPreflightStop(labels, expected, input = issueInput({ labels: ['by:agent', 'P2', 'T2', 'area:process'] })) {
  const h = harness(Object.assign({}, input, { repoLabels: labels }));
  assert.equal(h.run(ARGS), 2);
  assert.equal(h.calls.apply.length, 0, 'zero zmian');
  assert.deepEqual(h.errors, ['::error::STOP, w repozytorium brakuje etykiet: ' + expected + '. Bramka etykiet nie tworzy; zero zmian.']);
  assert.equal(h.logs.length, 0);
}

test('kontrola etykiet: brak needs-triage albo któregokolwiek audit:* to STOP z listą nazw, kod 2, zero zmian', () => {
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'needs-triage'), 'needs-triage');
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'audit:ok'), 'audit:ok');
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'audit:pending'), 'audit:pending');
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'audit:changes'), 'audit:changes');
  assertPreflightStop([], 'audit:changes, audit:ok, audit:pending, needs-triage');
});

test('kontrola etykiet: etykieta P, T albo area z tabeli, której nie ma w repozytorium, to STOP z jej nazwą', () => {
  const input = issueInput({ labels: ['by:agent'], bodyHtml: BODY_HTML });
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'P2'), 'P2', input);
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'T2'), 'T2', input);
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'area:process'), 'area:process', input);
  assertPreflightStop(ALL_LABELS.filter(name => !['P2', 'T2', 'area:process', 'audit:ok'].includes(name)), 'P2, T2, area:process, audit:ok', input);
});

test('kontrola etykiet: STOP także przy zamkniętym zgłoszeniu i bez zmian do zapisania', () => {
  assertPreflightStop(ALL_LABELS.filter(name => name !== 'needs-triage'), 'needs-triage', issueInput({ state: 'closed' }));
});

test('kontrola etykiet: etykiety istniejące w repozytorium, ale już nałożone na zgłoszenie, nie są wymagane z tabeli', () => {
  const h = harness(issueInput({ labels: ['by:agent', 'P2', 'T2', 'area:process'], repoLabels: ['needs-triage', 'audit:pending', 'audit:ok', 'audit:changes'] }));
  assert.equal(h.run(ARGS), 0);
});

test('kontrola etykiet: komplet etykiet przechodzi, a preflight() zwraca posortowaną listę bez duplikatów', () => {
  const cfg = gate.resolveConfig({ gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z' });
  assert.deepEqual(gate.preflight(ALL_LABELS, cfg, { missingLabels: [] }), []);
  assert.deepEqual(gate.preflight(undefined, cfg, {}), ['audit:changes', 'audit:ok', 'audit:pending', 'needs-triage']);
  assert.deepEqual(gate.preflight(['needs-triage'], cfg, { missingLabels: ['P1', 'P1', 'T3'] }),
    ['P1', 'T3', 'audit:changes', 'audit:ok', 'audit:pending']);
});

test('kontrola etykiet: zapis nie rusza bramki etykiet i nigdy nie tworzy etykiet', () => {
  const source = fs.readFileSync(SCRIPT, 'utf8');
  assert.doesNotMatch(source, /label create|--force|labels\/new|gh label/);
});

// --- błąd w trakcie przebiegu ---------------------------------------------------------------------------------------

test('run: błąd odczytu zgłoszenia to kod 2 z komunikatem Actions, bez zapisu', () => {
  const h = harness(issueInput());
  h.deps.fetch = () => { throw new Error('sieć'); };
  assert.equal(gate.run(ARGS, h.deps), 2);
  assert.deepEqual(h.errors, ['::error::błąd przebiegu: sieć']);
  assert.equal(h.calls.apply.length, 0);
});

test('run: wartość rzucona bez komunikatu też kończy się kodem 2', () => {
  const h = harness(issueInput());
  h.deps.fetch = () => { throw undefined; };
  assert.equal(gate.run(ARGS, h.deps), 2);
  assert.deepEqual(h.errors, ['::error::błąd przebiegu: undefined']);
});

// --- skrypt jako proces (bez sieci) ----------------------------------------------------------------------------------

test('proces: oba active_since puste kończy się kodem 0 bez dostępu do sieci i bez gh', () => {
  const dir = tmpDir();
  try {
    writeFile(dir, 'p.json', withParams({ audit: { active_since: '' }, triage: { active_since: '' } }));
    const r = spawnSync(process.execPath, [SCRIPT, '--issue', '1', '--repo', 'o/n', '--params', path.join(dir, 'p.json')],
      { encoding: 'utf8', env: { PATH: '', Path: '', SystemRoot: process.env.SystemRoot || '', ...MUTANT } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /wylaczone parametrem audit\.active_since/);
    assert.equal(r.stderr, '');
  } finally { rmDir(dir); }
});

test('proces: brak argumentów i zły plik parametrów to kod 2', () => {
  const none = spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', env: { PATH: '', Path: '', ...MUTANT } });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /::error::użycie/);
  const missing = spawnSync(process.execPath, [SCRIPT, '--issue', '1', '--repo', 'o/n', '--params', path.join(REPO_ROOT, 'nie-ma.json')],
    { encoding: 'utf8', env: { PATH: '', Path: '', ...MUTANT } });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /brak pliku parametrów/);
});

// --- werdykt względem triage (AC-1) ------------------------------------------------------------------------------------

const CFG = { gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z' };
const verdict = (kind, createdAt, extra = {}) => Object.assign({
  body: '/audit-' + kind + '\n\nUzasadnienie.\n\n' + SIGN_GPT, authorAssociation: 'OWNER', createdAt, app: GPT_APP, lastEditedAt: null
}, extra);
const claudeIssue = (over = {}) => issueInput(Object.assign({ labels: ['by:agent', 'P2', 'T2'] }, over));

test('werdykt sprzed uzupełnienia triage pozostaje nieważny, a po uzupełnieniu nowy werdykt jest ważny', () => {
  const missingArea = claudeIssue({ comments: [verdict('ok', '2026-11-15T10:05:00Z')] });
  const pending = gate.reconcile(missingArea, CFG);
  assert.equal(pending.label, 'audit:pending');
  assert.match(pending.reason, /^triage niekompletne: area; werdykt sprzed uzupełnienia nie obowiązuje/);

  const completed = claudeIssue({
    labels: ['by:agent', 'P2', 'T2', 'area:process'],
    labelEvents: [{ type: 'LABELED', label: 'area:process', createdAt: '2026-11-15T10:10:00Z' }],
    comments: [verdict('ok', '2026-11-15T10:05:00Z')]
  });
  const stale = gate.reconcile(completed, CFG);
  assert.equal(stale.label, 'audit:pending');
  assert.match(stale.reason, /pominięte werdykty: przed-uzupelnieniem-triage x1/);

  const fresh = gate.reconcile(Object.assign({}, completed, { comments: [verdict('ok', '2026-11-15T10:05:00Z'), verdict('ok', '2026-11-15T10:15:00Z')] }), CFG);
  assert.equal(fresh.label, 'audit:ok');
  const changes = gate.reconcile(Object.assign({}, completed, { comments: [verdict('changes', '2026-11-15T10:15:00Z')] }), CFG);
  assert.equal(changes.label, 'audit:changes');
});

test('werdykt w tej samej sekundzie co uzupełnienie triage jest nieważny (granica)', () => {
  const base = claudeIssue({
    labels: ['by:agent', 'P2', 'T2', 'area:process'],
    labelEvents: [{ type: 'LABELED', label: 'area:process', createdAt: '2026-11-15T10:10:00Z' }]
  });
  assert.equal(gate.reconcile(Object.assign({}, base, { comments: [verdict('ok', '2026-11-15T10:10:00Z')] }), CFG).label, 'audit:pending');
  assert.equal(gate.reconcile(Object.assign({}, base, { comments: [verdict('ok', '2026-11-15T10:10:01Z')] }), CFG).label, 'audit:ok');
});

test('triage uzupełnione w tym samym przebiegu z tabeli unieważnia wcześniejszy werdykt', () => {
  const input = claudeIssue({ comments: [verdict('ok', '2026-11-15T10:05:00Z')] });
  const outcome = gate.reconcileIssue(input, CFG, '2026-11-15T10:20:00.500Z');
  assert.deepEqual(outcome.triage.add, ['area:process']);
  assert.equal(outcome.audit.label, 'audit:pending');
  assert.match(outcome.audit.reason, /przed-uzupelnieniem-triage x1/);
  const next = gate.reconcileIssue(Object.assign({}, input, { labels: outcome.labels, comments: [verdict('ok', '2026-11-15T10:05:00Z'), verdict('ok', '2026-11-15T10:25:00Z')],
    labelEvents: [{ type: 'LABELED', label: 'area:process', createdAt: '2026-11-15T10:20:00Z' }] }), CFG, '2026-11-15T10:30:00Z');
  assert.equal(next.audit.label, 'audit:ok');
});

test('zgłoszenie utworzone przed aktywacją triage albo przy wyłączonym triage nie ma warunku triage dla werdyktu', () => {
  const old = claudeIssue({ createdAt: '2026-11-14T10:00:00Z', barrier: '2026-11-15T09:00:00Z', comments: [verdict('ok', '2026-11-15T10:05:00Z')] });
  assert.equal(gate.reconcile(old, CFG).label, 'audit:ok');
  assert.equal(gate.reconcile(claudeIssue({ comments: [verdict('ok', '2026-11-15T10:05:00Z')] }), { gateActiveSince: CFG.gateActiveSince, triageActiveSince: '' }).label, 'audit:ok');
  const noDate = claudeIssue({ createdAt: '', comments: [verdict('ok', '2026-11-15T10:05:00Z')] });
  assert.equal(gate.reconcile(noDate, CFG).label, 'audit:ok');
  assert.deepEqual(gate.triageGate(noDate, gate.resolveConfig(CFG)), { open: true, since: '', reason: '' });
});

test('triageGate: granica aktywacji jest domknięta od dołu', () => {
  const cfg = gate.resolveConfig(CFG);
  assert.equal(gate.triageGate(claudeIssue({ createdAt: '2026-11-15T00:00:00Z' }), cfg).open, false);
  assert.equal(gate.triageGate(claudeIssue({ createdAt: '2026-11-14T23:59:59Z' }), cfg).open, true);
});

test('triageGate: zgłoszenie od początku kompletne nie ma ograniczenia czasowego, a zdjęcie i powrót etykiety przesuwa granicę', () => {
  const cfg = gate.resolveConfig(CFG);
  const labels = ['by:agent', 'P2', 'T2', 'area:process'];
  assert.deepEqual(gate.triageGate(claudeIssue({ labels }), cfg), { open: true, since: '', reason: '' });
  const events = [
    { type: 'LABELED', label: 'area:process', createdAt: '2026-11-15T10:10:00Z' },
    { type: 'UNLABELED', label: 'area:process', createdAt: '2026-11-15T10:20:00Z' },
    { type: 'LABELED', label: 'area:process', createdAt: '2026-11-15T10:30:00Z' }
  ];
  assert.equal(gate.triageGate(claudeIssue({ labels, labelEvents: events }), cfg).since, '2026-11-15T10:30:00Z');
});

// --- dziennik powodów (bez treści komentarzy) -------------------------------------------------------------------------

test('każdy pominięty werdykt ma kod powodu w logu, bez treści i bez danych osobowych', () => {
  const full = ['by:agent', 'P2', 'T2', 'area:process'];
  const input = claudeIssue({
    labels: full,
    comments: [
      verdict('ok', '2026-11-15T10:05:00Z', { lastEditedAt: '2026-11-15T10:06:00Z' }),
      verdict('ok', '2026-11-15T10:05:00Z', { lastEditedAt: 'unknown' }),
      verdict('ok', '2026-11-15T10:05:00Z', { body: '/audit-ok\n\nbez podpisu' }),
      verdict('ok', '2026-11-15T10:05:00Z', { app: '' }),
      verdict('ok', '2026-11-15T10:05:00Z', { body: '/audit-ok\n\n' + SIGN_CLAUDE }),
      verdict('ok', '2026-11-15T09:00:00Z'),
      verdict('ok', '2026-11-15T10:05:00Z', { authorAssociation: 'CONTRIBUTOR' }),
      { body: 'zwykły komentarz', authorAssociation: 'OWNER', createdAt: '2026-11-15T10:05:00Z', app: '', lastEditedAt: null }
    ]
  });
  const result = gate.reconcile(input, CFG);
  assert.equal(result.label, 'audit:pending');
  assert.match(result.reason, /pominięto 1 komend\(ę\/y\) z powodu author_association: CONTRIBUTOR/);
  assert.match(result.reason, /pominięte werdykty: edytowany x1, brak-danych-o-edycji x1, brak-podpisu x1, podpis-niezgodny-z-aplikacja x1, zla-strona x1, przed-bariera x1$/);
  assert.doesNotMatch(result.reason, /Uzasadnienie|bez podpisu|ChatGPT|Claude/);
});

test('skippedVerdicts: bez recenzenta, bez komend i dla komend ważnych nie ma wpisów', () => {
  const cfg = gate.resolveConfig(CFG);
  assert.deepEqual(gate.skippedVerdicts([verdict('ok', '2026-11-15T10:05:00Z')], '2026-11-15T10:00:00Z', cfg, ''), []);
  assert.deepEqual(gate.skippedVerdicts(undefined, '', cfg, 'gpt'), []);
  assert.deepEqual(gate.skippedVerdicts([verdict('ok', '2026-11-15T10:05:00Z')], '2026-11-15T10:00:00Z', cfg, 'claude'), ['zla-strona x1']);
  assert.deepEqual(gate.skippedVerdicts([verdict('ok', '2026-11-15T10:05:00Z')], '2026-11-15T10:00:00Z', cfg, 'gpt'), []);
  assert.deepEqual(gate.skippedVerdicts([verdict('ok', '2026-11-15T10:05:00Z'), verdict('changes', '2026-11-15T10:05:00Z', { lastEditedAt: 'x' })], '2026-11-15T10:00:00Z', cfg, 'gpt', '2026-11-15T10:04:00Z'), ['edytowany x1']);
});

test('ważny werdykt obok pominiętych też wymienia pominięte, a nowszy ważny wygrywa', () => {
  const input = claudeIssue({
    labels: ['by:agent', 'P2', 'T2', 'area:process'],
    comments: [verdict('changes', '2026-11-15T10:05:00Z', { lastEditedAt: '2026-11-15T10:06:00Z' }), verdict('ok', '2026-11-15T10:07:00Z')]
  });
  const result = gate.reconcile(input, CFG);
  assert.equal(result.label, 'audit:ok');
  assert.match(result.reason, /pominięte werdykty: edytowany x1$/);
});

// --- etykiety dopasowywane dokładnie ---------------------------------------------------------------------------------

test('etykieta Pxyz, Portal, P12 albo T9 nie jest etykietą priorytetu ani ryzyka', () => {
  const cfg = gate.resolveConfig(CFG);
  for (const label of ['Pxyz', 'Portal', 'P12', 'P', 'p2', 'P2x', 'xP2', 'T9', 'T', 'Tx1']) {
    assert.equal(gate.inScope([label], cfg), false, label);
    const triage = gate.reconcileTriage({ state: 'open', createdAt: '2026-11-15T10:00:00Z', labels: [label], bodyHtml: '', repoLabels: ALL_LABELS }, CFG);
    assert.match(triage.reason, /brak triage'u: P, T, area/, label);
    assert.deepEqual(triage.add, ['needs-triage'], label);
  }
  for (const label of ['P0', 'P1', 'P2', 'T2', 'T3']) assert.equal(gate.inScope([label], cfg), true, label);
  assert.equal(gate.inScope(['T1', 'P3'], cfg), false);
});

// --- kontrakt workflow (AC-5, AC-6) ----------------------------------------------------------------------------------

const WORKFLOW = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const codeLines = text => text.split('\n').map(line => line.replace(/(^|\s)#.*$/, ''));

function blockAfter(text, key, stopKey) {
  const lines = blockLines(text, new RegExp('^\\s*' + key + ':\\s*>-\\s*$'), new RegExp('^\\s*' + stopKey));
  assert.ok(lines && lines.length, 'brak bloku ' + key);
  return lines.map(line => line.trim()).join(' ').trim();
}

// Minimalny interpreter wyrażeń GitHub Actions używanych w workflow (zero zależności).
function evaluate(expression, context) {
  const tokens = expression.match(/'[^']*'|\|\||&&|==|!=|!|\(|\)|,|[A-Za-z_][A-Za-z0-9_.]*|\d+/g);
  let pos = 0;
  const truthy = value => !(value === null || value === undefined || value === '' || value === 0 || value === false);
  const lookup = name => name.split('.').reduce((value, key) => (value === null || value === undefined ? null : (value[key] ?? null)), context);
  const call = (name, args) => {
    if (name === 'contains') return Array.isArray(args[0]) ? args[0].includes(args[1]) : String(args[0] ?? '').includes(args[1]);
    if (name === 'fromJSON') return JSON.parse(args[0]);
    if (name === 'format') return args[0].replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i) + 1]));
    throw new Error('nieobsługiwana funkcja ' + name);
  };
  function primary() {
    const token = tokens[pos++];
    if (token === '(') { const value = or(); pos++; return value; }
    if (token.startsWith('\'')) return token.slice(1, -1);
    if (/^\d+$/.test(token)) return Number(token);
    if (tokens[pos] === '(') {
      pos++;
      const args = [];
      while (tokens[pos] !== ')') { args.push(or()); if (tokens[pos] === ',') pos++; }
      pos++;
      return call(token, args);
    }
    return lookup(token);
  }
  function unary() { if (tokens[pos] === '!') { pos++; return !truthy(unary()); } return primary(); }
  function equality() {
    let left = unary();
    while (tokens[pos] === '==' || tokens[pos] === '!=') { const op = tokens[pos++]; const right = unary(); left = op === '==' ? left === right : left !== right; }
    return left;
  }
  function and() { let left = equality(); while (tokens[pos] === '&&') { pos++; const right = equality(); left = truthy(left) ? right : left; } return left; }
  function or() { let left = and(); while (tokens[pos] === '||') { pos++; const right = and(); left = truthy(left) ? left : right; } return left; }
  const result = or();
  assert.equal(pos, tokens.length, 'nieprzetworzone tokeny w wyrażeniu: ' + expression);
  return result;
}

const FILTER = blockAfter(WORKFLOW, 'if', 'runs-on');
const GROUP = blockAfter(WORKFLOW, 'group', 'cancel-in-progress').replace(/^\$\{\{\s*/, '').replace(/\s*\}\}$/, '');

const event = (name, action, extra = {}) => ({
  github: { event_name: name, run_id: 9001, event: Object.assign({ action, issue: { number: 5 } }, extra) }
});
const commentEvent = (action, association, over = {}) => event('issue_comment', action, { comment: { author_association: association, body: 'tekst bez komendy' }, ...over });
const runs = context => Boolean(evaluate(FILTER, context));
const groupOf = context => evaluate(GROUP, context);

test('AC-5: filtr przepuszcza zdarzenia zgłoszenia i komentarze OWNER, MEMBER, COLLABORATOR (created, edited, deleted)', () => {
  for (const action of ['opened', 'edited', 'labeled', 'unlabeled', 'reopened']) assert.equal(runs(event('issues', action)), true, action);
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR']) {
    for (const action of ['created', 'edited', 'deleted']) assert.equal(runs(commentEvent(action, association)), true, association + ' ' + action);
  }
});

test('AC-5: komentarz edytowany z usuniętym /audit- uruchamia przebieg (filtr nie czyta treści komentarza)', () => {
  assert.equal(runs(commentEvent('edited', 'OWNER', { comment: { author_association: 'OWNER', body: 'edytowany: komendy już nie ma' } })), true);
  assert.equal(runs(commentEvent('edited', 'OWNER', { comment: { author_association: 'OWNER', body: '/audit-ok' } })), true);
  assert.doesNotMatch(FILTER + GROUP, /comment\.body|issue\.body|issue\.title|changes\./);
});

test('AC-5: usunięty komentarz przechodzi niezależnie od autora, komentarze obcych i PR-ów nie', () => {
  for (const association of ['NONE', 'CONTRIBUTOR', 'FIRST_TIME_CONTRIBUTOR', '']) {
    assert.equal(runs(commentEvent('deleted', association)), true, association + ' deleted');
    assert.equal(runs(commentEvent('created', association)), false, association + ' created');
    assert.equal(runs(commentEvent('edited', association)), false, association + ' edited');
  }
  assert.equal(runs(commentEvent('created', 'OWNER', { issue: { number: 5, pull_request: { url: 'x' } } })), false);
  assert.equal(runs(commentEvent('deleted', 'OWNER', { issue: { number: 5, pull_request: { url: 'x' } } })), false);
  assert.equal(runs(event('issues', 'opened', { issue: { number: 5, pull_request: { url: 'x' } } })), false);
});

test('AC-5: zdarzenie bez znaczenia dostaje grupę skip-<run_id> i nie wypiera oczekującego przebiegu z werdyktem', () => {
  const counted = commentEvent('created', 'OWNER');
  assert.equal(groupOf(counted), 'issue-audit-5');
  assert.equal(groupOf(event('issues', 'edited')), 'issue-audit-5');
  assert.equal(groupOf(commentEvent('deleted', 'NONE')), 'issue-audit-5');
  const noise = commentEvent('created', 'NONE');
  assert.equal(groupOf(noise), 'issue-audit-skip-9001');
  const second = JSON.parse(JSON.stringify(noise));
  second.github.run_id = 9002;
  assert.equal(groupOf(second), 'issue-audit-skip-9002');
  assert.notEqual(groupOf(noise), groupOf(counted), 'zdarzenie odrzucone nie dzieli grupy ze zgłoszeniem');
  assert.equal(groupOf(commentEvent('created', 'OWNER', { issue: { number: 5, pull_request: { url: 'x' } } })), 'issue-audit-skip-9001');
  assert.equal(groupOf(commentEvent('created', 'OWNER', { issue: { number: 6 } })), 'issue-audit-6');
  assert.match(WORKFLOW, /cancel-in-progress:\s*false/);
});

test('AC-5: warunek grupy zgadza się z warunkiem joba (to samo zdarzenie, ta sama decyzja)', () => {
  const contexts = [];
  for (const association of ['OWNER', 'MEMBER', 'COLLABORATOR', 'CONTRIBUTOR', 'NONE', '']) {
    for (const action of ['created', 'edited', 'deleted']) contexts.push(commentEvent(action, association), commentEvent(action, association, { issue: { number: 5, pull_request: {} } }));
  }
  for (const action of ['opened', 'edited', 'labeled']) contexts.push(event('issues', action));
  for (const context of contexts) assert.equal(groupOf(context) === 'issue-audit-5', runs(context), JSON.stringify(context));
});

test('AC-5: lista zdarzeń workflow', () => {
  const issues = /issues:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(WORKFLOW);
  assert.deepEqual(issues[1].split(',').map(name => name.trim()).sort(), ['edited', 'labeled', 'opened', 'reopened', 'unlabeled']);
  const comment = /issue_comment:\s*\n\s*types:\s*\[([^\]]*)\]/.exec(WORKFLOW);
  assert.deepEqual(comment[1].split(',').map(name => name.trim()).sort(), ['created', 'deleted', 'edited']);
});

test('AC-5: interpreter wyrażeń rozumie to, co workflow używa (kontrola samego testu)', () => {
  assert.equal(evaluate("contains(fromJSON('[\"A\",\"B\"]'), x.y)", { x: { y: 'B' } }), true);
  assert.equal(evaluate("contains(fromJSON('[\"A\",\"B\"]'), x.y)", { x: { y: 'C' } }), false);
  assert.equal(evaluate('!a.b && (c == 1 || d != 2)', { a: {}, c: 1, d: 2 }), true);
  assert.equal(evaluate("a.b && 'x' || 'y'", { a: { b: 0 } }), 'y');
  assert.equal(evaluate("format('n-{0}-{1}', 1, 'z')", {}), 'n-1-z');
  assert.equal(evaluate("contains('abc', 'b')", {}), true);
});

// AC-6: kontrola kontraktu workflow na prawdziwym pliku i na wariantach.
function contractFindings(text) {
  const findings = [...workflowFindings(text)];
  const code = codeLines(text);
  if (code.some(line => /\bpull_request_target\b/.test(line))) findings.push('pull_request_target');
  const checkouts = code.filter(line => /uses:\s*actions\/checkout@/.test(line)).length;
  const persist = code.filter(line => /persist-credentials:\s*false\s*$/.test(line)).length;
  if (checkouts === 0 || persist !== checkouts) findings.push('persist-credentials: false przy każdym checkout');
  for (let i = 0; i < code.length; i++) {
    const run = /^(\s*)(?:-\s*)?run:\s*(.*)$/.exec(code[i]);
    if (!run) continue;
    let body = run[2];
    if (/^[|>][-+]?\s*$/.test(body.trim())) {
      body = '';
      for (let j = i + 1; j < code.length && (code[j].trim() === '' || code[j].length - code[j].trimStart().length > run[1].length); j++) body += code[j] + '\n';
    }
    if (body.includes('${{')) findings.push('interpolacja w run: ' + body.trim().slice(0, 40));
  }
  const jobs = code.findIndex(line => /^jobs:\s*$/.test(line));
  const starts = code.map((line, index) => [line, index]).filter(([line, index]) => index > jobs && /^ {2}[\w-]+:\s*$/.test(line)).map(([, index]) => index);
  starts.forEach((start, n) => {
    const block = code.slice(start + 1, starts[n + 1] ?? code.length);
    if (!block.some(line => /^ {4}permissions:/.test(line))) findings.push('job bez własnych permissions');
  });
  if (!/^\s{6}issues: write/m.test(text) && !/^\s{6}contents: read/m.test(text)) findings.push('brak minimalnych uprawnień joba');
  return findings;
}

test('AC-6: kontrakt workflow jest zielony na prawdziwym pliku', () => {
  assert.deepEqual(contractFindings(WORKFLOW), []);
});

test('AC-6: kontrakt workflow jest czerwony na wariantach z @v4, pull_request_target, ubuntu-latest i interpolacją treści', () => {
  const sha = /actions\/checkout@[0-9a-f]{40} # v7\.0\.1/.exec(WORKFLOW)[0];
  const variants = {
    '@v4': [WORKFLOW.replace(sha, 'actions/checkout@v4'), /bez pełnego SHA/],
    'SHA bez wersji': [WORKFLOW.replace(' # v7.0.1', ''), /komentarza z wersją/],
    pull_request_target: [WORKFLOW.replace('on:\n  issues:', 'on:\n  pull_request_target:\n    types: [opened]\n  issues:'), /pull_request_target/],
    'ubuntu-latest': [WORKFLOW.replace('ubuntu-24.04', 'ubuntu-latest'), /runs-on/],
    'interpolacja treści zgłoszenia': [WORKFLOW.replace('--issue "$ISSUE"', '--issue "${{ github.event.issue.title }}"'), /interpolacja w run/],
    'interpolacja w bloku run': [WORKFLOW.replace('gh issue comment "$ISSUE"', 'gh issue comment "${{ github.event.issue.number }}"'), /interpolacja w run/],
    'brak persist-credentials': [WORKFLOW.replace('          persist-credentials: false\n', ''), /persist-credentials/],
    'permissions na poziomie workflow': [WORKFLOW.replace('\npermissions: {}\n', '\npermissions:\n  issues: write\n'), /permissions na poziomie workflow/],
    'brak permissions joba': [WORKFLOW.replace('    permissions:\n      contents: read  # sparse checkout skryptów bramki i pliku parametrów\n      issues: write  # etykiety audit:*, triage i komentarz-znacznik\n', ''), /job bez własnych permissions/]
  };
  for (const [name, [text, pattern]] of Object.entries(variants)) {
    assert.notEqual(text, WORKFLOW, name + ': wariant musi różnić się od oryginału');
    assert.match(contractFindings(text).join('\n'), pattern, name);
  }
});

test('workflow: pobiera każdy plik, który bramka ładuje, oraz plik parametrów, i woła skrypt bez flag dat', () => {
  const checkedOut = sparseCheckoutList(WORKFLOW);
  assert.ok(checkedOut, 'lista sparse-checkout');
  assert.ok(checkedOut.includes('.github/repo-standard.json'));
  const seen = new Set();
  const queue = ['.github/standard/audit/issue-audit-gate.js'];
  while (queue.length) {
    const file = queue.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of fs.readFileSync(path.join(REPO_ROOT, file), 'utf8').matchAll(/require\('(\.[^']+)'\)/g)) {
      queue.push(path.posix.join(path.posix.dirname(file), match[1]).replace(/(?<!\.js)$/, '.js'));
    }
  }
  assert.deepEqual([...seen].sort(), checkedOut.filter(name => name !== '.github/repo-standard.json').sort());
  assert.match(WORKFLOW, /run: node \.github\/standard\/audit\/issue-audit-gate\.js --issue "\$ISSUE"\n/);
  assert.doesNotMatch(WORKFLOW, /ACTIVE_SINCE|active-since|TRIAGE_REQUIRED/);
});

test('workflow: komentarz-znacznik wymienia triage i nie twierdzi, że zmieniła się wyłącznie treść', () => {
  assert.match(WORKFLOW, /kompletność triage albo komentarz z werdyktem \(edycja lub usunięcie\)/);
});

test('AC-5 (negatywny): błędny warunek `deleted` w filtrze zmienia wynik, więc testy kontraktu go wykrywają', () => {
  const clause = "github.event.action == 'deleted' ||";
  assert.ok(FILTER.includes(clause), 'prawdziwy filtr zawiera warunek deleted');
  const variants = {
    'inna akcja (removed)': FILTER.replace(clause, "github.event.action == 'removed' ||"),
    'created zamiast deleted': FILTER.replace(clause, "github.event.action == 'created' ||"),
    'odwrócone porównanie': FILTER.replace(clause, "github.event.action != 'deleted' ||"),
    'brak warunku': FILTER.replace(clause, '')
  };
  const deletedByStranger = commentEvent('deleted', 'NONE');
  const createdByStranger = commentEvent('created', 'NONE');
  assert.equal(Boolean(evaluate(FILTER, deletedByStranger)), true);
  assert.equal(Boolean(evaluate(FILTER, createdByStranger)), false);
  for (const [name, variant] of Object.entries(variants)) {
    assert.notEqual(variant, FILTER, name + ': wariant musi różnić się od oryginału');
    const passesDeleted = Boolean(evaluate(variant, deletedByStranger));
    const blocksCreated = !evaluate(variant, createdByStranger);
    assert.ok(!passesDeleted || !blocksCreated, name + ': kontrakt (deleted przechodzi, created obcego nie) musi być złamany');
  }
});
