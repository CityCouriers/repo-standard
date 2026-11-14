'use strict';
// Plik parametrów repozytorium (`.github/repo-standard.json`): wczytanie i walidacja.
//
// To jedyny plik konsumenta, którego standard nigdy nie nadpisuje. Walidacja jest ścisła: nieznany klucz,
// zły typ albo zły format to błąd, a nie wartość domyślna (fail-closed). Wyjątki (`overrides`) mają
// rozdzielone dwa poziomy: składnia i zgodność z manifestem sprawdza ten moduł, a stan zgłoszenia
// (otwarte, `audit:ok`) nie jest tu sprawdzany wcale: wynik dla poprawnego wyjątku to zawsze
// UNVERIFIED_NOTE, nigdy zgoda.

const PARAMS_PATH = '.github/repo-standard.json';
const SCHEMA = 1;
const TOP_KEYS = ['schema', 'standard', 'audit', 'triage', 'quality_gate', 'review_gate', 'overrides'];
const VERSION = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
// Wzorce dat wyłącznie wyciągają składniki; kształt całego napisu rozstrzyga porównanie z zapisem odtworzonym z `Date`.
const ISO_UTC = /([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})Z/;
const ISO_DATE = /([0-9]{4})-([0-9]{2})-([0-9]{2})/;
const ISSUE_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9][0-9]*$/;
const WORKFLOW_FILE = /^[A-Za-z0-9_.-]+\.ya?ml$/;
const EVENTS = ['pull_request', 'push', 'workflow_dispatch'];
const OVERRIDE_KEYS = ['path', 'reason', 'until', 'issue'];
const OVERRIDE_MAX_DAYS = 90;
const UNVERIFIED_NOTE = 'składnia poprawna, stan zgłoszenia niezweryfikowany';
const DAY_MS = 86400000;

class ParamsError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.name = 'ParamsError';
    this.errors = errors;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function parseVersion(value) {
  const match = typeof value === 'string' ? VERSION.exec(value) : null;
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Milisekundy UTC dla poprawnej daty kalendarzowej albo null. Poprawność to równość napisu z zapisem odtworzonym
 * z `Date` (`render`): 30 lutego, godzina 24, zbędny prefiks albo sufiks dają inny zapis niż oryginał.
 */
function instantMs(value, pattern, render) {
  const match = typeof value === 'string' ? pattern.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  return render(new Date(ms).toISOString()) === value ? ms : null;
}

const validInstant = (value) => instantMs(value, ISO_UTC, (iso) => `${iso.slice(0, 19)}Z`) !== null;
const dateMs = (value) => instantMs(value, ISO_DATE, (iso) => iso.slice(0, 10));

/** Ścieżka względna w repo: segmenty niepuste i bez `.`/`..`, bez `\`, `:` i znaków sterujących. */
function safeRelative(path) {
  if (typeof path !== 'string' || path !== path.trim()) return false;
  if (path.includes('\\') || path.includes(':')) return false;
  if ([...path].some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)) return false;
  return path.split('/').every((part) => part !== '' && part !== '.' && part !== '..');
}

const isStringList = (value) => Array.isArray(value) && value.every((item) => typeof item === 'string' && item !== '');

function objectErrors(where, value, keys) {
  if (!isObject(value)) return [`${where}: oczekiwano obiektu`];
  return [
    ...Object.keys(value).filter((key) => !keys.includes(key)).map((key) => `${where}: nieznany klucz '${key}'`),
    ...keys.filter((key) => !has(value, key)).map((key) => `${where}: brak klucza '${key}'`),
  ];
}

function standardErrors(value) {
  const errors = objectErrors('standard', value, ['version', 'sha']);
  if (errors.length) return errors;
  if (parseVersion(value.version) === null) errors.push(`standard.version: oczekiwano postaci v1.2.3, jest ${JSON.stringify(value.version)}`);
  if (typeof value.sha !== 'string' || !FULL_SHA.test(value.sha)) errors.push('standard.sha: oczekiwano pełnego SHA (40 znaków hex, małe litery)');
  return errors;
}

function activationErrors(name, value) {
  const errors = objectErrors(name, value, ['active_since']);
  if (errors.length) return errors;
  const since = value.active_since;
  if (since !== '' && !validInstant(since)) {
    return [`${name}.active_since: oczekiwano RRRR-MM-DDTGG:MM:SSZ (UTC) albo pustego napisu, jest ${JSON.stringify(since)}`];
  }
  return [];
}

function qualityGateErrors(value) {
  const errors = objectErrors('quality_gate', value, ['workflow', 'jobs', 'required']);
  if (errors.length) return errors;
  if (typeof value.workflow !== 'string' || !WORKFLOW_FILE.test(value.workflow)) errors.push('quality_gate.workflow: oczekiwano nazwy pliku .yml/.yaml');
  const jobs = value.jobs;
  if (!isStringList(jobs) || jobs.length === 0 || new Set(jobs).size !== jobs.length) {
    return [...errors, 'quality_gate.jobs: oczekiwano niepustej listy unikalnych nazw jobów'];
  }
  const required = value.required;
  errors.push(...objectErrors('quality_gate.required', required, EVENTS));
  if (isObject(required)) {
    for (const event of EVENTS) {
      const names = required[event];
      if (!isStringList(names) || new Set(names).size !== names.length) {
        errors.push(`quality_gate.required.${event}: oczekiwano listy unikalnych nazw jobów`);
      } else if (names.some((name) => !jobs.includes(name))) {
        errors.push(`quality_gate.required.${event}: jobów spoza \`jobs\`: ${JSON.stringify(names.filter((name) => !jobs.includes(name)))}`);
      }
    }
  }
  return errors;
}

function reviewGateErrors(value) {
  const errors = objectErrors('review_gate', value, ['protected_paths']);
  if (errors.length) return errors;
  const paths = value.protected_paths;
  if (!Array.isArray(paths) || !paths.every(safeRelative)) return ['review_gate.protected_paths: oczekiwano listy bezpiecznych ścieżek względnych'];
  return [];
}

function overrideErrors(index, entry) {
  const where = `overrides[${index}]`;
  const errors = objectErrors(where, entry, OVERRIDE_KEYS);
  if (errors.length) return errors;
  if (!safeRelative(entry.path)) errors.push(`${where}.path: oczekiwano bezpiecznej ścieżki względnej`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') errors.push(`${where}.reason: powód jest wymagany`);
  if (dateMs(entry.until) === null) errors.push(`${where}.until: oczekiwano istniejącej daty RRRR-MM-DD`);
  if (typeof entry.issue !== 'string' || !ISSUE_REF.test(entry.issue)) errors.push(`${where}.issue: oczekiwano postaci wlasciciel/repo#nr`);
  return errors;
}

/** Lista błędów schematu; pusta, gdy plik jest poprawny. */
function validate(params) {
  if (!isObject(params)) return ['plik parametrów: oczekiwano obiektu JSON'];
  const errors = [
    ...Object.keys(params).filter((key) => !TOP_KEYS.includes(key)).map((key) => `nieznany klucz '${key}'`),
    ...TOP_KEYS.filter((key) => !has(params, key)).map((key) => `brak klucza '${key}'`),
  ];
  if (has(params, 'schema') && params.schema !== SCHEMA) errors.push(`schema: oczekiwano ${SCHEMA}, jest ${JSON.stringify(params.schema)}`);
  const checks = [
    ['standard', standardErrors],
    ['audit', (value) => activationErrors('audit', value)],
    ['triage', (value) => activationErrors('triage', value)],
    ['quality_gate', qualityGateErrors],
    ['review_gate', reviewGateErrors],
  ];
  for (const [key, check] of checks) if (has(params, key)) errors.push(...check(params[key]));
  if (has(params, 'overrides')) {
    const overrides = params.overrides;
    if (!Array.isArray(overrides)) {
      errors.push('overrides: oczekiwano listy');
    } else {
      overrides.forEach((entry, index) => errors.push(...overrideErrors(index, entry)));
      const paths = overrides.filter(isObject).map((entry) => entry.path);
      const repeated = [...new Set(paths.filter((path, index) => paths.indexOf(path) !== index))].sort();
      errors.push(...repeated.map((path) => `overrides: powtórzona ścieżka ${JSON.stringify(path)}`));
    }
  }
  return errors;
}

/**
 * Odstępstwa względem manifestu: tylko składnia i zgodność z flagami wpisu, bez sprawdzania zgłoszenia.
 * Zwraca { errors, notes }. Poprawne odstępstwo daje wyłącznie notatkę UNVERIFIED_NOTE; nie jest ono uznane
 * (wywołujący nie może pomijać kontroli pliku na jego podstawie).
 */
function overrideFindings(manifest, overrides, todayMs) {
  const entries = new Map(manifest.files.map((entry) => [entry.path, entry]));
  const errors = [];
  const notes = [];
  for (const override of overrides) {
    const entry = entries.get(override.path);
    if (!entry) {
      errors.push(`odstępstwo dla pliku spoza manifestu: ${override.path}`);
    } else if (entry.critical) {
      errors.push(`odstępstwo dla pliku krytycznego jest niedozwolone: ${override.path}`);
    } else if (entry.overridable !== true) {
      errors.push(`plik nie dopuszcza odstępstwa: ${override.path}`);
    } else {
      const until = dateMs(override.until);
      if (until < todayMs) errors.push(`odstępstwo wygasło ${override.until}: ${override.path}`);
      else if ((until - todayMs) / DAY_MS > OVERRIDE_MAX_DAYS) errors.push(`odstępstwo z terminem dalszym niż ${OVERRIDE_MAX_DAYS} dni: ${override.path}`);
      else notes.push(`odstępstwo ${override.path}: ${UNVERIFIED_NOTE}, nie jest uznane`);
    }
  }
  return { errors, notes };
}

/** Pełna walidacja lokalna: schemat plus odstępstwa względem manifestu. Zwraca { errors, notes }. */
function validateWithManifest(params, manifest, todayMs) {
  const errors = validate(params);
  if (errors.length) return { errors, notes: [] };
  return overrideFindings(manifest, params.overrides, todayMs);
}

/** JSON z odrzuceniem powtórzonych kluczy (powtórzenie zmieniłoby wartość po cichu); obiekty bez efektów `__proto__`. */
function parseJsonObject(text) {
  let pos = 0;
  const fail = (message) => { throw new SyntaxError(`${message} (pozycja ${pos})`); };
  const skip = () => { while (pos < text.length && ' \t\r\n'.includes(text.charAt(pos))) pos += 1; };
  const literal = (word, value) => {
    if (text.startsWith(word, pos)) { pos += word.length; return value; }
    return fail('nieoczekiwany znak');
  };
  const string = () => {
    const start = pos;
    pos += 1;
    while (pos < text.length && text[pos] !== '"') pos += text[pos] === '\\' ? 2 : 1;
    if (pos >= text.length) fail('nieskończony napis');
    pos += 1;
    return JSON.parse(text.slice(start, pos));
  };
  const value = () => {
    skip();
    const char = text[pos];
    if (char === '{') {
      pos += 1;
      const object = {};
      skip();
      if (text[pos] === '}') { pos += 1; return object; }
      for (;;) {
        skip();
        if (text[pos] !== '"') fail('oczekiwano klucza');
        const key = string();
        if (has(object, key)) fail(`powtórzony klucz JSON ${JSON.stringify(key)}`);
        skip();
        if (text[pos] !== ':') fail('oczekiwano ":"');
        pos += 1;
        Object.defineProperty(object, key, { value: value(), enumerable: true, writable: true, configurable: true });
        skip();
        if (text[pos] === ',') { pos += 1; continue; }
        if (text[pos] === '}') { pos += 1; return object; }
        fail('oczekiwano "," albo "}"');
      }
    }
    if (char === '[') {
      pos += 1;
      const list = [];
      skip();
      if (text[pos] === ']') { pos += 1; return list; }
      for (;;) {
        list.push(value());
        skip();
        if (text[pos] === ',') { pos += 1; continue; }
        if (text[pos] === ']') { pos += 1; return list; }
        fail('oczekiwano "," albo "]"');
      }
    }
    if (char === '"') return string();
    if (char === 't') return literal('true', true);
    if (char === 'f') return literal('false', false);
    if (char === 'n') return literal('null', null);
    const number = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(text.slice(pos));
    if (!number) return fail('nieoczekiwany znak');
    pos += number[0].length;
    return Number(number[0]);
  };
  const result = value();
  skip();
  if (pos !== text.length) fail('dane po końcu dokumentu');
  return result;
}

/** Wczytuje i waliduje plik parametrów; błąd to `ParamsError`. */
function load(text) {
  let params;
  try {
    params = parseJsonObject(text);
  } catch (error) {
    throw new ParamsError([`plik parametrów nie jest poprawnym JSON: ${error.message}`]);
  }
  const errors = validate(params);
  if (errors.length) throw new ParamsError(errors);
  return params;
}

module.exports = {
  PARAMS_PATH, SCHEMA, FULL_SHA, EVENTS, OVERRIDE_MAX_DAYS, UNVERIFIED_NOTE, ParamsError,
  parseVersion, validInstant, dateMs, safeRelative, isStringList, isObject, has,
  validate, overrideFindings, validateWithManifest, parseJsonObject, load,
};
