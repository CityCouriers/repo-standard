#!/usr/bin/env node
'use strict';
// Kontrakt szablonów zgłoszeń (`.github/ISSUE_TEMPLATE/*.md` i `config.yml`) w repozytorium wzorca i konsumenta.
//
// Sprawdza wyłącznie to, co czytają bramki i ludzie: frontmatter, pola ról, tabelę „Triage” (nagłówki i wiersze),
// ostatnią linię (instrukcja podpisu, nie ważny podpis), brak bajtów CR i półpauz, `blank_issues_enabled: false`.
// Czytnik tabeli „Triage” z bramki audytu NIE jest tu kopiowany: test na renderze importuje go z plików bramki.
//
// Użycie: node .github/standard/templates/template_contract.js check [--root .]
// Kody wyjścia: 0 zgodne, 1 naruszenia kontraktu, 2 błąd działania (brak katalogu szablonów, nieczytelny plik).

const fs = require('node:fs');
const path = require('node:path');

const TEMPLATE_DIR = '.github/ISSUE_TEMPLATE';
const REQUIRED_LABEL = 'needs-triage';
const REQUIRED_FIELDS = ['**Refs:**', '**Rola autora:**', '**Rola recenzenta'];
const TRIAGE_ROWS = ['priorytet', 'ryzyko', 'obszar'];
const SIGNATURE_NAMES = ['_— Claude Code (agent lokalny)_', '_— ChatGPT_'];
const FORBIDDEN_DASHES = new Set(['–', '—', '―', '−', '‒']);

/** Pola frontmattera (`name`, `about`, `labels`) jako obiekt; null, gdy brak ogranicznika `---`. */
function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) return null;
  const result = {};
  for (const line of match[1].split('\n')) {
    const found = /^([a-z]+):(.*)/.exec(line);
    if (found) result[found[1]] = found[2].trim();
  }
  return result;
}

/** Treść po frontmatterze; cała treść, gdy frontmatteru nie ma. */
function bodyOf(text) {
  const match = /^---\n[\s\S]*?\n---\n/.exec(text);
  return match ? text.slice(match[0].length) : text;
}

/** Fragmenty tekstu poza nazwami podpisów (jedyne miejsce, gdzie wolno użyć długiej półpauzy). */
function outsideSignatures(text) {
  return SIGNATURE_NAMES.reduce((pieces, name) => pieces.flatMap((piece) => piece.split(name)), [text]);
}

/** Wiersze tabeli markdown w sekcji `## Triage`: lista list komórek; [] bez sekcji albo tabeli. */
function triageRows(body) {
  const lines = body.split('\n');
  const start = lines.findIndex((line) => line.trimEnd() === '## Triage');
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break;
    if (!line.startsWith('|')) continue;
    const inner = line.trim().slice(1);
    rows.push((inner.endsWith('|') ? inner.slice(0, -1) : inner).split('|').map((cell) => cell.trim()));
  }
  return rows;
}

/** Naruszenia kontraktu jednego szablonu; pusta lista oznacza zgodność. */
function templateFindings(name, text) {
  const findings = [];
  const add = (message) => findings.push(`${name}: ${message}`);
  if (text.includes('\r')) add('bajt CR (wymagane końce linii LF)');
  const dashes = [...new Set(outsideSignatures(text).flatMap((piece) => [...piece]).filter((ch) => FORBIDDEN_DASHES.has(ch)))].map((ch) => `U+${ch.codePointAt(0).toString(16)}`);
  if (dashes.length) add(`półpauza albo pauza poza podpisem: ${dashes.join(', ')}`);

  const front = parseFrontmatter(text);
  if (front === null) {
    add('brak frontmattera');
  } else {
    for (const key of ['name', 'about']) if (!front[key]) add(`frontmatter bez pola ${key}`);
    if (front.labels !== REQUIRED_LABEL) add(`frontmatter: labels musi być dokładnie ${REQUIRED_LABEL}`);
  }

  const body = bodyOf(text);
  for (const field of REQUIRED_FIELDS) if (!body.includes(field)) add(`brak pola ${field}`);

  const rows = triageRows(body);
  if (rows.length === 0) {
    add('brak sekcji „Triage” z tabelą');
  } else {
    const header = rows[0];
    if (header.length !== 2 || header[0] !== 'pole' || header[1] !== 'wartość') add('nagłówki tabeli „Triage” muszą mieć postać pole | wartość');
    for (const row of TRIAGE_ROWS) {
      const count = rows.slice(1).filter((cells) => cells.length === 2 && cells[0] === row).length;
      if (count !== 1) add(`tabela „Triage” musi mieć dokładnie jeden wiersz „${row}” (jest ${count})`);
    }
  }

  const last = body.split('\n').filter((line) => line.trim() !== '').at(-1);
  if (last === undefined || !last.startsWith('Podpis:')) add('ostatnia linia musi być instrukcją podpisu (zaczyna się od „Podpis:”)');
  if (last !== undefined && SIGNATURE_NAMES.some((signature) => last.trim() === signature || last.trim() === signature.slice(1, -1))) add('ostatnia linia jest ważnym podpisem, a szablon musi być niepodpisany');
  return findings;
}

/** Naruszenia kontraktu `config.yml`. */
function configFindings(text) {
  const findings = [];
  if (text.includes('\r')) findings.push('config.yml: bajt CR (wymagane końce linii LF)');
  const key = 'blank_issues_enabled:';
  const values = text.split('\n').filter((line) => line.startsWith(key)).map((line) => line.slice(key.length).trim());
  if (values.length !== 1 || values[0] !== 'false') findings.push('config.yml: wymagane dokładnie jedno blank_issues_enabled: false');
  return findings;
}

/** Sprawdza katalog szablonów repozytorium; zwraca { findings } albo rzuca Error przy błędzie działania. */
function checkRoot(root) {
  const dir = path.join(root, ...TEMPLATE_DIR.split('/'));
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`${TEMPLATE_DIR}: nie można odczytać katalogu (${error.code})`);
  }
  const findings = [];
  const templates = items.filter((item) => item.isFile() && item.name.endsWith('.md') && item.name !== 'README.md').map((item) => item.name).sort();
  if (templates.length === 0) findings.push(`${TEMPLATE_DIR}: brak szablonów .md`);
  for (const name of templates) findings.push(...templateFindings(name, fs.readFileSync(path.join(dir, name), 'utf8')));
  const configPath = path.join(dir, 'config.yml');
  if (!fs.existsSync(configPath)) findings.push('config.yml: brak pliku');
  else findings.push(...configFindings(fs.readFileSync(configPath, 'utf8')));
  return { findings };
}

function main(argv) {
  const [command, ...rest] = argv;
  const valid = command === 'check' && (rest.length === 0 || (rest.length === 2 && rest[0] === '--root' && rest[1] !== ''));
  if (!valid) {
    console.error('użycie: template_contract.js check [--root <katalog>]');
    return 2;
  }
  const root = rest.length === 2 ? rest[1] : process.cwd();
  try {
    const { findings } = checkRoot(path.resolve(root));
    for (const finding of findings) console.error(finding);
    if (findings.length) return 1;
    console.log('szablony zgłoszeń zgodne z kontraktem');
    return 0;
  } catch (error) {
    console.error(`template_contract: ${error.message}`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { parseFrontmatter, bodyOf, triageRows, templateFindings, configFindings, checkRoot, main, SIGNATURE_NAMES, TRIAGE_ROWS, REQUIRED_FIELDS };
