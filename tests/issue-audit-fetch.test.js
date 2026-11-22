'use strict';
// Odczyt stanu zgłoszenia (REST + GraphQL) z podstawionym `gh`: dokładne argumenty wywołań, stronicowanie każdej
// kolekcji osobno, wartości domyślne przy brakach w odpowiedzi i fail-closed dla komentarza bez znacznika edycji.

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fetchModule = require('../.github/standard/audit/issue-audit-fetch');

const { fetchInput, run, EDIT_UNKNOWN } = fetchModule;

const { kindOf, fakeGh, wrapIssue, baseResponses } = require('./gh-fake');

test('fetchInput: złożony stan, stronicowanie każdej kolekcji i dokładne argumenty wywołań', () => {
  const { gh, calls } = fakeGh(baseResponses());
  const input = fetchInput('o/r', 7, gh);
  assert.deepEqual(input, {
    state: 'open',
    labels: ['P1', 'T2'],
    createdAt: '2026-11-01T10:00:00Z',
    bodyHtml: '<p>tresc</p>',
    body: 'surowa tresc',
    app: 'ChatGPT Codex Connector',
    barrier: '2026-11-02T10:00:00Z',
    comments: [
      { body: 'a', authorAssociation: 'OWNER', createdAt: '2026-11-01T14:00:00Z', app: '', lastEditedAt: null },
      { body: '', authorAssociation: '', createdAt: '', app: 'Aplikacja', lastEditedAt: EDIT_UNKNOWN },
      { body: 'c', authorAssociation: 'MEMBER', createdAt: '2026-11-01T15:00:00Z', app: '', lastEditedAt: '2026-11-03T10:00:00Z' }
    ],
    labelEvents: [
      { type: 'LABELED', label: 'P1', createdAt: '2026-11-01T11:00:00Z' },
      { type: 'UNLABELED', label: 'needs-triage', createdAt: '2026-11-01T12:00:00Z' },
      { type: 'UNLABELED', label: '', createdAt: '2026-11-01T13:00:00Z' }
    ],
    repoLabels: ['P1', 'audit:ok']
  });

  const shapes = calls.map(args => {
    if (args[1] === 'graphql') return [kindOf(args[3]), ...args.slice(4)].join(' ');
    return args.join(' ');
  });
  assert.deepEqual(shapes, [
    'issue -F owner=o -F name=r -F number=7',
    'comments -F owner=o -F name=r -F number=7',
    'comments -F owner=o -F name=r -F number=7 -f cursor=12345',
    'timeline -F owner=o -F name=r -F number=7',
    'timeline -F owner=o -F name=r -F number=7 -f cursor=777',
    'repoLabels -F owner=o -F name=r',
    'repoLabels -F owner=o -F name=r -f cursor=abc',
    'api repos/o/r/issues/7',
    'api --paginate --slurp repos/o/r/issues/7/comments?per_page=100'
  ]);
  for (const args of calls.filter(call => call[1] === 'graphql')) {
    assert.deepEqual(args.slice(0, 3), ['api', 'graphql', '-f']);
    assert.equal(args[4], '-F');
    assert.equal(args[6], '-F');
  }
});

test('fetchInput: zapytania GraphQL zawierają pola, które czyta reconciler', () => {
  const { gh, calls } = fakeGh(baseResponses());
  fetchInput('o/r', 7, gh);
  const queries = {};
  for (const args of calls.filter(call => call[1] === 'graphql')) queries[kindOf(args[3])] = args[3];
  for (const field of ['state', 'createdAt', 'bodyHTML', 'labels(first:100) { nodes { name } }', 'userContentEdits(first:1) { nodes { editedAt } }', 'issue(number:$number)']) {
    assert.ok(queries.issue.includes(field), 'issue: ' + field);
  }
  assert.ok(queries.comments.includes('pageInfo { hasNextPage endCursor }'));
  assert.ok(queries.comments.includes('nodes { databaseId lastEditedAt }'));
  assert.ok(queries.timeline.includes('... on LabeledEvent { createdAt label { name } }'));
  assert.ok(queries.timeline.includes('... on UnlabeledEvent { createdAt label { name } }'));
  assert.ok(queries.timeline.includes('__typename'));
  assert.ok(queries.repoLabels.includes('nodes { name }'));
  assert.ok(!queries.repoLabels.includes('issue(number'), 'etykiety repozytorium nie są w zakresie zgłoszenia');
  for (const query of Object.values(queries)) {
    assert.ok(query.includes('repository(owner:$owner, name:$name)'));
    assert.ok(query.includes('$owner:String!, $name:String!'));
  }
});

test('fetchInput: braki w odpowiedzi dają wartości domyślne, a brak edycji issue daje barierę z createdAt', () => {
  const responses = baseResponses();
  responses.issue = () => wrapIssue({ labels: { nodes: [] }, createdAt: '2026-11-01T10:00:00Z' });
  responses.rest = { body: null };
  responses.restComments = [[]];
  responses.comments = () => wrapIssue({ comments: { pageInfo: { hasNextPage: false }, nodes: [] } });
  responses.timeline = () => wrapIssue({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } });
  responses.repoLabels = () => ({ labels: { pageInfo: { hasNextPage: false }, nodes: [] } });
  const input = fetchInput('o/r', 7, fakeGh(responses).gh);
  assert.deepEqual(input, {
    state: '', labels: [], createdAt: '2026-11-01T10:00:00Z', bodyHtml: '', body: '', app: '',
    barrier: '2026-11-01T10:00:00Z', comments: [], labelEvents: [], repoLabels: []
  });

  responses.issue = () => wrapIssue({ labels: { nodes: [] } });
  const bare = fetchInput('o/r', 7, fakeGh(responses).gh);
  assert.equal(bare.createdAt, '');
  assert.equal(bare.barrier, '');
});

test('fetchInput: brak zgłoszenia w odpowiedzi przerywa z jawnym komunikatem', () => {
  const responses = baseResponses();
  responses.issue = () => ({ issue: null });
  assert.throws(() => fetchInput('o/r', 7, fakeGh(responses).gh), { message: 'Nie znaleziono issue #7 w o/r' });
  const comments = baseResponses();
  comments.comments = () => ({ issue: null });
  assert.throws(() => fetchInput('o/r', 7, fakeGh(comments).gh), { message: 'Nie znaleziono issue #7 w o/r' });
});

test('fetchInput: stan jest zapisywany małymi literami, a brak edycji komentarza (null) różni się od braku wpisu', () => {
  const responses = baseResponses();
  responses.issue = () => wrapIssue({ state: 'CLOSED', labels: { nodes: [] }, createdAt: 'x' });
  const input = fetchInput('o/r', 7, fakeGh(responses).gh);
  assert.equal(input.state, 'closed');
  assert.equal(input.comments[0].lastEditedAt, null);
  assert.equal(input.comments[1].lastEditedAt, 'unknown');
  assert.equal(EDIT_UNKNOWN, 'unknown');
});

test('run: woła `gh` przez execFileSync z kodowaniem utf8 i dużym buforem', () => {
  const original = childProcess.execFileSync;
  const seen = [];
  childProcess.execFileSync = (...args) => { seen.push(args); return 'wynik'; };
  try {
    assert.equal(run(['api', 'x']), 'wynik');
  } finally {
    childProcess.execFileSync = original;
  }
  assert.deepEqual(seen, [['gh', ['api', 'x'], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }]]);
});

test('fetchInput: domyślny `gh` to run (błąd uruchomienia przerywa przebieg)', () => {
  const original = childProcess.execFileSync;
  childProcess.execFileSync = () => { throw new Error('brak gh'); };
  try {
    assert.throws(() => fetchInput('o/r', 7), { message: 'brak gh' });
  } finally {
    childProcess.execFileSync = original;
  }
});

test('revisionBarrier: brak listy edycji albo pustej listy daje moment utworzenia, brak zgłoszenia pustą barierę', () => {
  const { revisionBarrier } = fetchModule;
  assert.equal(revisionBarrier({ createdAt: 'C', userContentEdits: {} }), 'C');
  assert.equal(revisionBarrier({ createdAt: 'C', userContentEdits: { nodes: [] } }), 'C');
  assert.equal(revisionBarrier({ createdAt: 'C', userContentEdits: { nodes: [{}] } }), 'C');
  assert.equal(revisionBarrier({ createdAt: 'C', userContentEdits: { nodes: [{ editedAt: 'E' }] } }), 'E');
  assert.equal(revisionBarrier(undefined), '');
  assert.equal(revisionBarrier({}), '');
});
