'use strict';
// Przypadki brzegowe bramki audytu wskazane pomiarem mutacyjnym: granice porównań, dokładne komunikaty, kształt wyników,
// domyślne zależności przebiegu (gh, console, odczyt pliku) i czytnik tabeli Triage na zagnieżdżonych strukturach.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const gate = require('../.github/standard/audit/issue-audit-gate');
const params = require('../.github/standard/common/params');
const { fakeGh, wrapIssue } = require('./gh-fake');
const { REPO_ROOT } = require('./helpers');

const PARAMS_FILE = path.join(REPO_ROOT, '.github', 'repo-standard.json');
const REAL_PARAMS = fs.readFileSync(PARAMS_FILE, 'utf8');
const GPT_APP = 'ChatGPT Codex Connector';
const DASH = '—';
const SIGN_CLAUDE = '_' + DASH + ' Claude Code (agent lokalny)_';
const SIGN_GPT = '_' + DASH + ' ChatGPT_';
const CFG = { gateActiveSince: '2026-11-15T00:00:00Z', triageActiveSince: '2026-11-15T00:00:00Z' };
const CONFIG = gate.resolveConfig(CFG);
const ALL_LABELS = ['P0', 'P1', 'P2', 'T1', 'T2', 'T3', 'area:process', 'by:agent', 'needs-triage', 'audit:pending', 'audit:ok', 'audit:changes'];
const BARRIER = '2026-11-16T09:00:00Z';
const LATER = '2026-11-16T10:00:00Z';

const gptVerdict = over => Object.assign({ body: '/audit-ok\n\n' + SIGN_GPT, authorAssociation: 'OWNER', createdAt: LATER, app: GPT_APP, lastEditedAt: null }, over);
const issue = over => Object.assign({
  state: 'open', labels: ['P1', 'T2', 'area:process', 'by:agent'], createdAt: BARRIER, barrier: BARRIER,
  body: 'tresc\n\n' + SIGN_CLAUDE, app: '', bodyHtml: '', comments: [], labelEvents: [], repoLabels: ALL_LABELS
}, over);
const table = rows => '<h2>Triage</h2><table><tbody>' + rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('') + '</tbody></table>';

// --- definicje rodzin i konfiguracja ---------------------------------------------------------------------------------

test('rodziny triage: dokładne wzorce etykiet, kardynalność i nazwy wierszy', () => {
  const { P, T, area } = gate.TRIAGE_FAMILIES;
  assert.equal(T.row, 'ryzyko');
  assert.equal(T.single, true);
  for (const ok of ['T1', 'T2', 'T3']) assert.ok(T.label.test(ok), ok);
  for (const bad of ['T0', 'T4', 'T12', 'XT1', 'T1X', 't1']) assert.ok(!T.label.test(bad), bad);
  assert.deepEqual('T1 i T3, T9'.match(T.token), ['T1', 'T3']);
  assert.equal(P.row, 'priorytet');
  assert.equal(P.single, true);
  assert.equal(area.row, 'obszar');
  assert.equal(area.single, false);
  assert.ok(area.label.test('area:x'));
  assert.ok(!area.label.test('area:'));
  assert.ok(!area.label.test('xarea:x'));
  assert.ok(!area.label.test('area'));
  assert.deepEqual('area:github_extra, area:process'.match(area.token), ['area:github_extra', 'area:process']);
});

test('resolveConfig: data musi być napisem w formacie schematu albo pustym, bez wartości domyślnej', () => {
  const message = key => 'config.' + key + ': oczekiwano daty RRRR-MM-DDTGG:MM:SSZ albo pustego napisu, bez wartości domyślnej';
  assert.throws(() => gate.resolveConfig({}), { message: message('gateActiveSince') });
  assert.throws(() => gate.resolveConfig({ gateActiveSince: '' }), { message: message('triageActiveSince') });
  assert.throws(() => gate.resolveConfig({ gateActiveSince: 'jutro', triageActiveSince: '' }), { message: message('gateActiveSince') });
  assert.throws(() => gate.resolveConfig({ gateActiveSince: '', triageActiveSince: null }), { message: message('triageActiveSince') });
  assert.throws(() => gate.resolveConfig({ gateActiveSince: '2026-13-45T00:00:00Z', triageActiveSince: '' }), gate.ConfigError);
  assert.equal(gate.resolveConfig({ gateActiveSince: '', triageActiveSince: '' }).gateActiveSince, '');
  assert.equal(gate.resolveConfig(CFG).gateActiveSince, CFG.gateActiveSince);
});

// --- odrzucone komendy i pominięte werdykty ------------------------------------------------------------------------------

test('rejectedByAssociation: tylko komendy odrzucone wyłącznie przez association, z granicami czasu', () => {
  const reject = (comments, since) => (since === undefined
    ? gate.rejectedByAssociation(comments, BARRIER, CONFIG, 'gpt')
    : gate.rejectedByAssociation(comments, BARRIER, CONFIG, 'gpt', since));
  const contributor = over => gptVerdict(Object.assign({ authorAssociation: 'CONTRIBUTOR' }, over));
  assert.deepEqual(gate.rejectedByAssociation([contributor()], BARRIER, CONFIG, ''), []);
  assert.deepEqual(gate.rejectedByAssociation(undefined, BARRIER, CONFIG, 'gpt'), []);
  assert.deepEqual(reject([contributor()]), ['CONTRIBUTOR']);
  assert.deepEqual(reject([contributor({ authorAssociation: '' })]), ['brak']);
  assert.deepEqual(reject([contributor({ authorAssociation: undefined })]), ['brak']);
  assert.deepEqual(reject([contributor({ authorAssociation: 'OWNER' })]), [], 'uprawniony nie jest odrzucony');
  assert.deepEqual(reject([contributor({ body: 'zwykły komentarz\n\n' + SIGN_GPT })]), [], 'nie komenda');
  assert.deepEqual(reject([contributor({ lastEditedAt: LATER })]), [], 'edytowany');
  assert.deepEqual(reject([contributor({ lastEditedAt: 'unknown' })]), [], 'bez danych o edycji');
  assert.deepEqual(reject([contributor({ body: '/audit-ok\n\n' + SIGN_CLAUDE, app: '' })]), [], 'zła strona');
  assert.deepEqual(reject([contributor({ createdAt: BARRIER })]), [], 'równo z barierą nie jest nowsze');
  assert.deepEqual(reject([contributor({ createdAt: '2026-11-16T08:59:59Z' })]), []);
  assert.deepEqual(reject([contributor({ createdAt: LATER })], LATER), [], 'równo z uzupełnieniem triage nie jest nowsze');
  assert.deepEqual(reject([contributor({ createdAt: LATER })], '2026-11-16T09:30:00Z'), ['CONTRIBUTOR']);
  assert.deepEqual(reject([contributor(), contributor({ authorAssociation: 'NONE' })]), ['CONTRIBUTOR', 'NONE']);
});

test('skippedVerdicts: kody powodów z licznikami, granice i wartości domyślne', () => {
  const skip = (comments, since) => (since === undefined
    ? gate.skippedVerdicts(comments, BARRIER, CONFIG, 'gpt')
    : gate.skippedVerdicts(comments, BARRIER, CONFIG, 'gpt', since));
  assert.deepEqual(gate.skippedVerdicts(undefined, BARRIER, CONFIG, 'gpt'), []);
  assert.deepEqual(gate.skippedVerdicts([gptVerdict()], BARRIER, CONFIG, ''), []);
  assert.deepEqual(skip([gptVerdict()]), [], 'ważny werdykt nie jest pominięty (bez since)');
  assert.deepEqual(skip([gptVerdict()], ''), []);
  assert.deepEqual(skip([gptVerdict({ createdAt: BARRIER })]), ['przed-bariera x1']);
  assert.deepEqual(skip([gptVerdict({ createdAt: LATER })], LATER), ['przed-uzupelnieniem-triage x1']);
  assert.deepEqual(skip([gptVerdict({ body: 'zwykły\n\n' + SIGN_GPT, createdAt: BARRIER })]), [], 'nie komenda');
  assert.deepEqual(skip([gptVerdict({ lastEditedAt: LATER }), gptVerdict({ lastEditedAt: 'unknown' }), gptVerdict({ lastEditedAt: LATER })]),
    ['edytowany x2', 'brak-danych-o-edycji x1']);
  assert.deepEqual(skip([gptVerdict({ body: '/audit-ok' }), gptVerdict({ body: '/audit-ok\n\n' + SIGN_CLAUDE, app: '' }),
    gptVerdict({ app: '' })]), ['brak-podpisu x1', 'zla-strona x1', 'podpis-niezgodny-z-aplikacja x1']);
});

// --- oś czasu etykiet --------------------------------------------------------------------------------------------------------

test('lastScopeEntryAt: ostatnie wejście w zakres z osi czasu, w kolejności chronologicznej', () => {
  const A = '2026-11-16T01:00:00Z';
  const B = '2026-11-16T02:00:00Z';
  const C = '2026-11-16T03:00:00Z';
  const ev = (type, label, createdAt) => ({ type, label, createdAt });
  assert.equal(gate.lastScopeEntryAt(['P1'], undefined, CONFIG), '');
  assert.equal(gate.lastScopeEntryAt(['P1'], [], CONFIG), '');
  assert.equal(gate.lastScopeEntryAt(['P1'], [ev('LABELED', 'P1', A)], CONFIG), A);
  // Wejście, wyjście, wejście: liczy się najnowsze, także gdy zdarzenia podano w innej kolejności.
  const shuffled = [ev('LABELED', 'P1', C), ev('LABELED', 'P1', A), ev('UNLABELED', 'P1', B)];
  assert.equal(gate.lastScopeEntryAt(['P1'], shuffled, CONFIG), C);
  // Etykieta zdjęta po wejściu: zakres był, ale bieżący stan jest poza nim, więc nie ma wejścia do przywrócenia.
  assert.equal(gate.lastScopeEntryAt([], [ev('LABELED', 'P1', A), ev('UNLABELED', 'P1', B)], CONFIG), A);
  assert.equal(gate.lastScopeEntryAt([], [ev('UNLABELED', 'P1', B)], CONFIG), '');
  // Wpisy bez etykiety, bez czasu i puste nie są zdarzeniami.
  const junk = [null, undefined, ev('LABELED', '', A), ev('LABELED', 'P1', ''), { type: 'LABELED', label: 'P1' }];
  assert.equal(gate.lastScopeEntryAt(['P1'], junk, CONFIG), '');
  assert.equal(gate.lastScopeEntryAt(['P1'], junk.concat([ev('LABELED', 'P1', B)]), CONFIG), B);
});

test('triageGate: komplet rodzin, zgłoszenia sprzed startu i dokładny powód niekompletności', () => {
  const gateFor = (labels, extra) => gate.triageGate(Object.assign({ createdAt: BARRIER, labels }, extra), CONFIG);
  assert.deepEqual(gateFor([]), { open: false, since: '', reason: 'triage niekompletne: P, T, area; werdykt sprzed uzupełnienia nie obowiązuje' });
  assert.deepEqual(gateFor(['P1']), { open: false, since: '', reason: 'triage niekompletne: T, area; werdykt sprzed uzupełnienia nie obowiązuje' });
  assert.deepEqual(gateFor(['P1', 'P2', 'T2', 'area:x']).open, false, 'dwa priorytety to niekomplet');
  assert.deepEqual(gateFor(['P1', 'T2', 'area:x', 'area:y']), { open: true, since: '', reason: '' });
  assert.equal(gateFor(['P1', 'T2'], { createdAt: '2026-11-14T23:59:59Z' }).open, true, 'sprzed startu triage');
  assert.equal(gateFor(['P1', 'T2'], { createdAt: undefined }).open, true, 'brak daty = poza triage');
  assert.equal(gate.triageGate({ createdAt: BARRIER, labels: [] }, Object.assign({}, CONFIG, { triageActiveSince: '' })).open, true);
  assert.equal(gateFor(['P1', 'T2', 'area:x'], { labelEvents: [{ type: 'LABELED', label: 'area:x', createdAt: LATER }] }).since, LATER);
});

// --- bramka objęcia i diagnozy w komunikacie --------------------------------------------------------------------------

test('reconcile: objęcie bramką przez istniejącą etykietę audytu i przez wejście w zakres równo z datą aktywacji', () => {
  const old = '2026-09-01T00:00:00Z';
  const base = { createdAt: old, barrier: old, labels: ['P1', 'T1', 'area:process', 'by:agent'] };
  const without = gate.reconcile(issue(base), CFG);
  assert.deepEqual(without, { action: 'none', label: '', reason: 'issue nieobjęta bramką (brak backfillu)' });
  const withLabel = gate.reconcile(issue(Object.assign({}, base, { labels: base.labels.concat(['audit:pending']) })), CFG);
  assert.equal(withLabel.action, 'none');
  assert.equal(withLabel.label, 'audit:pending');
  assert.match(withLabel.reason, /\(bez zmiany\)$/);
  const atBoundary = gate.reconcile(issue(Object.assign({ labelEvents: [{ type: 'LABELED', label: 'P1', createdAt: CFG.gateActiveSince }] }, base)), CFG);
  assert.equal(atBoundary.action, 'set');
  assert.equal(atBoundary.label, 'audit:pending');
  const before = gate.reconcile(issue(Object.assign({ labelEvents: [{ type: 'LABELED', label: 'P1', createdAt: '2026-11-14T23:59:59Z' }] }, base)), CFG);
  assert.equal(before.action, 'none');
});

test('reconcile: pełny komunikat o komendzie odrzuconej przez author_association', () => {
  const result = gate.reconcile(issue({ comments: [gptVerdict({ authorAssociation: 'CONTRIBUTOR' })] }), CFG);
  assert.deepEqual(result, {
    action: 'set',
    label: 'audit:pending',
    reason: 'brak ważnego rozstrzygnięcia dla rewizji ' + BARRIER + '; pominięto 1 komend(ę/y) z powodu author_association: CONTRIBUTOR'
      + ' (dozwolone: OWNER, MEMBER, COLLABORATOR). Ukryte członkostwo w organizacji pokazuje GITHUB_TOKEN'
      + ' jako CONTRIBUTOR: ustaw członkostwo jako publiczne'
  });
});

// --- czytnik tabeli Triage ----------------------------------------------------------------------------------------------------

const row = (a, b) => '<tr><td>' + a + '</td><td>' + b + '</td></tr>';

test('topLevelElements: błąd rozbioru daje pusty wynik, znaczniki bez treści są elementami o pustej treści', () => {
  assert.deepEqual(gate.topLevelElements('<a x', () => false), []);
  assert.deepEqual(gate.topLevelElements('<p>a</p><path d="M"/><b>x</b>', () => false),
    [{ name: 'p', inner: 'a' }, { name: 'path', inner: '' }, { name: 'b', inner: 'x' }]);
  assert.deepEqual(gate.topLevelElements(undefined, () => false), []);
});

test('readTriage: sekcje thead, tbody i tfoot oraz komórki th są czytane, obce elementy w wierszu nie są komórkami', () => {
  const html = '<h2>Triage</h2><table><thead><tr><th>priorytet</th><td>P1</td></tr></thead>'
    + '<tbody><tr><td>ryzyko</td><b>zz</b><td>T2</td><td>uzasadnienie</td></tr></tbody>'
    + '<tfoot><tr><td>obszar</td><td>area:process</td></tr></tfoot></table>';
  assert.deepEqual(gate.readTriage(html), {
    rows: [['priorytet', 'P1'], ['ryzyko', 'T2', ''], ['obszar', 'area:process']],
    unreadable: ''
  });
});

test('readTriage: tylko wiersze tr tabeli, tylko bloki tabel w sekcji i kończące ją nagłówki', () => {
  const inTable = '<h2>Triage</h2><table><div><td>priorytet</td><td>P2</td></div>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(inTable).rows, [['priorytet', 'P1']]);
  const inQuote = '<h2>Triage</h2><blockquote><tr><td>priorytet</td><td>P1</td></tr></blockquote>';
  assert.deepEqual(gate.readTriage(inQuote), { rows: [], unreadable: '' });
  const noHeading = '<p>a</p><p>b</p><table>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(noHeading), { rows: [], unreadable: '' });
  const fakeHeadings = '<h2>Triage</h2><xh2>x</xh2><h2x>y</h2x><table>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(fakeHeadings).rows, [['priorytet', 'P1']]);
  const realHeading = '<h2>Triage</h2><h3>Podsekcja</h3><table>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(realHeading).rows, []);
  assert.deepEqual(gate.readTriage('<h2>Triage</h2><hr><table>' + row('priorytet', 'P1') + '</table>').rows, []);
  assert.deepEqual(gate.readTriage('<h2>Inne</h2><table>' + row('priorytet', 'P1') + '</table>').rows, []);
  assert.deepEqual(gate.readTriage('<h2>Triage</h2><table>' + row('priorytet', 'P1') + '</table><table>' + row('ryzyko', 'T2') + '</table>').rows,
    [['priorytet', 'P1'], ['ryzyko', 'T2']]);
});

test('readTriage: nieczytelny HTML daje kod powodu i zero wierszy, w tym błąd w komórce, nagłówku i dokumencie', () => {
  assert.deepEqual(gate.readTriage('<h2>Triage</h2><table><tr><td>priorytet</td><td><span>P1</span></td></tr></table>'),
    { rows: [], unreadable: 'tag-spoza-listy' });
  assert.deepEqual(gate.readTriage('<h2>Triage</h2><table><tr><td>priorytet</td><td><a hidden>P1</a></td></tr></table>'),
    { rows: [], unreadable: 'atrybut-ukrywajacy' });
  assert.deepEqual(gate.readTriage('<h2><b>Triage</i></h2>'), { rows: [], unreadable: 'zle-zamkniecie' });
  assert.deepEqual(gate.readTriage('<h2>Triage</h2><p x'), { rows: [], unreadable: 'niezamkniety-znacznik' });
  assert.deepEqual(gate.readTriage(undefined), { rows: [], unreadable: '' });
});

test('readTriage: opakowanie markdown-heading jest przezroczyste tylko dla div z tą klasą jako osobnym słowem', () => {
  const wrapped = cls => '<div class="' + cls + '"><h2>Triage</h2></div><table>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(wrapped('markdown-heading')).rows, [['priorytet', 'P1']]);
  assert.deepEqual(gate.readTriage(wrapped('a markdown-heading b')).rows, [['priorytet', 'P1']]);
  assert.deepEqual(gate.readTriage(wrapped('a\tmarkdown-heading')).rows, [['priorytet', 'P1']]);
  assert.deepEqual(gate.readTriage(wrapped('xmarkdown-heading')).rows, []);
  assert.deepEqual(gate.readTriage(wrapped('markdown-headingx')).rows, []);
  assert.deepEqual(gate.readTriage(wrapped('')).rows, []);
  const section = '<section class="markdown-heading"><h2>Triage</h2></section><table>' + row('priorytet', 'P1') + '</table>';
  assert.deepEqual(gate.readTriage(section).rows, []);
  const tableWrapper = '<h2>Triage</h2><markdown-accessiblity-table><table>' + row('priorytet', 'P1') + '</table></markdown-accessiblity-table>';
  assert.deepEqual(gate.readTriage(tableWrapper).rows, [['priorytet', 'P1']]);
  const fixedSpelling = '<h2>Triage</h2><markdown-accessibility-table><table>' + row('priorytet', 'P1') + '</table></markdown-accessibility-table>';
  assert.deepEqual(gate.readTriage(fixedSpelling).rows, [['priorytet', 'P1']]);
});

test('triageLabelFromTable: jedna wartość rodziny z drugiej komórki, deduplikacja i brak zgadywania', () => {
  const read = (rows, family) => gate.triageLabelFromTable(rows, family || 'P');
  assert.equal(read([['priorytet', 'P1']]), 'P1');
  assert.equal(read([['priorytet', 'P1 P1']]), 'P1', 'ta sama etykieta dwa razy to jedna');
  assert.equal(read([['priorytet', 'P1'], ['priorytet', 'P1']]), 'P1');
  assert.equal(read([['priorytet', 'P1 P2']]), '', 'dwie różne');
  assert.equal(read([['priorytet', 'brak']]), '', 'komórka bez etykiety');
  assert.equal(read([['priorytet']]), '', 'wiersz z jedną komórką');
  assert.equal(read([[]]), '');
  assert.equal(read([['Priorytet (P0-P4)', 'P3', 'P1 w uzasadnieniu']]), 'P3', 'tylko druga komórka');
  assert.equal(read([['ryzyko', 'T2']], 'T'), 'T2');
  assert.equal(read([['ryzyko', 'T2']], 'P'), '');
});

// --- reconcileTriage ------------------------------------------------------------------------------------------------------------

test('reconcileTriage: wyniki bez pracy mają pełny kształt i dokładny powód', () => {
  const none = reason => ({ add: [], remove: [], missingLabels: [], unreadable: '', reason });
  assert.deepEqual(gate.reconcileTriage(issue({ state: 'closed' }), CFG), none('issue zamknięta'));
  assert.deepEqual(gate.reconcileTriage(issue({ createdAt: '' }), CFG), none('brak daty utworzenia issue (fail-closed)'));
  assert.deepEqual(gate.reconcileTriage(issue({ createdAt: '2026-11-14T23:59:59Z' }), CFG), none('issue sprzed startu triage\'u'));
  assert.deepEqual(gate.reconcileTriage(issue(), { gateActiveSince: '', triageActiveSince: '' }), none(gate.DISABLED_TRIAGE));
});

test('reconcileTriage: brak list wejściowych, brak mutacji wejścia i dokładny powód z tabelą', () => {
  const html = table([['priorytet', 'P1'], ['ryzyko', 'T2'], ['obszar', 'area:process']]);
  const missingEverywhere = gate.reconcileTriage({ state: 'open', createdAt: BARRIER, labels: [], bodyHtml: html }, CFG);
  assert.deepEqual(missingEverywhere.missingLabels, ['P1', 'T2', 'area:process'], 'bez repoLabels żadna etykieta nie jest znana');
  assert.deepEqual(missingEverywhere.add, ['needs-triage']);
  assert.equal(missingEverywhere.reason, 'brak triage\'u: P, T, area');

  const labels = ['P0'];
  const result = gate.reconcileTriage(issue({ labels, bodyHtml: html, repoLabels: ['T2', 'needs-triage'] }), CFG);
  assert.deepEqual(labels, ['P0'], 'wejście nie jest zmieniane');
  assert.deepEqual(result.add, ['T2', 'needs-triage']);
  assert.deepEqual(result.missingLabels, ['area:process']);
  assert.equal(result.reason, 'brak triage\'u: area; z tabeli: T2');

  const complete = gate.reconcileTriage(issue({ labels: ['P1', 'T2', 'area:x', 'needs-triage'] }), CFG);
  assert.deepEqual(complete, { add: [], remove: ['needs-triage'], missingLabels: [], unreadable: '', reason: 'triage kompletny' });

  const unreadable = gate.reconcileTriage(issue({ labels: ['P1', 'T2', 'area:x'], bodyHtml: '<h2>Triage</h2><p x' }), CFG);
  assert.equal(unreadable.reason, 'triage kompletny; triage nieczytelne: niezamkniety-znacznik');
  assert.equal(unreadable.unreadable, 'niezamkniety-znacznik');
});

// --- reconcileIssue -------------------------------------------------------------------------------------------------------------------

test('reconcileIssue: etykieta nałożona w tym przebiegu wchodzi na oś czasu z chwilą bez ułamka sekundy', () => {
  const claudeIssue = issue({
    labels: ['T2', 'area:process', 'by:agent'],
    bodyHtml: table([['priorytet', 'P1']]),
    comments: [gptVerdict({ createdAt: LATER })]
  });
  // Werdykt z tej samej sekundy co uzupełnienie triage nie jest nowszy od niego.
  const outcome = gate.reconcileIssue(claudeIssue, CFG, '2026-11-16T10:00:00.500Z');
  assert.deepEqual(outcome.triage.add, ['P1']);
  assert.deepEqual(outcome.labels, ['T2', 'area:process', 'by:agent', 'P1']);
  assert.equal(outcome.audit.label, 'audit:pending');
  const later = gate.reconcileIssue(Object.assign({}, claudeIssue, { comments: [gptVerdict({ createdAt: '2026-11-16T10:00:01Z' })] }),
    CFG, '2026-11-16T10:00:00.500Z');
  assert.equal(later.audit.label, 'audit:ok');
});

test('reconcileIssue: wejście bez listy zdarzeń oraz zdjęcie needs-triage przy komplecie', () => {
  const bare = gate.reconcileIssue({ state: 'open', createdAt: BARRIER, barrier: BARRIER, body: '', app: '', comments: [], labels: [],
    bodyHtml: table([['priorytet', 'P1']]), repoLabels: ALL_LABELS }, CFG, BARRIER);
  assert.deepEqual(bare.labels, ['P1', 'needs-triage']);
  assert.deepEqual(bare.triage.add, ['P1', 'needs-triage']);
  const removed = gate.reconcileIssue(issue({ labels: ['P1', 'T2', 'area:x', 'needs-triage', 'by:agent'] }), CFG, BARRIER);
  assert.deepEqual(removed.labels, ['P1', 'T2', 'area:x', 'by:agent']);
  assert.deepEqual(removed.triage.remove, ['needs-triage']);
});

// --- labelChanges, preflight ---------------------------------------------------------------------------------------------------

test('labelChanges: łączy triage i audyt, nie zmienia wyniku wejściowego i zdejmuje tylko obecne etykiety audytu', () => {
  const outcome = { triage: { add: ['P1'], remove: ['needs-triage'] }, audit: { action: 'set', label: 'audit:ok' } };
  const changes = gate.labelChanges(outcome, ['audit:ok', 'audit:pending', 'x'], CONFIG);
  assert.deepEqual(changes, { add: ['P1', 'audit:ok'], remove: ['needs-triage', 'audit:pending'] });
  assert.deepEqual(outcome, { triage: { add: ['P1'], remove: ['needs-triage'] }, audit: { action: 'set', label: 'audit:ok' } });
  assert.deepEqual(gate.labelChanges({ triage: { add: [], remove: [] }, audit: { action: 'clear', label: '' } }, ['audit:ok', 'x', 'audit:changes'], CONFIG),
    { add: [], remove: ['audit:ok', 'audit:changes'] });
  assert.deepEqual(gate.labelChanges({ triage: { add: ['P1'], remove: [] }, audit: { action: 'none', label: 'audit:ok' } }, ['audit:pending'], CONFIG),
    { add: ['P1'], remove: [] });
  assert.deepEqual(gate.labelChanges({ triage: { add: [], remove: [] }, audit: { action: 'set', label: 'audit:ok' } }, [], CONFIG),
    { add: ['audit:ok'], remove: [] });
});

test('preflight: brak list to brak znanych etykiet, brak missingLabels w triage nie dodaje nazw', () => {
  assert.deepEqual(gate.preflight(undefined, CONFIG, {}), ['audit:changes', 'audit:ok', 'audit:pending', 'needs-triage']);
  assert.deepEqual(gate.preflight(ALL_LABELS, CONFIG, {}), []);
  assert.deepEqual(gate.preflight(ALL_LABELS, CONFIG, { missingLabels: ['zeta', 'alfa'] }), ['alfa', 'zeta']);
});

// --- przebieg: zapis przez gh, komunikaty, domyślne zależności ----------------------------------------------------------

/** Zależności przebiegu z zapisem wywołań `execFileSync` zamiast prawdziwego `gh`. */
function withStubbedChild(fn) {
  const original = childProcess.execFileSync;
  const calls = [];
  childProcess.execFileSync = (command, args) => { calls.push([command, args]); return ''; };
  try { fn(calls); } finally { childProcess.execFileSync = original; }
}

function harness(input, extra) {
  const logs = [];
  const errors = [];
  const deps = Object.assign({
    fetch: () => input, readFile: () => REAL_PARAMS, env: {}, log: line => logs.push(line), error: line => errors.push(line), now: () => BARRIER
  }, extra);
  return { logs, errors, deps };
}

test('run: zapis etykiet jednym wywołaniem gh z dokładnymi argumentami, a przy braku zmian bez wywołania', () => {
  withStubbedChild(calls => {
    const add = harness(issue());
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], add.deps), 0);
    assert.deepEqual(calls, [['gh', ['issue', 'edit', '5', '--repo', 'o/r', '--add-label', 'audit:pending']]]);
    assert.deepEqual(add.logs, [
      '#5 triage: bez zmian - triage kompletny',
      '#5: set -> audit:pending - brak ważnego rozstrzygnięcia dla rewizji ' + BARRIER
    ]);

    calls.length = 0;
    const remove = harness(issue({ labels: ['P1', 'T2', 'area:process', 'by:agent', 'needs-triage', 'audit:pending'] }));
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], remove.deps), 0);
    assert.deepEqual(calls, [['gh', ['issue', 'edit', '5', '--repo', 'o/r', '--remove-label', 'needs-triage']]]);
    assert.equal(remove.logs[0], '#5 triage: -needs-triage - triage kompletny');
    assert.equal(remove.logs[1], '#5: none -> audit:pending - brak ważnego rozstrzygnięcia dla rewizji ' + BARRIER + ' (bez zmiany)');

    calls.length = 0;
    const both = harness(issue({ labels: ['T2', 'area:process', 'by:agent', 'audit:ok'], bodyHtml: table([['priorytet', 'P1']]) }));
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], both.deps), 0);
    assert.deepEqual(calls, [['gh', ['issue', 'edit', '5', '--repo', 'o/r', '--add-label', 'P1', '--add-label', 'audit:pending',
      '--remove-label', 'audit:ok']]]);
    assert.equal(both.logs[0], '#5 triage: +P1 - triage kompletny; z tabeli: P1');

    calls.length = 0;
    const swap = harness(issue({ labels: ['T2', 'area:process', 'by:agent', 'needs-triage'], bodyHtml: table([['priorytet', 'P1']]) }));
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], swap.deps), 0);
    assert.equal(swap.logs[0], '#5 triage: +P1 -needs-triage - triage kompletny; z tabeli: P1');

    calls.length = 0;
    const outside = harness(issue({ labels: ['P3', 'T1', 'area:process', 'by:agent'] }));
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], outside.deps), 0);
    assert.equal(outside.logs[1], '#5: none - issue poza zakresem bramki');

    calls.length = 0;
    const same = harness(issue({ labels: ['P1', 'T2', 'area:process', 'by:agent', 'audit:pending'] }));
    assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], same.deps), 0);
    assert.deepEqual(calls, []);
  });
});

test('run: komunikaty błędów mają dokładną postać, a błąd niebędący ConfigError jest oznaczony jako błąd przebiegu', () => {
  const failing = harness(issue(), { fetch: () => { throw new Error('boom'); } });
  assert.equal(gate.run(['--issue', '5', '--repo', 'o/r'], failing.deps), 2);
  assert.deepEqual(failing.errors, ['::error::błąd przebiegu: boom']);
  const config = harness(issue());
  assert.equal(gate.run(['--issue', '5', '--repo', 'o/r', '--inne'], config.deps), 2);
  assert.deepEqual(config.errors, ['::error::nieznany argument: --inne']);
  const usage = harness(issue());
  assert.equal(gate.run([], usage.deps), 2);
  assert.match(usage.errors[0], /^::error::użycie: issue-audit-gate\.js --issue/);
});

test('loadConfig: błąd walidacji B1 dostaje nazwę pliku, inny błąd przechodzi bez opakowania', () => {
  assert.throws(() => gate.loadConfig('p.json', () => '{}'), error => error instanceof gate.ConfigError && error.message.startsWith('plik parametrów p.json: '));
  assert.throws(() => gate.loadConfig('p.json', () => { throw new Error('x'); }), { message: 'brak pliku parametrów p.json (błąd odczytu)' });
  const original = params.load;
  const boom = new Error('inny');
  params.load = () => { throw boom; };
  try {
    assert.throws(() => gate.loadConfig('p.json', () => '{}'), error => error === boom);
  } finally { params.load = original; }
});

test('run: domyślne zależności (gh, console, odczyt pliku, repozytorium z env) działają bez wstrzyknięcia', () => {
  const responses = {
    issue: () => wrapIssue({
      state: 'OPEN', createdAt: BARRIER, bodyHTML: '', labels: { nodes: ['P1', 'T2', 'area:process', 'by:agent'].map(name => ({ name })) },
      userContentEdits: { nodes: [] }
    }),
    comments: () => wrapIssue({ comments: { pageInfo: { hasNextPage: false }, nodes: [] } }),
    timeline: () => wrapIssue({ timelineItems: { pageInfo: { hasNextPage: false }, nodes: [] } }),
    repoLabels: () => ({ labels: { pageInfo: { hasNextPage: false }, nodes: ALL_LABELS.map(name => ({ name })) } }),
    rest: { body: 'tresc\n\n' + SIGN_CLAUDE },
    restComments: [[]]
  };
  const { gh, calls } = fakeGh(responses);
  const original = childProcess.execFileSync;
  const log = console.log;
  const error = console.error;
  const logs = [];
  const errors = [];
  const saved = {};
  for (const key of ['GITHUB_REPOSITORY', 'GITHUB_STEP_SUMMARY', 'GITHUB_OUTPUT']) saved[key] = process.env[key];
  delete process.env.GITHUB_STEP_SUMMARY;
  delete process.env.GITHUB_OUTPUT;
  process.env.GITHUB_REPOSITORY = 'o/r';
  childProcess.execFileSync = (command, args) => (command === 'gh' ? gh(args) : '');
  console.log = line => logs.push(line);
  console.error = line => errors.push(line);
  let code;
  let missingCode;
  try {
    code = gate.run(['--issue', '7', '--params', PARAMS_FILE]);
    console.log = log;
    missingCode = gate.run(['--issue', '7', '--params', path.join(REPO_ROOT, 'nie-ma.json')]);
  } finally {
    childProcess.execFileSync = original;
    console.log = log;
    console.error = error;
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
  assert.equal(code, 0);
  assert.equal(logs.length, 2);
  assert.match(logs[0], /^#7 triage: bez zmian - /);
  assert.match(logs[1], /^#7: set -> audit:pending - /);
  assert.deepEqual(calls.at(-1), ['issue', 'edit', '7', '--repo', 'o/r', '--add-label', 'audit:pending']);
  assert.equal(missingCode, 2);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^::error::brak pliku parametrów /);
});

test('reconcileTriage: kilka etykiet z tabeli w powodzie jest oddzielonych przecinkiem i spacją', () => {
  const result = gate.reconcileTriage(issue({ labels: [], bodyHtml: table([['priorytet', 'P1'], ['ryzyko', 'T2']]) }), CFG);
  assert.equal(result.reason, 'brak triage\'u: area; z tabeli: P1, T2');
});
