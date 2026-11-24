'use strict';
// Czysta logika kontroli rozjazdu (bez sieci i bez dysku): oczyszczanie tekstu, odcisk listy różnic, treść i plan
// zgłoszenia „Rozjazd wzorca", wybór zaufanego pinu wzorca dla PR, decyzja o wczesnym wyjściu.

const crypto = require('node:crypto');

const CONTEXT = 'standard-drift';
const MARKER = '<!-- repo-standard-drift -->';
const FINGERPRINT_LINE = /^<!-- fingerprint: ([0-9a-f]{64}) -->$/;
const BOT = 'github-actions[bot]';
const LABELS = ['P3', 'T1', 'area:process', 'by:agent'];
const MAX_RECALC = 25;
const MAX_LISTED = 50;
const MAX_FILES = 3000;
const POCKET = 'https://github.com/CityCouriers/repo-standard#poprawka-z-konsumenta';

/** Tekst z danych (PR, plik parametrów) do logu, podsumowania i opisu statusu: bez znaków sterujących i znaczników. */
function sanitize(value, max = 300) {
  const text = String(value)
    .replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029]/g, ' ')
    .replace(/`/g, "'")
    .replace(/</g, '‹')
    .replace(/>/g, '›')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Odcisk listy różnic: nie zależy od kolejności ani powtórzeń. */
function fingerprint(findings) {
  const unique = [...new Set(findings)].sort();
  return crypto.createHash('sha256').update(unique.join('\n')).digest('hex');
}

/** Ciało commit status (domyślnie kontekst `standard-drift`); opis ma limit GitHuba (140 znaków). */
function statusBody(state, description, context = CONTEXT) {
  return { state, context, description: sanitize(description, 140) };
}

/**
 * Czy PR dotyka plików wzorca: ścieżka (także poprzednia nazwa przy zmianie nazwy) z manifestu albo cokolwiek w
 * `.github/`. Lista plików obcięta przez API (MAX_FILES) liczy się jak dotknięcie: fail-closed.
 */
function touchesStandard(files, managedPaths) {
  if (files.length >= MAX_FILES) return true;
  const managed = new Set(managedPaths);
  const hit = (name) => typeof name === 'string' && (managed.has(name) || name.startsWith('.github/'));
  return files.some((file) => hit(file.filename) || hit(file.previous_filename));
}

/**
 * Pin wzorca dla PR: zaufany jest pin z bazy. Pin z HEAD obowiązuje tylko wtedy, gdy wersja wskazuje tag wydania
 * wzorca, a SHA jest commitem tego tagu (`resolve(version)` zwraca pełny SHA albo rzuca). Inaczej: pin bazy
 * i różnica w liście. Zwraca { pin, findings, notes }.
 */
async function choosePin(basePin, headPin, resolve) {
  if (headPin.version === basePin.version && headPin.sha === basePin.sha) return { pin: basePin, findings: [], notes: [] };
  let sha;
  try {
    sha = await resolve(headPin.version);
  } catch (error) {
    return { pin: basePin, findings: [`standard: zmiana wersji w PR nieuznana, nie rozpoznano tagu ${headPin.version}: ${sanitize(error.message)}`], notes: [] };
  }
  if (sha !== headPin.sha) {
    return { pin: basePin, findings: [`standard: zmiana wersji w PR nieuznana, SHA nie jest commitem tagu ${headPin.version}`], notes: [] };
  }
  return { pin: headPin, findings: [], notes: [`standard: PR zmienia wzorzec z ${basePin.version} na ${headPin.version} (tag wydania potwierdzony; zgoda na zmianę to werdykt z linią Wzorzec)`] };
}

/** Zgłoszenia „Rozjazd wzorca" należące do automatu: otwarte, nie PR, autor bot, znacznik w pierwszej linii, etykiety. */
function ownIssues(list) {
  return list
    .filter((issue) => issue
      && !Object.prototype.hasOwnProperty.call(issue, 'pull_request')
      && issue.state === 'open'
      && issue.user?.login === BOT
      && typeof issue.body === 'string'
      && issue.body.split(/\r?\n/, 1)[0] === MARKER
      && Array.isArray(issue.labels)
      && LABELS.every((name) => issue.labels.some((label) => label?.name === name)))
    .sort((a, b) => a.number - b.number);
}

function storedFingerprint(body) {
  // `exec(undefined)` szuka napisu "undefined", więc brak drugiej linii daje null bez osobnego warunku.
  const match = FINGERPRINT_LINE.exec(body.split(/\r?\n/, 3)[1]);
  return match ? match[1] : null;
}

function renderIssue({ repo, version, findings }) {
  const unique = [...new Set(findings)].sort();
  const shown = unique.slice(0, MAX_LISTED).map((line) => sanitize(line, 400));
  const more = unique.length > MAX_LISTED ? `\n... i ${unique.length - MAX_LISTED} kolejnych (pełna lista w podsumowaniu przebiegu)` : '';
  const body = [
    MARKER,
    `<!-- fingerprint: ${fingerprint(findings)} -->`,
    '## Rozjazd wzorca',
    '',
    `Repozytorium \`${sanitize(repo, 100)}\`, wzorzec \`${sanitize(version, 30)}\`. Rozbieżności: ${unique.length}.`,
    '',
    '```text',
    shown.join('\n') + more,
    '```',
    '',
    `Naprawa: \`node .github/standard/standard_sync.js apply --version ${sanitize(version, 30)}\`, przegląd wyniku i zwykły PR.`,
    `Poprawka znaleziona u konsumenta wraca do wzorca: ${POCKET}`,
    '',
    '_Zgłoszenie prowadzi automat `standard-drift` (jedno na repozytorium). Treść jest nadpisywana przy zmianie listy, a zgłoszenie zamykane, gdy rozjazd ustanie._',
  ].join('\n');
  return { title: 'Rozjazd wzorca', body, labels: LABELS };
}

/**
 * Plan zmian zgłoszenia: lista operacji { type: create|update|comment|close, number?, ... } oraz `anomaly`
 * (więcej niż jedno otwarte zgłoszenie automatu). `open` to wynik `ownIssues`.
 */
function planIssue(open, drift) {
  const anomaly = open.length > 1;
  if (!drift) {
    return { anomaly, ops: open.map((issue) => ({ type: 'close', number: issue.number, comment: 'Rozjazd ustał: kontrola nie znajduje już różnic. Zamykam zgłoszenie.' })) };
  }
  const rendered = renderIssue(drift);
  if (open.length === 0) return { anomaly, ops: [{ type: 'create', ...rendered }] };
  const target = open[0];
  const changed = storedFingerprint(target.body) !== fingerprint(drift.findings);
  const ops = target.body === rendered.body ? [] : [{ type: 'update', number: target.number, body: rendered.body }];
  if (changed) ops.push({ type: 'comment', number: target.number, comment: `Lista różnic zmieniła się (odcisk ${fingerprint(drift.findings).slice(0, 12)}). Aktualna lista jest w treści zgłoszenia.` });
  return { anomaly, ops };
}

module.exports = {
  CONTEXT, MARKER, BOT, LABELS, MAX_RECALC, MAX_LISTED, MAX_FILES,
  sanitize, fingerprint, statusBody, touchesStandard, choosePin, ownIssues, storedFingerprint, renderIssue, planIssue,
};
