#!/usr/bin/env node
'use strict';

/**
 * Bramka audytu specyfikacji zgłoszeń i triage.
 *
 * Zgłoszenie w zakresie dostaje jawny stan audytu: `audit:pending`, `audit:ok` albo `audit:changes`. Recenzent
 * rozstrzyga komentarzem zaczynającym się od `/audit-ok` albo `/audit-changes`, a edycja treści unieważnia
 * rozstrzygnięcie.
 *
 * Model: RECONCILER, nie zestaw handlerów zdarzeń. GitHub Actions przy `cancel-in-progress: false` trzyma w grupie
 * tylko jeden przebieg oczekujący i ANULUJE go, gdy przyjdzie kolejne zdarzenie. Zdarzenie nie jest więc opóźniane,
 * tylko tracone. Dlatego każdy przebieg czyta aktualny stan i wylicza z niego etykietę docelową; utrata jednego
 * przebiegu nie gubi semantyki, bo następny naprawia stan.
 *
 * Konsekwencje tej decyzji, których nie wolno „uprościć”:
 *   1. stan czytamy w chwili wykonania, nigdy z payloadu zdarzenia;
 *   2. bariera rewizji pochodzi z `userContentEdits`, nie z komentarza-znacznika (znacznik publikuje przebieg, który
 *      można anulować, więc nie może być źródłem prawdy);
 *   3. brak bariery = brak zapisu (fail-closed);
 *   4. najnowszej komendy szukamy po WSZYSTKICH komentarzach, nie po pierwszej stronie.
 *
 * Triage. Zgłoszenie bez etykiet triage było dla bramki niewidoczne, więc ten sam reconciler pilnuje też ich:
 * brakujące etykiety wymaganych rodzin (P, T, area) bierze z tabeli w sekcji `## Triage` treści (czytanej z HTML-a,
 * który renderuje GitHub: `bodyHTML`), a gdy to nie wystarcza, nakłada `needs-triage`. Stan audytu liczy w tym samym
 * przebiegu, już z nowymi etykietami: zapis z `GITHUB_TOKEN` nie uruchamia kolejnego przebiegu workflow, więc
 * „następny przebieg” by nie nadszedł. Werdykt wydany przed uzupełnieniem triage nie obowiązuje.
 *
 * Parametry (daty aktywacji) pochodzą wyłącznie z pliku `.github/repo-standard.json`, bez wartości domyślnych w kodzie
 * i workflow. Pusty napis w pliku to świadome wyłączenie jednej części (audit albo triage); brak pliku, brak pola
 * i zły format to błąd (kod 2, zero zmian).
 *
 * Użycie:
 *   node .github/standard/audit/issue-audit-gate.js --issue <numer> [--repo owner/name] [--params <plik>] [--dry-run]
 */

const fs = require('fs');
const params = require('../common/params');
const { fetchInput, revisionBarrier, run: gh, EDIT_UNKNOWN } = require('./issue-audit-fetch');
const { authorSide, commentSide, leadingLine, reviewerOf, signatureSide } = require('./issue-audit-sides');
const { tokenize, visibleText, isEmptyTag } = require('./issue-audit-html');

const AUDIT_PENDING = 'audit:pending';
const AUDIT_OK = 'audit:ok';
const AUDIT_CHANGES = 'audit:changes';
const NEEDS_TRIAGE = 'needs-triage';
const DISABLED_AUDIT = 'wylaczone parametrem audit.active_since';
const DISABLED_TRIAGE = 'wylaczone parametrem triage.active_since';

/**
 * Rodziny etykiet triage. `row`: początek pierwszej komórki wiersza tabeli „Triage”; `label`: czy etykieta
 * zgłoszenia należy do rodziny; `token`: etykieta w komórce z wartością; `single`: rodzina o kardynalności „dokładnie
 * jedna” (dla `area` wystarczy co najmniej jedna).
 *
 * `label` i `token` są rozdzielone celowo. Nazwę `area:*` z tabeli czytamy w całości, do białego znaku albo
 * separatora: wzorzec zawężony do liter i cyfr skracał `area:github_extra` do `area:github` i nakładał inną etykietę
 * niż podana. Priorytet i ryzyko dopasowujemy dokładnie (`^P[0-4]$`), nigdy przez prefiks: `Portal` ani `Pxyz` nie są
 * etykietami priorytetu.
 */
const TRIAGE_FAMILIES = {
  P: { row: 'priorytet', label: /^P[0-4]$/, token: /\bP[0-4]\b/g, single: true },
  T: { row: 'ryzyko', label: /^T[1-3]$/, token: /\bT[1-3]\b/g, single: true },
  area: { row: 'obszar', label: /^area:./, token: /\barea:[^\s|`*,;]+/g, single: false }
};

/** Błąd konfiguracji albo parametrów: komunikat dla Actions, kod wyjścia 2, bez żadnego zapisu. */
class ConfigError extends Error {}

const DEFAULT_CONFIG = {
  auditLabels: [AUDIT_PENDING, AUDIT_OK, AUDIT_CHANGES],
  // Zakres bramki: priorytet P0-P2 ALBO tier T2/T3. Brak P* i T* znaczy „przed triage” (od tego jest `needs-triage`).
  scopeLabels: ['P0', 'P1', 'P2', 'T2', 'T3'],
  // To NIE jest literalne sprawdzenie uprawnienia `write`; nazywamy to po imieniu, żeby specyfikacja nie obiecywała
  // czegoś, czego implementacja nie robi.
  commandAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
  // Dopasowanie do PIERWSZEJ niepustej, niewciętej linii (`leadingLine`); po nazwie nie może stać litera, cyfra ani
  // łącznik: `\b` przepuszczało `/audit-ok-nie`.
  commandPattern: /^\/audit-(ok|changes)(?![\w-])/,
  // Rodziny wymagane po triage. Daty aktywacji celowo NIE mają wartości domyślnej: dostarcza je plik parametrów.
  triageRequired: ['P', 'T', 'area']
};

/**
 * Konfiguracja z domyślnymi i parametrami wywołania. Daty aktywacji muszą być podane (data w formacie schematu albo
 * pusty napis jako wyłączenie): brak daty to błąd, nigdy cichy backfill całego archiwum.
 */
function resolveConfig(config) {
  const cfg = Object.assign({}, DEFAULT_CONFIG, config);
  for (const key of ['gateActiveSince', 'triageActiveSince']) {
    const value = cfg[key];
    if (value !== '' && !params.validInstant(value)) {
      throw new ConfigError('config.' + key + ': oczekiwano daty RRRR-MM-DDTGG:MM:SSZ albo pustego napisu, bez wartości domyślnej');
    }
  }
  return cfg;
}

/** Czy zestaw etykiet kwalifikuje zgłoszenie do bramki. */
function inScope(labels, cfg) {
  return labels.some(name => cfg.scopeLabels.includes(name));
}

/** Wszystkie obecne etykiety rodziny audit. Kardynalność ma być 0 lub 1, ale ręczna edycja albo awaria potrafi
 *  zostawić dwie: reconciler musi to widzieć. */
function auditLabelsPresent(labels, cfg) {
  return labels.filter(name => cfg.auditLabels.includes(name));
}

/** Etykieta stanu audytu obecna na zgłoszeniu; '' gdy żadnej. */
function currentAuditLabel(labels, cfg) {
  return auditLabelsPresent(labels, cfg)[0] || '';
}

/**
 * Rodzaj komendy w treści komentarza; '' gdy komentarz nie jest komendą. Komenda stoi w pierwszej niepustej linii
 * i nie jest wcięta jak blok kodu: cytowany przykład (`    /audit-ok`, ``` `/audit-ok` ```) nie jest werdyktem.
 */
function parseCommand(body, cfg) {
  const match = cfg.commandPattern.exec(leadingLine(body));
  return match ? match[1] : '';
}

/**
 * Najnowsza WAŻNA komenda: rozpoznana, od osoby uprawnionej, nieedytowana po publikacji, od strony przeciwnej autorowi
 * treści (`reviewer`), nowsza niż bariera rewizji i nowsza niż chwila uzupełnienia triage (`since`). Komenda starsza
 * od bariery dotyczy nieaktualnej treści i nie może niczego rozstrzygać. Bez ustalonego recenzenta (autorstwo
 * nieustalone) nie ma werdyktu.
 *
 * Stronę komentarza wyznacza podpis zgodny z aplikacją, przez którą komentarz powstał; komentarz edytowany
 * (`lastEditedAt`) albo bez danych o edycji (`unknown`) nie jest werdyktem, bo mógł zmienić treść po publikacji.
 */
function latestDecision(comments, barrier, cfg, reviewer, since = '') {
  if (!reviewer) return null;
  return comments?.filter(c => cfg.commandAssociations.includes(c.authorAssociation))
    .filter(c => parseCommand(c.body, cfg))
    .filter(c => !c.lastEditedAt)
    .filter(c => commentSide(c) === reviewer)
    .filter(c => c.createdAt > barrier)
    .filter(c => c.createdAt > since)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .pop() || null;
}

/**
 * Komendy nowsze niż bariera rewizji, które odrzucono WYŁĄCZNIE z powodu `author_association` spoza listy
 * `commandAssociations`. Służy tylko do diagnozy: bez tego odrzucenie wygląda jak „brak werdyktu”.
 *
 * Typowa przyczyna: członkostwo w organizacji jest ukryte, więc `GITHUB_TOKEN` (nie członek) widzi autora jako
 * `CONTRIBUTOR`, mimo że webhook i token członka pokazują `MEMBER`. Listy dozwolonych nie rozszerzamy: `CONTRIBUTOR`
 * to także każdy, kogo PR został scalony, a podpis strony bez aplikacji (Claude Code przez `gh`) da się podrobić.
 */
function rejectedByAssociation(comments, barrier, cfg, reviewer, since = '') {
  if (!reviewer || !comments) return [];
  // Te same warunki co w latestDecision(), poza `author_association`: liczymy tylko komendy, które po zmianie samej
  // wartości association byłyby przyjęte. Inaczej podpowiedź „ustaw członkostwo jako publiczne” prowadziłaby w ślepy
  // zaułek dla komentarza edytowanego, od złej strony albo bez podpisu.
  return comments
    .filter(c => parseCommand(c.body, cfg))
    .filter(c => !c.lastEditedAt)
    .filter(c => commentSide(c) === reviewer)
    .filter(c => c.createdAt > barrier)
    .filter(c => c.createdAt > since)
    .filter(c => !cfg.commandAssociations.includes(c.authorAssociation))
    .map(c => String(c.authorAssociation || 'brak'));
}

/** Kod powodu, dla którego komenda nie jest werdyktem z powodów innych niż `author_association`; '' gdy ich nie ma. */
function skipReason(comment, barrier, reviewer, since) {
  if (comment.lastEditedAt === EDIT_UNKNOWN) return 'brak-danych-o-edycji';
  if (comment.lastEditedAt) return 'edytowany';
  if (commentSide(comment) !== reviewer) {
    if (!signatureSide(comment.body)) return 'brak-podpisu';
    return signatureSide(comment.body) === reviewer ? 'podpis-niezgodny-z-aplikacja' : 'zla-strona';
  }
  if (!(comment.createdAt > barrier)) return 'przed-bariera';
  if (!(comment.createdAt > since)) return 'przed-uzupelnieniem-triage';
  return '';
}

/**
 * Powody pominięcia każdej komendy (poza `author_association`, który ma własną diagnozę) jako zliczenia po kodzie
 * powodu, w kolejności pierwszego wystąpienia. Bez treści komentarzy i bez nazw autorów.
 */
function skippedVerdicts(comments, barrier, cfg, reviewer, since = '') {
  if (!reviewer || !comments) return [];
  const counts = new Map();
  for (const comment of comments) {
    if (!parseCommand(comment.body, cfg)) continue;
    const reason = skipReason(comment, barrier, reviewer, since);
    if (reason) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts].map(([reason, count]) => reason + ' x' + count);
}

/**
 * Kiedy zbiór etykiet OSTATNI raz zaczął spełniać `satisfied` (`out → in`); '' gdy nigdy. Oś czasu etykiet jest
 * źródłem autorytatywnym: nie wolno czytać tego z payloadu zdarzenia, bo przebieg anulowany przez kolejne zdarzenie
 * gubi przejście bezpowrotnie. Odtwarzamy stan wstecz od bieżącego zestawu: idąc od najnowszego zdarzenia cofamy jego
 * skutek i pytamy, czy w tym momencie warunek zmienił się z „nie” na „tak”.
 */
function lastEntryAt(currentLabels, labelEvents, satisfied) {
  const events = [labelEvents].flat()
    .filter(e => e && e.label && e.createdAt)
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));

  let labels = currentLabels;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    const after = satisfied(labels);
    labels = event.type === 'LABELED'
      ? labels.filter(name => name !== event.label)
      : labels.concat([event.label]);
    if (after && !satisfied(labels)) return event.createdAt;
  }
  return '';
}

/** Kiedy zgłoszenie OSTATNI raz weszło w zakres bramki. */
function lastScopeEntryAt(currentLabels, labelEvents, cfg) {
  return lastEntryAt(currentLabels, labelEvents, labels => inScope(labels, cfg));
}

/** Etykiety zgłoszenia należące do rodziny triage. */
function familyLabels(labels, family) {
  return labels.filter(name => TRIAGE_FAMILIES[family].label.test(String(name)));
}

/** Czy rodzina ma komplet: dokładnie jedna etykieta, a dla `area` co najmniej jedna. */
function familySatisfied(labels, family) {
  const count = familyLabels(labels, family).length;
  return TRIAGE_FAMILIES[family].single ? count === 1 : count >= 1;
}

/** Rodziny wymagane, których zgłoszenie nie ma w komplecie. */
function missingFamilies(labels, cfg) {
  return cfg.triageRequired.filter(family => !familySatisfied(labels, family));
}

/**
 * Stan triage z punktu widzenia werdyktów audytu: `{ open, since, reason }`. Zgłoszenie objęte triage (utworzone od
 * `triageActiveSince`) bez kompletu etykiet nie ma ważnych werdyktów (`open: false`); po uzupełnieniu obowiązują
 * wyłącznie werdykty nowsze od chwili uzupełnienia (`since`). Zgłoszenie spoza triage albo przy wyłączonym triage
 * nie ma tego warunku.
 */
function triageGate(input, cfg) {
  const created = Date.parse(input.createdAt);
  if (!cfg.triageActiveSince || isNaN(created) || created < Date.parse(cfg.triageActiveSince)) {
    return { open: true, since: '', reason: '' };
  }
  const missing = missingFamilies(input.labels, cfg);
  if (missing.length) return { open: false, since: '', reason: 'triage niekompletne: ' + missing.join(', ') + '; werdykt sprzed uzupełnienia nie obowiązuje' };
  const since = lastEntryAt(input.labels, input.labelEvents, labels => missingFamilies(labels, cfg).length === 0);
  return { open: true, since, reason: '' };
}

/**
 * Czy zgłoszenie jest OBJĘTE bramką. Alternatywa czterech warunków: wystarczy jeden. Gdy nie zachodzi żaden,
 * zgłoszenie w zakresie zostaje poza bramką i przebieg nie zapisuje nic; nie nadaje `audit:pending`.
 */
function isEngaged(input, barrier, decision, cfg) {
  if (currentAuditLabel(input.labels, cfg)) return true;
  if (barrier >= cfg.gateActiveSince) return true;
  const entry = lastScopeEntryAt(input.labels, input.labelEvents, cfg);
  if (entry && entry >= cfg.gateActiveSince) return true;
  // Dobrowolne wejście przez komendę. Warunek liczymy ze stanu (istnieje ważna komenda po barierze), a nie z rodzaju
  // bieżącego zdarzenia: zachowanie jest takie samo także wtedy, gdy przebieg od komentarza przepadł.
  return Boolean(decision);
}

/** Podpowiedź o odrzuceniu komend z powodu `author_association` (puste, gdy nic nie odrzucono). */
function associationHint(rejected, cfg) {
  if (!rejected.length) return '';
  return '; pominięto ' + rejected.length + ' komend(ę/y) z powodu author_association: ' + [...new Set(rejected)].join(', ')
    + ' (dozwolone: ' + cfg.commandAssociations.join(', ') + '). Ukryte członkostwo w organizacji pokazuje GITHUB_TOKEN'
    + ' jako CONTRIBUTOR: ustaw członkostwo jako publiczne';
}

/**
 * Stan docelowy z werdyktu (albo jego braku), autorstwa treści i stanu triage. Przy nieustalonym autorze nikt nie jest
 * recenzentem, więc zostaje `audit:pending`; przy niekompletnym triage także.
 */
function wantedState(parts, author, barrier, cfg) {
  const { decision, rejected, skipped, triage } = parts;
  if (!author.side) return { label: AUDIT_PENDING, reason: 'autorstwo nieustalone: ' + author.reason };
  const skippedNote = skipped.length ? '; pominięte werdykty: ' + skipped.join(', ') : '';
  if (!triage.open) return { label: AUDIT_PENDING, reason: triage.reason + skippedNote };
  if (!decision) {
    return { label: AUDIT_PENDING, reason: 'brak ważnego rozstrzygnięcia dla rewizji ' + barrier + associationHint(rejected, cfg) + skippedNote };
  }
  return {
    label: 'audit:' + parseCommand(decision.body, cfg),
    reason: 'rozstrzygnięcie z ' + decision.createdAt + ' nowsze niż rewizja ' + barrier + skippedNote
  };
}

/**
 * Wynik przebiegu dla stanu docelowego. Zgodność samej pierwszej etykiety nie wystarcza: przy duplikacie rodziny
 * (np. `audit:ok` obok `audit:pending`) trzeba wymusić zapis, żeby `apply` usunęło nadmiarową. Inaczej kardynalność
 * „0 lub 1” zostałaby złamana na stałe, bo kolejne przebiegi widziałyby stan jako zgodny.
 */
function settle(target, present, current) {
  if (target.label === current && present.length === 1) {
    return { action: 'none', label: current, reason: target.reason + ' (bez zmiany)' };
  }
  if (present.length > 1) {
    return { action: 'set', label: target.label, reason: target.reason + ' (usuwam duplikat rodziny audit:*)' };
  }
  return { action: 'set', label: target.label, reason: target.reason };
}

/**
 * @param {object} input
 * @param {string}   input.state       'open' | 'closed'
 * @param {string[]} input.labels      aktualne etykiety zgłoszenia
 * @param {string}   input.barrier     ISO: ostatnia edycja treści albo createdAt
 * @param {string}   input.body        treść zgłoszenia (Markdown); jej podpis wskazuje autora
 * @param {string}   input.app         aplikacja, przez którą utworzono zgłoszenie ('' = gh)
 * @param {string}   [input.createdAt] ISO: utworzenie zgłoszenia (warunek triage przy werdykcie)
 * @param {Array}    input.comments    [{ body, authorAssociation, createdAt, app, lastEditedAt }]
 * @param {Array}    [input.labelEvents] [{ type: 'LABELED'|'UNLABELED', label, createdAt }]
 * @param {object}   config            wymaga `gateActiveSince` i `triageActiveSince`
 * @returns {{ action: 'none'|'set'|'clear', label: string, reason: string }}
 */
function reconcile(input, config = {}) {
  const cfg = resolveConfig(config);
  const present = auditLabelsPresent(input.labels, cfg);
  const current = present[0] || '';

  if (!cfg.gateActiveSince) return { action: 'none', label: current, reason: DISABLED_AUDIT };

  // Zamknięcie kończy temat. Świadome odstępstwo od czystego reconcilera: czyszczenie etykiet po fakcie zaśmiecałoby
  // archiwum.
  if (input.state === 'closed') return { action: 'none', label: current, reason: 'issue zamknięta' };

  const barrier = String(input.barrier || '');
  if (!barrier) return { action: 'none', label: current, reason: 'brak bariery rewizji (fail-closed)' };

  if (!inScope(input.labels, cfg)) {
    return present.length
      ? { action: 'clear', label: '', reason: 'issue poza zakresem bramki' }
      : { action: 'none', label: '', reason: 'issue poza zakresem bramki' };
  }

  const author = authorSide(input.body, input.labels, input.app);
  const reviewer = reviewerOf(author.side);
  const triage = triageGate(input, cfg);
  const decision = triage.open ? latestDecision(input.comments, barrier, cfg, reviewer, triage.since) : null;
  if (!isEngaged(input, barrier, decision, cfg)) {
    return { action: 'none', label: current, reason: 'issue nieobjęta bramką (brak backfillu)' };
  }

  const parts = {
    decision,
    rejected: rejectedByAssociation(input.comments, barrier, cfg, reviewer, triage.since),
    skipped: skippedVerdicts(input.comments, barrier, cfg, reviewer, triage.since),
    triage
  };
  return settle(wantedState(parts, author, barrier, cfg), present, current);
}

/** Struktura HTML-a: elementy z najwyższego poziomu fragmentu, `{ elements, error }`. */
function scanElements(html, transparent) {
  const scanned = tokenize(html);
  if (scanned.error) return { elements: [], error: scanned.error };
  const elements = [];
  const stack = [];
  const nested = () => stack.some(open => !open.transparent);
  for (const token of scanned.tokens) {
    if (token.type === 'open') {
      if (!isEmptyTag(token, false)) {
        stack.push({ name: token.name, transparent: transparent?.(token.name, token.classAttr), contentStart: token.end });
      } else if (!nested()) {
        elements.push({ name: token.name, inner: '' });
      }
      continue;
    }
    // Token tekstowy nie ma nazwy, więc nie pasuje do żadnego elementu na stosie i nie zmienia stanu.
    const at = stack.map(open => open.name).lastIndexOf(token.name);
    if (at < 0) continue;
    const open = stack[at];
    stack.length = at;
    if (!nested() && !open.transparent) elements.push({ name: token.name, inner: html.slice(open.contentStart, token.start) });
  }
  return { elements, error: '' };
}

/**
 * Elementy z najwyższego poziomu fragmentu HTML-a, po kolei, jako `{ name, inner }`. Elementy, dla których
 * `transparent(name, klasa)` jest prawdą, nie liczą się jako poziom: ich dzieci są traktowane, jakby stały
 * bezpośrednio we fragmencie. Element, który się nie zamyka, zostawia wszystko po sobie zagnieżdżone, więc z uszkodzonego
 * HTML-a nie powstaje żaden element najwyższego poziomu.
 */
function topLevelElements(html, transparent) {
  return scanElements(html, transparent).elements;
}

/**
 * Czy element jest opakowaniem, które GitHub sam dokłada wokół nagłówka albo tabeli: jego zawartość stoi wtedy nadal
 * na poziomie dokumentu. `div` liczy się tylko z klasą `markdown-heading`; klasy autor podrobić nie może, bo GitHub
 * usuwa atrybut `class` z HTML-a w treści. Nazwa opakowania tabeli ma w HTML-u GitHuba literówkę: przyjmujemy też
 * poprawną pisownię, gdyby ją naprawiono.
 */
function isGithubWrapper(name, classAttr) {
  if (name === 'markdown-accessiblity-table' || name === 'markdown-accessibility-table') return true;
  return name === 'div' && /(?:^|\s)markdown-heading(?:\s|$)/.test(classAttr);
}

const TABLE_SECTIONS = ['thead', 'tbody', 'tfoot'];

/** Komórki wiersza: tylko dwie pierwsze (etykieta i wartość) są czytane, w trybie ścisłym; reszta to uzasadnienie. */
function readRow(row) {
  // Wycinek rozebranego dokumentu między granicami znaczników rozbiera się zawsze, więc błędu rozbioru tu nie ma.
  const scanned = scanElements(row.inner);
  const cells = [];
  for (const [index, cell] of scanned.elements.filter(el => el.name === 'td' || el.name === 'th').entries()) {
    if (index > 1) {
      cells.push('');
      continue;
    }
    const read = visibleText(cell.inner, true);
    if (read.error) return { error: read.error };
    cells.push(read.text);
  }
  return { cells };
}

/** Wiersze jednej tabeli: `{ rows }` albo `{ error }` (kod powodu nieczytelnej komórki). */
function readTable(table) {
  const scanned = scanElements(table.inner, name => TABLE_SECTIONS.includes(name));
  const rows = [];
  for (const row of scanned.elements.filter(el => el.name === 'tr')) {
    const read = readRow(row);
    if (read.error) return { error: read.error };
    if (read.cells.length) rows.push(read.cells);
  }
  return { rows };
}

/** Indeks nagłówka „Triage” wśród bloków najwyższego poziomu (-1, gdy go nie ma) albo `{ error }`, gdy nagłówek jest nieczytelny. */
function findTriageHeading(blocks) {
  for (const [index, block] of blocks.entries()) {
    if (block.name !== 'h2') continue;
    const heading = visibleText(block.inner, false);
    if (heading.error) return { error: heading.error };
    if (heading.text.toLowerCase() === 'triage') return { index };
  }
  return { index: -1 };
}

/**
 * Wiersze tabel z sekcji „Triage” treści zgłoszenia, każdy jako lista komórek z samym tekstem, i powód nieczytelności:
 * `{ rows, unreadable }`. Bez sekcji albo bez tabeli: brak wierszy.
 *
 * Wejściem jest HTML wyrenderowany przez GitHuba (`bodyHTML`), nie Markdown. Kontrakt mówi o TABELI, a o tym, co jest
 * tabelą, decyduje renderer: wersja czytająca Markdown musiałaby powtórzyć CommonMark i GFM i zawsze zostawiałaby
 * sposób, w jaki treść niebędąca widoczną tabelą daje etykiety (blok kodu, komentarz HTML, `\|` w komórce). W HTML-u
 * z GitHuba tekst i wartości atrybutów są zakodowane encjami, więc znacznik w treści nie udaje struktury.
 *
 * Liczy się wyłącznie poziom dokumentu. Sekcja zaczyna się od pierwszego nagłówka drugiego poziomu o treści „Triage”
 * i kończy na następnym nagłówku albo linii poziomej; czytane są tabele stojące bezpośrednio w sekcji. Nagłówek
 * i tabela w cytacie, na liście, w `<details>` albo w `<div>` autora to przykład albo cudza wypowiedź.
 *
 * Fail-closed: HTML, którego czytnik nie rozumie (niezbalansowane znaczniki, tag spoza listy w komórce, atrybut
 * ukrywający, przekroczony limit), daje `unreadable` z kodem powodu i ZERO wierszy: żadna etykieta z takiej tabeli.
 */
function readTriage(bodyHtml) {
  const scanned = scanElements(bodyHtml, isGithubWrapper);
  if (scanned.error) return { rows: [], unreadable: scanned.error };
  const blocks = scanned.elements;
  const heading = findTriageHeading(blocks);
  if (heading.error) return { rows: [], unreadable: heading.error };
  if (heading.index < 0) return { rows: [], unreadable: '' };

  const rows = [];
  for (const block of blocks.slice(heading.index + 1)) {
    if (/^h[1-6]$/.test(block.name) || block.name === 'hr') break;
    if (block.name !== 'table') continue;
    const table = readTable(block);
    if (table.error) return { rows: [], unreadable: table.error };
    rows.push(...table.rows);
  }
  return { rows, unreadable: '' };
}

/** Same wiersze tabeli „Triage” (puste dla HTML-a nieczytelnego). */
function triageTableRows(bodyHtml) {
  return readTriage(bodyHtml).rows;
}

/**
 * Etykieta rodziny zapisana w tabeli „Triage”; '' gdy tabela jej nie rozstrzyga. Wartość czytamy z DRUGIEJ komórki
 * wiersza (kolumna „wartość”), nie z całego wiersza: uzasadnienie w trzeciej potrafi wymieniać inne priorytety.
 * Komórka musi zawierać dokładnie jeden token rodziny: przy zerze albo kilku tabela jest niejednoznaczna i nie
 * zgadujemy.
 */
function triageLabelFromTable(rows, family) {
  const def = TRIAGE_FAMILIES[family];
  const tokens = [];
  rows.forEach(cells => {
    if (cells.length < 2 || cells[0].toLowerCase().indexOf(def.row) !== 0) return;
    (cells[1].match(def.token) || []).forEach(token => {
      if (!tokens.includes(token)) tokens.push(token);
    });
  });
  return tokens.length === 1 ? tokens[0] : '';
}

/** Uzupełnienie brakujących wymaganych rodzin z tabeli: `{ add, labels, missingLabels }`. */
function fillFromTable(labels, rows, cfg, known) {
  const add = [];
  const missingLabels = [];
  const current = labels.slice();
  for (const family of cfg.triageRequired) {
    if (familyLabels(current, family).length) continue;
    const label = triageLabelFromTable(rows, family);
    if (!label) continue;
    if (!known.includes(label)) {
      missingLabels.push(label);
      continue;
    }
    add.push(label);
    current.push(label);
  }
  return { add, labels: current, missingLabels };
}

/**
 * Triage zgłoszenia: etykiety do nałożenia i zdjęcia, bez dotykania audytu.
 *
 * Zasady, których nie wolno „uprościć”:
 *   1. istniejących etykiet nie nadpisujemy i nie usuwamy: po triage źródłem prawdy są etykiety, tabela jest tylko
 *      propozycją autora;
 *   2. z tabeli uzupełniamy wyłącznie rodzinę WYMAGANĄ, której zgłoszenie nie ma wcale; rodzina z dwiema etykietami
 *      zostaje do poprawienia człowiekowi;
 *   3. etykiety z tabeli, których nie ma w repozytorium, nie są nakładane ani tworzone: trafiają do `missingLabels`,
 *      a wołający kończy przebieg STOP-em (kontrola etykiet), nie cichym pominięciem;
 *   4. bez komentarzy: anulowany przebieg mógłby komentarz zdublować albo zgubić, a etykietę kolejny przebieg koryguje.
 *
 * @param {object} input
 * @param {string}   input.state        'open' | 'closed'
 * @param {string[]} input.labels       aktualne etykiety zgłoszenia
 * @param {string}   input.createdAt    ISO: utworzenie zgłoszenia
 * @param {string}   input.bodyHtml     treść zgłoszenia wyrenderowana przez GitHuba (`bodyHTML`)
 * @param {string[]} input.repoLabels   etykiety istniejące w repozytorium
 * @param {object}   config             wymaga `gateActiveSince` i `triageActiveSince`
 * @returns {{ add: string[], remove: string[], missingLabels: string[], unreadable: string, reason: string }}
 */
function reconcileTriage(input, config = {}) {
  const cfg = resolveConfig(config);
  const none = reason => ({ add: [], remove: [], missingLabels: [], unreadable: '', reason });

  if (!cfg.triageActiveSince) return none(DISABLED_TRIAGE);
  if (input.state !== 'open') return none('issue zamknięta');
  const created = Date.parse(input.createdAt);
  if (isNaN(created)) return none('brak daty utworzenia issue (fail-closed)');
  if (created < Date.parse(cfg.triageActiveSince)) return none('issue sprzed startu triage\'u');

  const table = readTriage(input.bodyHtml);
  const filled = fillFromTable(input.labels, table.rows, cfg, [input.repoLabels].flat());
  const add = filled.add.slice();
  const missing = missingFamilies(filled.labels, cfg);
  const flagged = filled.labels.includes(NEEDS_TRIAGE);
  const remove = [];
  if (missing.length && !flagged) add.push(NEEDS_TRIAGE);
  if (!missing.length && flagged) remove.push(NEEDS_TRIAGE);

  const notes = [missing.length ? 'brak triage\'u: ' + missing.join(', ') : 'triage kompletny'];
  if (filled.add.length) notes.push('z tabeli: ' + filled.add.join(', '));
  if (table.unreadable) notes.push('triage nieczytelne: ' + table.unreadable);
  const reason = notes.join('; ');
  return { add, remove, missingLabels: filled.missingLabels, unreadable: table.unreadable, reason };
}

/**
 * Pełny przebieg: najpierw triage, potem stan audytu wyliczony z etykiet PO triage. Etykiety nałożone w tym przebiegu
 * nie mają jeszcze wpisu na osi czasu, więc dopisujemy go z chwilą `now`: inaczej `lastScopeEntryAt()` nie zobaczyłby
 * wejścia w zakres, które właśnie następuje, a werdykt sprzed uzupełnienia triage wyglądałby na ważny.
 *
 * @returns {{ triage: object, audit: object, labels: string[] }}
 */
function reconcileIssue(input, config = {}, now = new Date().toISOString()) {
  const triage = reconcileTriage(input, config);
  const stamp = String(now).slice(0, 19) + 'Z';
  const labels = input.labels.filter(name => !triage.remove.includes(name)).concat(triage.add);
  // Zdjęcie `needs-triage` nie jest wpisem osi czasu: ta etykieta nie wpływa ani na zakres bramki, ani na komplet rodzin.
  const labelEvents = [input.labelEvents, triage.add.map(label => ({ type: 'LABELED', label, createdAt: stamp }))].flat();
  const audit = reconcile(Object.assign({}, input, { labels, labelEvents }), config);
  return { triage, audit, labels };
}

/**
 * Etykiety do dodania i zdjęcia dla całego przebiegu: triage i stan audytu razem, żeby poszły jednym zapisem.
 * `current` to etykiety zgłoszenia sprzed przebiegu: zdejmujemy tylko faktycznie obecne, bo `gh issue edit
 * --remove-label` na nieistniejącej etykiecie kończy się błędem.
 */
function labelChanges(outcome, current, cfg) {
  const add = outcome.triage.add.slice();
  const remove = outcome.triage.remove.slice();
  if (outcome.audit.action !== 'none') {
    if (outcome.audit.label) add.push(outcome.audit.label);
    cfg.auditLabels
      .filter(name => name !== outcome.audit.label)
      .filter(name => current.includes(name))
      .forEach(name => remove.push(name));
  }
  return { add, remove };
}

/**
 * Kontrola etykiet przed pierwszym zapisem: nazwy, których przebieg wymaga, a repozytorium ich nie ma. Wymagane są
 * etykiety stanu audytu (gdy audyt aktywny), `needs-triage` (gdy triage aktywny) i etykiety z tabeli „Triage”.
 * Bramka etykiet nie tworzy; brak którejkolwiek to STOP, nigdy ciche pominięcie.
 */
function preflight(repoLabels, cfg, triage) {
  const known = new Set(repoLabels);
  const required = [];
  if (cfg.gateActiveSince) required.push(...cfg.auditLabels);
  if (cfg.triageActiveSince) required.push(NEEDS_TRIAGE);
  required.push(...(triage.missingLabels || []));
  return [...new Set(required.filter(name => !known.has(name)))].sort();
}

/** Zapis etykiet jednym wywołaniem `gh`; nic do zrobienia to brak wywołania. */
function apply(repo, issue, changes) {
  if (!changes.add.length && !changes.remove.length) return;
  const args = ['issue', 'edit', String(issue), '--repo', repo];
  changes.add.forEach(name => args.push('--add-label', name));
  changes.remove.forEach(name => args.push('--remove-label', name));
  gh(args);
}

/** Wczytuje plik parametrów; brak pliku albo błąd walidacji B1 to `ConfigError` z nazwą pola. */
function loadConfig(file, readFile) {
  let text;
  try {
    text = readFile(file);
  } catch (error) {
    throw new ConfigError('brak pliku parametrów ' + file + ' (' + (error.code || 'błąd odczytu') + ')');
  }
  try {
    const loaded = params.load(text);
    return { gateActiveSince: loaded.audit.active_since, triageActiveSince: loaded.triage.active_since };
  } catch (error) {
    if (error instanceof params.ParamsError) throw new ConfigError('plik parametrów ' + file + ': ' + error.message);
    throw error;
  }
}

/** Argumenty wiersza poleceń: tylko znane flagi, wartość flagi jest wymagana. */
function parseArgs(argv) {
  const args = { params: params.PARAMS_PATH };
  const valueFlags = { '--issue': 'issue', '--repo': 'repo', '--params': 'params' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--dry-run') {
      args.dryRun = true;
    } else if (valueFlags[argv[i]]) {
      const value = argv[i + 1];
      if (value === undefined || value === '') throw new ConfigError(argv[i] + ' podano bez wartości');
      args[valueFlags[argv[i]]] = value;
      i += 1;
    } else {
      throw new ConfigError('nieznany argument: ' + argv[i]);
    }
  }
  return args;
}

function summaryLines(issue, outcome) {
  const result = outcome.audit;
  const triageDelta = outcome.triage.add.map(name => '+' + name)
    .concat(outcome.triage.remove.map(name => '-' + name)).join(' ') || 'bez zmian';
  return [
    '#' + issue + ' triage: ' + triageDelta + ' - ' + outcome.triage.reason,
    '#' + issue + ': ' + result.action + (result.label ? ' -> ' + result.label : '') + ' - ' + result.reason
  ];
}

/**
 * Przebieg bramki; zwraca kod wyjścia (0 albo 2). Zależności są wstrzykiwane, żeby testy nie dotykały sieci ani
 * dysku: `fetch(repo, issue)`, `apply(repo, issue, changes)`, `readFile(plik)`, `env`, `log(linia)`, `error(linia)`.
 */
function run(argv, deps) {
  const io = Object.assign({
    fetch: fetchInput, apply, readFile: file => fs.readFileSync(file, 'utf8'), env: process.env,
    log: line => console.log(line), error: line => console.error(line)
  }, deps);
  try {
    const args = parseArgs(argv);
    const repo = args.repo || io.env.GITHUB_REPOSITORY;
    if (!args.issue || !repo) throw new ConfigError('użycie: issue-audit-gate.js --issue <numer> [--repo owner/name] [--params <plik>] [--dry-run]');
    const config = loadConfig(args.params, io.readFile);
    const cfg = resolveConfig(config);
    if (!cfg.gateActiveSince && !cfg.triageActiveSince) {
      io.log('::notice::' + DISABLED_AUDIT + ' i ' + DISABLED_TRIAGE + ': brak zmian');
      io.log(DISABLED_AUDIT);
      io.log(DISABLED_TRIAGE);
      return 0;
    }
    return reconcileAndWrite(args, repo, cfg, io);
  } catch (error) {
    if (!(error instanceof ConfigError)) io.error('::error::błąd przebiegu: ' + (error && error.message));
    else io.error('::error::' + error.message);
    return 2;
  }
}

function reconcileAndWrite(args, repo, cfg, io) {
  const input = io.fetch(repo, args.issue);
  const outcome = reconcileIssue(input, cfg, io.now?.());
  const missing = preflight(input.repoLabels, cfg, outcome.triage);
  if (missing.length) {
    io.error('::error::STOP, w repozytorium brakuje etykiet: ' + missing.join(', ') + '. Bramka etykiet nie tworzy; zero zmian.');
    return 2;
  }
  const summary = summaryLines(args.issue, outcome);
  summary.forEach(line => io.log(line));
  if (io.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(io.env.GITHUB_STEP_SUMMARY, summary.join('\n') + '\n');
  // Workflow publikuje komentarz-znacznik wyłącznie na przejściu „rozstrzygnięte → pending”; sam znacznik nie jest
  // źródłem prawdy.
  if (io.env.GITHUB_OUTPUT) {
    const previous = currentAuditLabel(input.labels, DEFAULT_CONFIG);
    const lines = ['action=' + outcome.audit.action, 'label=' + outcome.audit.label, 'previous=' + previous, ''];
    fs.appendFileSync(io.env.GITHUB_OUTPUT, lines.join('\n'));
  }
  if (!args.dryRun) io.apply(repo, args.issue, labelChanges(outcome, input.labels, DEFAULT_CONFIG));
  return 0;
}

if (require.main === module) process.exitCode = run(process.argv.slice(2));

module.exports = {
  reconcile,
  reconcileTriage,
  reconcileIssue,
  labelChanges,
  preflight,
  run,
  loadConfig,
  parseArgs,
  resolveConfig,
  ConfigError,
  readTriage,
  triageTableRows,
  triageLabelFromTable,
  topLevelElements,
  skippedVerdicts,
  rejectedByAssociation,
  triageGate,
  TRIAGE_FAMILIES,
  NEEDS_TRIAGE,
  inScope,
  parseCommand,
  latestDecision,
  revisionBarrier,
  lastScopeEntryAt,
  auditLabelsPresent,
  currentAuditLabel,
  DEFAULT_CONFIG,
  DISABLED_AUDIT,
  DISABLED_TRIAGE,
  AUDIT_PENDING,
  AUDIT_OK,
  AUDIT_CHANGES
};
