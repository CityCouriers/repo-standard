#!/usr/bin/env node
'use strict';

/**
 * Manifest etykiet GitHub: walidacja, plan i synchronizacja.
 *
 * Etykiety tworzą dwa pliki. RDZEŃ (`labels-core.json`, obok skryptu) jest wzorcem kopiowanym bez zmian: priorytety,
 * ryzyka, stany i etykiety audytu, na których opiera się bramka audytu. Plik LOKALNY (`.github/labels.json`)
 * należy do repozytorium: `repo`, obszary `area:*`, własne rodziny, klasyfikacja etykiet cudzych (`system`,
 * `foreign`) i `migrations`. Plik lokalny nie jest wpisem manifestu wzorca: kopiowanie wydania go nie dotyka, a jego
 * kontrakt waliduje ten skrypt.
 *
 * Zasady bezpieczeństwa:
 *   - nic nie jest usuwane poza wymienionym w `migrations.delete`; etykieta spoza obu plików, `system` i `foreign`
 *     łamie zgodność, ale nie jest ruszana;
 *   - etykiety rdzenia są nieusuwalne i nieprzemianowywalne: wpis migracji z ich nazwą to błąd walidacji;
 *   - usunięcie etykiety lokalnej wymaga zera użyć w zgłoszeniach i PR (odczyt przed planem i tuż przed usunięciem);
 *     skrypt nie ma ścieżki wymuszenia;
 *   - API GitHuba nie jest transakcyjne: zapis jest dwufazowy (plan i kontrole bez zapisu, potem operacje w kolejności
 *     zmiana nazwy, utworzenie, poprawka, usunięcie), pierwszy błąd przerywa zapis, a ponowny bieg planuje od nowa.
 *
 * Kody wyjścia: 0 zgodne, 1 rozjazd albo odmowa (konflikt, etykieta w użyciu), 2 błąd działania (zły manifest, sieć,
 * brak uprawnień). Błąd walidacji i błąd preflight nie zostawiają żadnego zapisu.
 *
 * Użycie:
 *   node labels_sync.js check
 *   node labels_sync.js diff [--live plik.json] [--strict]
 *   node labels_sync.js sync [--dry-run]
 * Wspólne: [--core plik] [--local plik] [--repo wlasciciel/nazwa] (repozytorium: --repo, potem GITHUB_REPOSITORY).
 */

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { parseArgs } = require('node:util');

const CORE_PATH = path.join(__dirname, 'labels-core.json');
const LOCAL_PATH = path.resolve(__dirname, '..', '..', 'labels.json');

const NAME_MAX = 50;
const DESCRIPTION_MAX = 100;
const COLOR = /^[0-9A-Fa-f]{6}$/;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// U+2010-U+2015 (łączniki typograficzne, półpauza, pauza) i U+2212 (minus): w tekstach tylko ASCII "-".
const FORBIDDEN_DASHES = /[‐-―−]/;
const CONTROL = /\p{Cc}/u;
// Etykiety, których wymaga bramka audytu zgłoszeń i triage: rdzeń musi je zawierać, a migracja nie może ich ruszyć,
// niezależnie od zawartości edytowanego pliku rdzenia.
const REQUIRED_CORE = ['audit:pending', 'audit:ok', 'audit:changes', 'needs-triage', 'P0', 'P1', 'P2', 'P3', 'P4', 'T1', 'T2', 'T3'];

const FAMILY_KEYS = new Set(['prefix', 'color', 'cardinality', 'note']);
const LABEL_KEYS = new Set(['name', 'color', 'description', 'family']);
const CORE_KEYS = new Set(['schema', 'families', 'labels']);
const LOCAL_KEYS = new Set(['schema', 'repo', 'families', 'labels', 'system', 'foreign', 'migrations']);
const MIGRATION_KEYS = new Set(['rename', 'delete']);
const RENAME_KEYS = new Set(['from', 'to']);

/** Błąd działania (zły plik, sieć, uprawnienia): komunikat na stderr i kod wyjścia 2. */
class LabelsError extends Error {}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const fold = (name) => String(name).toLowerCase();

function textErrors(where, value, limit) {
  if (typeof value !== 'string' || value === '') return [`${where}: pusty albo nie jest napisem`];
  const errors = [];
  if (value !== value.trim()) errors.push(`${where}: spacje na brzegach`);
  if (CONTROL.test(value)) errors.push(`${where}: znak sterujący`);
  if (value.normalize('NFC') !== value) errors.push(`${where}: tekst nie jest w postaci NFC`);
  if (value.includes('�')) errors.push(`${where}: znak zastępczy U+FFFD (zepsute kodowanie)`);
  if ([...value].length > limit) errors.push(`${where}: ${[...value].length} znaków, limit ${limit}`);
  return errors;
}

/** Nazwa etykiety: tekst plus zakazy bezpieczeństwa (przecinek psuje filtr użycia, `.` i `..` zmieniają ścieżkę API). */
function nameErrors(where, value) {
  const errors = textErrors(where, value, NAME_MAX);
  if (typeof value !== 'string') return errors;
  if (value.includes(',')) errors.push(`${where}: przecinek w nazwie (kontrola użycia byłaby zawodna)`);
  if (value === '.' || value === '..') errors.push(`${where}: nazwa '.' i '..' jest zabroniona`);
  return errors;
}

function unknownKeys(where, value, allowed) {
  return Object.keys(value).filter((key) => !allowed.has(key)).map((key) => `${where}: nieznane pole '${key}'`);
}

function familyErrors(where, families) {
  if (!isObject(families)) return [`${where}.families: oczekiwano obiektu`];
  const errors = [];
  for (const [name, family] of Object.entries(families)) {
    const at = `${where}.families.${name}`;
    if (!isObject(family)) { errors.push(`${at}: oczekiwano obiektu`); continue; }
    errors.push(...unknownKeys(at, family, FAMILY_KEYS));
    if ('prefix' in family && (typeof family.prefix !== 'string' || family.prefix === '')) errors.push(`${at}.prefix: pusty albo nie jest napisem`);
    if ('color' in family && !(typeof family.color === 'string' && COLOR.test(family.color))) errors.push(`${at}.color: nie jest 6 znakami hex`);
  }
  return errors;
}

function labelErrors(where, label, families) {
  if (!isObject(label)) return [`${where}: oczekiwano obiektu`];
  const at = `etykieta ${JSON.stringify(label.name)} (${where})`;
  const errors = unknownKeys(at, label, LABEL_KEYS);
  errors.push(...nameErrors(`${at} nazwa`, label.name), ...textErrors(`${at} opis`, label.description, DESCRIPTION_MAX));
  if (typeof label.description === 'string' && FORBIDDEN_DASHES.test(label.description)) errors.push(`${at}: pauza albo półpauza w opisie, używamy łącznika '-'`);
  if (!(typeof label.color === 'string' && COLOR.test(label.color))) errors.push(`${at}: kolor nie jest 6 znakami hex`);
  const family = isObject(families) ? families[label.family] : undefined;
  if (!isObject(family)) return [...errors, `${at}: nieznana rodzina ${JSON.stringify(label.family)}`];
  if (family.prefix && !String(label.name).startsWith(family.prefix)) errors.push(`${at}: rodzina ${label.family} wymaga prefiksu '${family.prefix}'`);
  if (family.color && String(label.color).toUpperCase() !== family.color.toUpperCase()) errors.push(`${at}: kolor ${label.color} różny od koloru rodziny ${family.color}`);
  return errors;
}

function listOfNames(where, value) {
  if (!Array.isArray(value)) return [`${where}: oczekiwano tablicy`];
  return value.flatMap((name) => nameErrors(`${where} ${JSON.stringify(name)}`, name));
}

function migrationErrors(migrations, coreNames, managedNames, knownNames) {
  if (!isObject(migrations)) return ['migrations: oczekiwano obiektu z polami rename i delete'];
  const errors = unknownKeys('migrations', migrations, MIGRATION_KEYS);
  const rename = migrations.rename ?? [];
  const remove = migrations.delete ?? [];
  if (!Array.isArray(rename)) errors.push('migrations.rename: oczekiwano tablicy');
  if (!Array.isArray(remove)) errors.push('migrations.delete: oczekiwano tablicy');
  if (errors.length) return errors;
  for (const entry of rename) {
    if (!isObject(entry)) { errors.push('migrations.rename: wpis musi być obiektem {from, to}'); continue; }
    errors.push(...unknownKeys('migrations.rename', entry, RENAME_KEYS));
    const { from, to } = entry;
    const where = `migracja ${JSON.stringify(from)} -> ${JSON.stringify(to)}`;
    if (typeof from !== 'string' || typeof to !== 'string') { errors.push(`${where}: from i to muszą być napisami`); continue; }
    errors.push(...nameErrors(`${where} from`, from), ...nameErrors(`${where} to`, to));
    if (coreNames.has(fold(from)) || coreNames.has(fold(to))) errors.push(`${where}: etykieta rdzenia jest nieprzemianowywalna`);
    if (!managedNames.has(fold(to))) errors.push(`${where}: cel nie jest etykietą zarządzaną`);
    if (knownNames.has(fold(from))) errors.push(`${where}: źródło nadal jest w manifeście`);
  }
  for (const name of remove) {
    if (typeof name !== 'string') { errors.push('migrations.delete: wpis musi być napisem (bez żadnych flag)'); continue; }
    errors.push(...nameErrors(`migracja delete ${JSON.stringify(name)}`, name));
    if (coreNames.has(fold(name))) errors.push(`migracja delete ${JSON.stringify(name)}: etykieta rdzenia jest nieusuwalna`);
    else if (knownNames.has(fold(name))) errors.push(`migracja delete ${JSON.stringify(name)}: etykieta nadal jest w manifeście`);
  }
  return errors;
}

/** Błędy rdzenia i pliku lokalnego (puste, gdy oba są poprawne); `repo` to bieżące repozytorium albo null. */
function validate(core, local, repo) {
  if (!isObject(core)) return ['rdzeń: oczekiwano obiektu'];
  if (!isObject(local)) return ['plik lokalny: oczekiwano obiektu'];
  const errors = [...unknownKeys('rdzeń', core, CORE_KEYS), ...unknownKeys('plik lokalny', local, LOCAL_KEYS)];
  if (core.schema !== 1) errors.push('rdzeń: schema musi wynosić 1');
  if (local.schema !== 1) errors.push('plik lokalny: schema musi wynosić 1');
  if (typeof local.repo !== 'string' || !REPO_NAME.test(local.repo)) errors.push('plik lokalny: repo musi mieć postać wlasciciel/nazwa');
  else if (repo && fold(local.repo) !== fold(repo)) errors.push(`plik lokalny: repo wskazuje ${local.repo}, bieżące repozytorium to ${repo}`);
  errors.push(...familyErrors('rdzeń', core.families), ...familyErrors('plik lokalny', local.families));
  if (!Array.isArray(core.labels) || core.labels.length === 0) errors.push('rdzeń: labels musi być niepustą tablicą');
  if (!Array.isArray(local.labels)) errors.push('plik lokalny: labels musi być tablicą');
  const system = local.system ?? [];
  const foreign = local.foreign ?? [];
  errors.push(...listOfNames('system', system), ...listOfNames('foreign', foreign));
  if (errors.length) return errors;

  for (const family of Object.keys(local.families)) {
    if (family in core.families) errors.push(`plik lokalny: rodzina ${family} należy do rdzenia`);
  }
  const families = { ...core.families, ...local.families };
  core.labels.forEach((label) => errors.push(...labelErrors('rdzeń', label, core.families)));
  local.labels.forEach((label) => errors.push(...labelErrors('plik lokalny', label, local.families)));
  if (errors.length) return errors;

  const seen = new Map();
  const kinds = [['rdzeń', core.labels.map((l) => l.name)], ['lokalna', local.labels.map((l) => l.name)], ['systemowa', system], ['obca', foreign]];
  for (const [kind, names] of kinds) {
    for (const name of names) {
      const key = fold(name);
      if (seen.has(key)) errors.push(`duplikat: ${JSON.stringify(name)} (${kind}) koliduje z ${seen.get(key)}`);
      else seen.set(key, `${JSON.stringify(name)} (${kind})`);
    }
  }
  for (const label of [...core.labels, ...local.labels]) {
    for (const [name, family] of Object.entries(families)) {
      if (family.prefix && name !== label.family && label.name.startsWith(family.prefix)) errors.push(`etykieta ${JSON.stringify(label.name)}: prefiks '${family.prefix}' należy do rodziny ${name}`);
    }
  }
  if (!local.labels.some((label) => label.name.startsWith('area:'))) errors.push("plik lokalny: brak etykiety z prefiksem 'area:'");
  const coreNames = new Set(core.labels.map((l) => fold(l.name)));
  for (const required of REQUIRED_CORE) {
    if (!core.labels.some((l) => l.name === required)) errors.push(`rdzeń: brak etykiety ${required}, której wymaga bramka audytu`);
  }
  const managedNames = new Set([...core.labels, ...local.labels].map((l) => fold(l.name)));
  errors.push(...migrationErrors(local.migrations ?? {}, coreNames, managedNames, new Set(seen.keys())));
  return errors;
}

/** Zarządzane etykiety (rdzeń, potem lokalne) i klasyfikacja cudzych z poprawnych plików. */
function merge(core, local) {
  return {
    labels: [...core.labels, ...local.labels],
    coreNames: core.labels.map((l) => l.name),
    system: local.system ?? [],
    foreign: local.foreign ?? [],
    migrations: { rename: local.migrations?.rename ?? [], delete: local.migrations?.delete ?? [] }
  };
}

/** Plan zmian: różnica między manifestem a stanem żywym (`live`: lista {name, color, description}). */
function plan(manifest, live) {
  const result = { create: [], update: [], rename: [], delete: [], unchanged: [], missingKnown: [], conflicts: [] };
  const existing = new Map();
  for (const label of live) {
    const key = fold(label.name);
    if (existing.has(key)) result.conflicts.push(`duplikat w repozytorium: ${JSON.stringify(label.name)}`);
    existing.set(key, label);
  }
  const claimed = new Set();
  const renamed = new Set();
  for (const { from, to } of manifest.migrations.rename) {
    const source = fold(from);
    const target = fold(to);
    if (!existing.has(source)) continue;
    if (existing.has(target)) {
      claimed.add(source);
      result.conflicts.push(`migracja ${JSON.stringify(from)} -> ${JSON.stringify(to)}: obie etykiety istnieją`);
      continue;
    }
    result.rename.push([existing.get(source).name, to]);
    existing.set(target, { ...existing.get(source), name: to });
    existing.delete(source);
    renamed.add(target);
  }
  for (const label of manifest.labels) {
    const key = fold(label.name);
    claimed.add(key);
    const found = existing.get(key);
    if (!found) { result.create.push(label); continue; }
    const what = [];
    if (found.name !== label.name) what.push('nazwa');
    if (found.color.toUpperCase() !== label.color.toUpperCase()) what.push('kolor');
    if ((found.description || '') !== label.description) what.push('opis');
    if (what.length) result.update.push({ name: found.name, label, what });
    else if (!renamed.has(key)) result.unchanged.push(label.name);
  }
  for (const name of manifest.migrations.delete) {
    const key = fold(name);
    if (existing.has(key)) { claimed.add(key); result.delete.push(existing.get(key).name); }
  }
  for (const name of [...manifest.system, ...manifest.foreign]) {
    claimed.add(fold(name));
    if (!existing.has(fold(name))) result.missingKnown.push(name);
  }
  result.unclassified = [...existing].filter(([key]) => !claimed.has(key)).map(([, label]) => label.name).sort();
  return result;
}

const pending = (p) => p.create.length + p.update.length + p.rename.length + p.delete.length > 0;
const inSync = (p) => !pending(p) && p.unclassified.length === 0 && p.conflicts.length === 0;

function planLines(p) {
  const show = (values) => (values.length ? values.join(', ') : '-');
  return [
    `Do utworzenia: ${show(p.create.map((l) => l.name))}`,
    `Do zmiany: ${show(p.update.map((u) => `${u.name} (${u.what.join('/')})`))}`,
    `Do przemianowania: ${show(p.rename.map(([a, b]) => `${a} -> ${b}`))}`,
    `Do usunięcia (migracja): ${show(p.delete)}`,
    `Bez zmian: ${show(p.unchanged)}`,
    `Niesklasyfikowane w repozytorium: ${show(p.unclassified)}`,
    `Znane (system/obce) nieobecne w repozytorium: ${show(p.missingKnown)}`,
    `Konflikty: ${show(p.conflicts)}`
  ];
}

function report(out, title, lines, env) {
  out.log(`## ${title}`);
  lines.forEach((line) => out.log(`- ${line}`));
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${title}\n\n${lines.map((line) => `- ${line}\n`).join('')}\n`);
}

function defaultRun(args) {
  try {
    return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    throw new LabelsError(`gh ${args.slice(0, 3).join(' ')}: ${String(error.stderr || error.message).trim().split('\n')[0]}`);
  }
}

/** Klient GitHub przez `gh api` (REST); `run` podstawiany w testach. Odczyty stronicują do końca albo kończą się błędem. */
function ghClient(repo, run = defaultRun) {
  const labelPath = (name) => `repos/${repo}/labels/${encodeURIComponent(name)}`;
  const fields = (label) => ['-f', `color=${label.color}`, '-f', `description=${label.description}`];
  const lines = (output) => output.split('\n').filter((line) => line.trim() !== '');
  return {
    listLabels() {
      const output = run(['api', '--paginate', `repos/${repo}/labels?per_page=100`, '--jq', '.[] | {name, color, description}']);
      return lines(output).map((line) => {
        const item = JSON.parse(line);
        return { name: item.name, color: item.color, description: item.description || '' };
      });
    },
    usage(name) {
      const query = `repos/${repo}/issues?labels=${encodeURIComponent(name)}&state=all&per_page=100`;
      return lines(run(['api', '--paginate', query, '--jq', '.[].number'])).length;
    },
    create(label) { run(['api', '-X', 'POST', `repos/${repo}/labels`, '-f', `name=${label.name}`, ...fields(label)]); },
    update(name, label) { run(['api', '-X', 'PATCH', labelPath(name), '-f', `new_name=${label.name}`, ...fields(label)]); },
    rename(name, to) { run(['api', '-X', 'PATCH', labelPath(name), '-f', `new_name=${to}`]); },
    remove(name) { run(['api', '-X', 'DELETE', labelPath(name)]); }
  };
}

/** Etykiety do usunięcia, które są w użyciu: pary {name, count}. Odczyt, bez zapisu. */
function inUse(client, names) {
  return names.map((name) => ({ name, count: client.usage(name) })).filter((item) => item.count > 0);
}

/** Operacje planu w kolejności: nazwy, utworzenia, poprawki, usunięcia. Każda ma opis do logu i wykonanie. */
function operations(p, client) {
  return [
    ...p.rename.map(([from, to]) => ({ text: `rename ${from} -> ${to}`, run: () => client.rename(from, to) })),
    ...p.create.map((label) => ({ text: `create ${label.name}`, run: () => client.create(label) })),
    ...p.update.map((item) => ({ text: `update ${item.name} (${item.what.join('/')})`, run: () => client.update(item.name, item.label) })),
    ...p.delete.map((name) => ({
      text: `delete ${name}`,
      run: () => {
        const count = client.usage(name);
        if (count > 0) throw new LabelsError(`etykieta ${name} jest w użyciu (${count}), usunięcie wstrzymane`);
        client.remove(name);
      }
    }))
  ];
}

/** Test uprawnień do zapisu bez zmiany stanu: aktualizacja istniejącej etykiety do jej własnych wartości. */
function probeWrite(client, manifest, live) {
  const wanted = new Set(manifest.labels.map((l) => fold(l.name)));
  const found = live.find((label) => wanted.has(fold(label.name)));
  if (found) client.update(found.name, found);
}

function execute(client, p, out) {
  for (const op of operations(p, client)) {
    try {
      op.run();
    } catch (error) {
      out.log(`- ${op.text}: BŁĄD`);
      throw new LabelsError(`${op.text}: ${error.message}; dalsze operacje (w tym usunięcia) wstrzymane, ponowny bieg planuje od nowa`);
    }
    out.log(`- ${op.text}: ok`);
  }
}

function readJson(file, readFile) {
  let text;
  try {
    text = readFile(file);
  } catch (error) {
    throw new LabelsError(`brak pliku ${file} (${error.code || 'błąd odczytu'})`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new LabelsError(`${file}: nie jest poprawnym JSON (${error.message})`);
  }
}

function parseCli(argv) {
  const options = {
    core: { type: 'string', default: CORE_PATH }, local: { type: 'string', default: LOCAL_PATH }, repo: { type: 'string' },
    live: { type: 'string' }, strict: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }
  };
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new LabelsError(error.message);
  }
  const [command, ...extra] = parsed.positionals;
  if (!['check', 'diff', 'sync'].includes(command) || extra.length) throw new LabelsError('użycie: labels_sync.js check | diff | sync');
  return { command, ...parsed.values };
}

/** Punkt wejścia z wstrzykiwanymi zależnościami (testy); zwraca kod wyjścia. */
function main(argv, deps = {}) {
  const out = deps.out || console;
  const env = deps.env || process.env;
  const readFile = deps.readFile || ((file) => fs.readFileSync(file, 'utf8'));
  try {
    const args = parseCli(argv);
    if (args.live && args.command !== 'diff') throw new LabelsError('--live dotyczy tylko polecenia diff; sync zawsze czyta stan z API');
    const core = readJson(args.core, readFile);
    const local = readJson(args.local, readFile);
    const repo = args.repo || env.GITHUB_REPOSITORY || null;
    const errors = validate(core, local, repo);
    if (errors.length) {
      report(out, 'Manifest etykiet: błędy', errors, env);
      return 2;
    }
    const manifest = merge(core, local);
    if (args.command === 'check') {
      report(out, 'Manifest etykiet: poprawny', [`etykiety zarządzane: ${manifest.labels.length} (rdzeń: ${manifest.coreNames.length})`], env);
      return 0;
    }
    if (!repo) throw new LabelsError('brak repozytorium: podaj --repo albo ustaw GITHUB_REPOSITORY');
    return runAgainstRepo(args, manifest, deps.client || ghClient(repo, deps.run), { out, env, readFile, repo });
  } catch (error) {
    // Fail-closed: każdy błąd (także nieprzewidziany, np. zepsuta odpowiedź API) to kod 2, nigdy zielony wynik.
    (deps.err || console).error(`labels_sync: ${error.message}`);
    return 2;
  }
}

function runAgainstRepo(args, manifest, client, { out, env, readFile, repo }) {
  const live = args.live ? readJson(args.live, readFile) : client.listLabels();
  const current = plan(manifest, live);
  if (args.command === 'diff') {
    report(out, `Stan etykiet w ${repo}: ${inSync(current) ? 'zgodny z manifestem' : 'różni się od manifestu'}`, planLines(current), env);
    return args.strict && !inSync(current) ? 1 : 0;
  }
  report(out, `Plan synchronizacji ${repo}`, planLines(current), env);
  if (current.conflicts.length) return 1;
  const used = inUse(client, current.delete);
  if (used.length) {
    report(out, 'Usunięcie wstrzymane: etykieta w użyciu', used.map((item) => `${item.name}: ${item.count} zgłoszeń lub PR`), env);
    return 1;
  }
  if (args['dry-run']) return 0;
  if (pending(current)) probeWrite(client, manifest, live);
  execute(client, current, out);
  const after = plan(manifest, client.listLabels());
  report(out, `Stan etykiet po synchronizacji: ${inSync(after) ? 'zgodny z manifestem' : 'różni się od manifestu'}`, planLines(after), env);
  return inSync(after) ? 0 : 1;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { LabelsError, validate, merge, plan, inSync, pending, ghClient, main, parseCli, readJson, CORE_PATH, LOCAL_PATH };
