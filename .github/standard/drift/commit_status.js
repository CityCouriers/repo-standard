'use strict';
// Wspólny mechanizm jawnego commit status dla kontroli wymaganych na HEAD PR (`standard-drift`, skan sekretów):
// HEAD czytany przez API (nie ze zdarzenia), `pending` na starcie, ponowny odczyt HEAD przed zapisem wyniku,
// błąd obliczeń to `failure` (nigdy `success`), reconciler po zmianie domyślnej gałęzi z granicą liczby PR.
// Zależy wyłącznie od klienta API (`get`, `getAll`, `send`) i od czystej logiki w `drift_core.js`.

const params = require('../common/params');
const core = require('./drift_core');
const { DriftError } = require('./drift_api');

function validSha(value, what) {
  if (typeof value !== 'string' || !params.FULL_SHA.test(value)) throw new DriftError(`${what}: oczekiwano pełnego SHA`);
  return value;
}

/** Zapisuje commit status o stałym kontekście na SHA. */
function setStatus(api, repo, sha, context, state, description) {
  api.send('POST', `repos/${repo}/statuses/${sha}`, core.statusBody(state, description, context));
}

/** Pełny SHA HEAD PR odczytany przez API w chwili wywołania. */
function readPrHead(api, repo, number) {
  return validSha(api.get(`repos/${repo}/pulls/${number}`)?.head?.sha, `PR ${number}: HEAD`);
}

/**
 * Jeden PR: `pending` (gdy `announce` to opis), `compute()` zwraca { state, description, lines, code }, ponowny
 * odczyt HEAD i zapis wyniku. HEAD zmieniony w trakcie = brak zapisu (nowy commit ma własny bieg). Wyjątek z
 * `compute` zapisuje `failure` z kodem 2. `isCurrent()` (opcjonalne) = false oznacza, że baza przesunęła się w trakcie biegu:
 * brak zapisu, status zostaje `pending` (nowszy bieg albo reconciler go rozstrzygnie). Zwraca { result, written, current, stale }.
 */
async function guardedResult(api, repo, number, headSha, context, compute, { announce = null, isCurrent = null } = {}) {
  if (announce !== null) setStatus(api, repo, headSha, context, 'pending', announce);
  let result;
  try {
    result = await compute();
  } catch (error) {
    result = { state: 'failure', description: `błąd działania: ${core.sanitize(error.message, 100)}`, lines: [`${error.name}: ${error.message}`], code: 2 };
  }
  const current = readPrHead(api, repo, number);
  if (current !== headSha) return { result, written: false, current, stale: false };
  if (isCurrent !== null && !isCurrent()) return { result, written: false, current, stale: true };
  setStatus(api, repo, headSha, context, result.state, result.description);
  return { result, written: true, current, stale: false };
}

/**
 * Reconciler: (1) `pending` na HEAD każdego otwartego PR do gałęzi `base` (przed jakimkolwiek przeliczeniem),
 * (2) `recompute(number)` (zwraca kod) dla najwyżej `maxRecalc` z nich; reszta zostaje `pending`. Błąd zapisu
 * pending albo przeliczenia to kod 2 i linia w `lines`, pozostałe PR są dalej obsługiwane.
 * Zwraca { code, lines, open, recomputed, skipped }.
 */
async function reconcileOpenPrs(api, repo, base, context, pendingDescription, recompute, { maxRecalc = core.MAX_RECALC } = {}) {
  const open = api.getAll(`repos/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`);
  const numbers = [];
  const lines = [];
  let code = 0;
  for (const pr of open) {
    const { number } = pr;
    try {
      setStatus(api, repo, validSha(pr.head.sha, `PR ${number}: HEAD`), context, 'pending', pendingDescription);
      numbers.push(number);
    } catch (error) {
      lines.push(`PR ${number}: nie ustawiono pending: ${error.message}`);
      code = 2;
    }
  }
  const batch = numbers.slice(0, maxRecalc);
  for (const number of batch) {
    try {
      if (await recompute(number) === 2) code = 2;
    } catch (error) {
      lines.push(`PR ${number}: przeliczenie nie powiodło się, zostaje pending: ${error.message}`);
      code = 2;
    }
  }
  return { code, lines, open: open.length, recomputed: batch.length, skipped: numbers.length - batch.length };
}

module.exports = { validSha, setStatus, readPrHead, guardedResult, reconcileOpenPrs };
