'use strict';
// Podstawiony `gh` do testów odczytu i przebiegu: rozpoznaje zapytania GraphQL po znaczniku, zapisuje wywołania.

const assert = require('node:assert/strict');

const QUERY_MARKERS = {
  issue: 'userContentEdits(first:1)',
  comments: 'comments(first:100, after:$cursor)',
  timeline: 'timelineItems(first:100, after:$cursor, itemTypes:[LABELED_EVENT, UNLABELED_EVENT])',
  repoLabels: 'labels(first:100, after:$cursor)'
};

/** Rozpoznaje zapytanie po znaczniku i zwraca jego rodzaj. */
function kindOf(query) {
  const kind = Object.keys(QUERY_MARKERS).find(name => query.includes(QUERY_MARKERS[name]));
  assert.ok(kind, 'nieznane zapytanie GraphQL');
  return kind;
}

/** `gh` zapisujące wywołania; `pages` mapuje rodzaj zapytania i kursor na odpowiedź. */
function fakeGh(responses) {
  const calls = [];
  const gh = args => {
    calls.push(args);
    if (args[0] === 'api' && args[1] === 'graphql') {
      assert.equal(args[2], '-f');
      assert.ok(args[3].startsWith('query='));
      const kind = kindOf(args[3]);
      const rest = args.slice(4);
      const cursorAt = rest.indexOf('-f');
      const cursor = cursorAt === -1 ? null : rest[cursorAt + 1].slice('cursor='.length);
      return JSON.stringify({ data: { repository: responses[kind](cursor) } });
    }
    if (args.includes('--paginate')) return JSON.stringify(responses.restComments);
    return JSON.stringify(responses.rest);
  };
  return { gh, calls };
}

const wrapIssue = node => ({ issue: node });

function baseResponses() {
  return {
    issue: () => wrapIssue({
      state: 'OPEN',
      createdAt: '2026-11-01T10:00:00Z',
      bodyHTML: '<p>tresc</p>',
      labels: { nodes: [{ name: 'P1' }, { name: 'T2' }] },
      userContentEdits: { nodes: [{ editedAt: '2026-11-02T10:00:00Z' }] }
    }),
    comments: cursor => wrapIssue(cursor === null
      ? { comments: { pageInfo: { hasNextPage: true, endCursor: '12345' }, nodes: [{ databaseId: 11, lastEditedAt: null }] } }
      : { comments: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ databaseId: 22, lastEditedAt: '2026-11-03T10:00:00Z' }] } }),
    timeline: cursor => wrapIssue(cursor === null
      ? { timelineItems: { pageInfo: { hasNextPage: true, endCursor: '777' }, nodes: [{ __typename: 'LabeledEvent', createdAt: '2026-11-01T11:00:00Z', label: { name: 'P1' } }] } }
      : { timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [
        { __typename: 'UnlabeledEvent', createdAt: '2026-11-01T12:00:00Z', label: { name: 'needs-triage' } },
        { __typename: 'UnlabeledEvent', createdAt: '2026-11-01T13:00:00Z', label: null }
      ] } }),
    repoLabels: cursor => (cursor === null
      ? { labels: { pageInfo: { hasNextPage: true, endCursor: 'abc' }, nodes: [{ name: 'P1' }] } }
      : { labels: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ name: 'audit:ok' }] } }),
    rest: { body: 'surowa tresc', performed_via_github_app: { name: 'ChatGPT Codex Connector' } },
    restComments: [
      [
        { id: 11, body: 'a', author_association: 'OWNER', created_at: '2026-11-01T14:00:00Z', performed_via_github_app: null },
        { id: 99, body: null, performed_via_github_app: { name: 'Aplikacja' } }
      ],
      [{ id: 22, body: 'c', author_association: 'MEMBER', created_at: '2026-11-01T15:00:00Z', performed_via_github_app: { } }]
    ]
  };
}

module.exports = { QUERY_MARKERS, kindOf, fakeGh, wrapIssue, baseResponses };
