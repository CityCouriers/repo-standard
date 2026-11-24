'use strict';
// Klient REST GitHuba dla kontroli rozjazdu: `gh api` bez powłoki (argumenty w tablicy, treść żądania ze stdin).
// Token czyta `gh` ze zmiennej GH_TOKEN; skrypt go nie widzi i nie wypisuje. Każdy błąd to `DriftError`
// (kod wyjścia 2 u wywołującego): brak odpowiedzi nigdy nie jest „brakiem rozjazdu".

const childProcess = require('node:child_process');

const MAX_BUFFER = 64 * 1024 * 1024;
const PATH = /^repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.%~+-]+)*(\?[A-Za-z0-9_.%~+=&,:-]*)?$/;

/** Błąd wywołania API; `notFound` odróżnia brak zasobu (HTTP 404) od awarii. */
class DriftError extends Error {
  constructor(message, { notFound = false } = {}) {
    super(message);
    this.name = 'DriftError';
    this.notFound = notFound;
  }
}

function defaultRun(args, input) {
  return childProcess.execFileSync('gh', args, { encoding: 'utf8', maxBuffer: MAX_BUFFER, input, stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Klient: `run(args, input)` zwraca stdout albo rzuca; podstawiany w testach. */
function makeApi(run = defaultRun) {
  const call = (path, args, input) => {
    if (!PATH.test(path) || path.split('?', 1)[0].split('/').some((part) => part === '.' || part === '..')) {
      throw new DriftError(`niedozwolona ścieżka API: ${path}`);
    }
    try {
      return run(args, input);
    } catch (error) {
      const detail = String(error.stderr || error.message).split('\n')[0].slice(0, 200);
      throw new DriftError(`gh api ${path}: ${detail}`, { notFound: /HTTP 404/.test(detail) });
    }
  };
  const parse = (text, path) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new DriftError(`gh api ${path}: odpowiedź nie jest JSON`);
    }
  };
  return {
    get: (path) => parse(call(path, ['api', path]), path),
    /** Wszystkie strony odpowiedzi tablicowej (`per_page=100` w ścieżce). */
    getAll(path) {
      const out = call(path, ['api', '--paginate', path, '--jq', '.[]']);
      return out.split('\n').filter((line) => line.trim() !== '').map((line) => parse(line, path));
    },
    send(method, path, body) {
      const out = call(path, ['api', '-X', method, path, '--input', '-'], JSON.stringify(body));
      return out.trim() === '' ? null : parse(out, path);
    },
  };
}

module.exports = { DriftError, makeApi, PATH };
