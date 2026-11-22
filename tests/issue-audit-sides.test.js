'use strict';
// Strony autora i werdyktu: dokładne powody odmowy (trafiają do publicznego logu), kotwice wzorców i wejścia brzegowe.

const test = require('node:test');
const assert = require('node:assert/strict');
const sides = require('../.github/standard/audit/issue-audit-sides');

const { CLAUDE, GPT, GPT_APP, BY_AGENT, leadingLine, signatureSide, reviewerOf, authorSide, commentSide } = sides;
const DASH = '—';
const CLAUDE_SIG = '_' + DASH + ' Claude Code (agent lokalny)_';
const GPT_SIG = '_' + DASH + ' ChatGPT_';

test('leadingLine: pierwsza niepusta linia, bez bloku kodu, bez tekstu daje pusty napis', () => {
  assert.equal(leadingLine(undefined), '');
  assert.equal(leadingLine(null), '');
  assert.equal(leadingLine(''), '');
  assert.equal(leadingLine('  \n \n'), '');
  assert.equal(leadingLine('\n  /audit-ok  \nreszta'), '/audit-ok');
  assert.equal(leadingLine('    /audit-ok'), '');
  assert.equal(leadingLine('\t/audit-ok'), '');
  assert.equal(leadingLine('  \t/audit-ok'), '');
  assert.equal(leadingLine('   /audit-ok'), '/audit-ok');
  // Wcięcie w środku linii nie jest blokiem kodu.
  assert.equal(leadingLine('a    b'), 'a    b');
  assert.equal(leadingLine('a\tb'), 'a\tb');
  assert.equal(leadingLine('a\r\nb'), 'a');
  assert.equal(leadingLine('a\rb'), 'a');
});

test('signatureSide: kotwice wzorców, kursywa, wcięcie i wejścia brzegowe', () => {
  assert.equal(signatureSide(undefined), '');
  assert.equal(signatureSide(''), '');
  assert.equal(signatureSide('   \n'), '');
  assert.equal(signatureSide('tresc\n\n' + CLAUDE_SIG), CLAUDE);
  assert.equal(signatureSide('tresc\n' + GPT_SIG + '\n  \n'), GPT);
  assert.equal(signatureSide(DASH + ' ChatGPT'), GPT);
  assert.equal(signatureSide(DASH + ' Claude Code (agent lokalny, koordynator)'), CLAUDE);
  assert.equal(signatureSide('    ' + DASH + ' ChatGPT'), '');
  assert.equal(signatureSide('tresc ' + DASH + ' ChatGPT'), '', 'podpis musi zaczynać linię');
  assert.equal(signatureSide('x ' + DASH + ' Claude Code (agent lokalny)'), '');
  assert.equal(signatureSide(DASH + ' ChatGPT dopisek'), '');
  assert.equal(signatureSide('x_' + DASH + ' ChatGPT_'), '', 'kursywa musi zaczynać linię');
  assert.equal(signatureSide('_' + DASH + ' ChatGPT_ ogon'), '', 'kursywa musi kończyć linię');
  assert.equal(signatureSide(DASH + ' Claude Code (agent lokalny, rola) x'), '');
});

test('reviewerOf: strona przeciwna, a dla nieustalonej autora pusty napis', () => {
  assert.equal(reviewerOf(CLAUDE), GPT);
  assert.equal(reviewerOf(GPT), CLAUDE);
  assert.equal(reviewerOf(''), '');
  assert.equal(reviewerOf('inna'), '');
});

test('authorSide: dokładne powody każdej odmowy i dwa poprawne przypadki', () => {
  const claudeBody = 'tresc\n' + CLAUDE_SIG;
  const gptBody = 'tresc\n' + GPT_SIG;
  assert.deepEqual(authorSide('tresc bez podpisu', [BY_AGENT], ''), { side: '', reason: 'brak podpisu strony w ostatniej linii treści' });
  assert.deepEqual(authorSide(claudeBody, [BY_AGENT], 'Inna aplikacja'),
    { side: '', reason: 'zgłoszenie utworzone przez nieznaną aplikację "Inna aplikacja"' });
  assert.deepEqual(authorSide(claudeBody, [], ''), { side: '', reason: 'podpis Claude Code bez etykiety by:agent' });
  assert.deepEqual(authorSide(claudeBody, undefined, ''), { side: '', reason: 'podpis Claude Code bez etykiety by:agent' });
  assert.deepEqual(authorSide(claudeBody, [BY_AGENT], GPT_APP),
    { side: '', reason: 'podpis Claude Code, ale zgłoszenie utworzył ' + GPT_APP });
  assert.deepEqual(authorSide(claudeBody, [BY_AGENT], null), { side: CLAUDE, reason: 'podpis Claude Code + by:agent + utworzone przez gh' });
  assert.deepEqual(authorSide(gptBody, [BY_AGENT], GPT_APP), { side: '', reason: 'podpis ChatGPT przy etykiecie by:agent' });
  assert.deepEqual(authorSide(gptBody, [], ''), { side: '', reason: 'podpis ChatGPT, ale zgłoszenia nie utworzył ' + GPT_APP });
  assert.deepEqual(authorSide(gptBody, [], GPT_APP), { side: GPT, reason: 'podpis ChatGPT + bez by:agent + utworzone przez ' + GPT_APP });
});

test('commentSide: podpis musi zgadzać się z aplikacją; brak pola aplikacji znaczy gh', () => {
  assert.equal(commentSide({ body: CLAUDE_SIG }), CLAUDE);
  assert.equal(commentSide({ body: CLAUDE_SIG, app: '' }), CLAUDE);
  assert.equal(commentSide({ body: CLAUDE_SIG, app: GPT_APP }), '');
  assert.equal(commentSide({ body: GPT_SIG, app: GPT_APP }), GPT);
  assert.equal(commentSide({ body: GPT_SIG }), '');
  assert.equal(commentSide({ body: 'bez podpisu' }), '');
});
