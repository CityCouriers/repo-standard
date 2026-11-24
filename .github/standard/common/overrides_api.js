'use strict';
// Weryfikacja stanu zgłoszeń odstępstw (`overrides`) przez REST API GitHuba. Używana wyłącznie przez
// `standard_sync.js check --verify-overrides`; `apply` i zwykły `check` nie używają sieci do tego celu.
//
// Odstępstwo jest uznane tylko wtedy, gdy zgłoszenie jest w TYM SAMYM repozytorium co kontrolowane, jest
// zgłoszeniem (nie PR), jest otwarte i ma etykietę `audit:ok`. Każdy błąd API (sieć, status inny niż 200,
// przekierowanie, zła odpowiedź) to `OverrideApiError`: wywołujący kończy kodem 2 i nic nie uznaje (fail-closed).
// Token idzie wyłącznie na adres z `endpoints.api`, nie trafia do komunikatów i nie jest śledzony przez przekierowania.

const https = require('node:https');

const MAX_BODY = 1000000;
const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_REF = /^([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
const AUDIT_OK = 'audit:ok';

/** Błąd działania API (sieć, status, odpowiedź): nie jest rozjazdem, tylko brakiem możliwości weryfikacji. */
class OverrideApiError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OverrideApiError';
  }
}

/** Klient JSON: https, nagłówek `Authorization` ze zmiennej, status 200, obiekt JSON do MAX_BODY bajtów. */
function makeApiGet({ token, ca, timeoutMs = 15000 }) {
  return (url) => new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new OverrideApiError(`zły adres API: ${url}`));
    }
    if (parsed.protocol !== 'https:') return reject(new OverrideApiError(`API tylko przez https: ${url}`));
    const fail = (error) => reject(error instanceof OverrideApiError ? error : new OverrideApiError(`zapytanie ${url}: ${error.message}`));
    const request = https.request(parsed, {
      ca,
      headers: {
        'User-Agent': 'repo-standard-sync',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        Authorization: `Bearer ${token}`,
      },
      timeout: timeoutMs,
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        return fail(new OverrideApiError(`${url}: status ${response.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) return request.destroy(new OverrideApiError(`${url}: odpowiedź większa niż ${MAX_BODY} bajtów`));
        chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => {
        let body;
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        } catch {
          return fail(new OverrideApiError(`${url}: odpowiedź nie jest JSON`));
        }
        if (body === null || typeof body !== 'object' || Array.isArray(body)) return fail(new OverrideApiError(`${url}: oczekiwano obiektu JSON`));
        resolve(body);
      });
    });
    request.on('timeout', () => request.destroy(new OverrideApiError(`${url}: przekroczono czas ${timeoutMs} ms`)));
    request.on('error', fail);
    request.end();
  });
}

/** Powód nieuznania zgłoszenia albo null, gdy odpowiedź API spełnia wszystkie warunki. */
function issueDenial(issue, number) {
  if (issue.number !== number) return 'odpowiedź API dotyczy innego numeru';
  if (Object.prototype.hasOwnProperty.call(issue, 'pull_request')) return 'wskazano PR, a nie zgłoszenie';
  if (issue.state !== 'open') return 'zgłoszenie nie jest otwarte';
  const marked = Array.isArray(issue.labels) && issue.labels.some((label) => label?.name === AUDIT_OK);
  return marked ? null : `zgłoszenie bez etykiety ${AUDIT_OK}`;
}

/**
 * Sprawdza listę odstępstw poprawnych składniowo i niewygasłych. Zwraca { approved: Set ścieżek, notes }.
 * Błąd API przerywa wyjątkiem `OverrideApiError` (nic nie jest uznane).
 */
async function verifyOverrides(active, repo, endpoints, getJson) {
  if (!REPO_NAME.test(repo)) throw new OverrideApiError('GITHUB_REPOSITORY: oczekiwano postaci wlasciciel/repo');
  const approved = new Set();
  const notes = [];
  for (const override of active) {
    const match = ISSUE_REF.exec(override.issue);
    if (!match) throw new OverrideApiError(`odstępstwo ${override.path}: zła postać zgłoszenia`);
    if (match[1].toLowerCase() !== repo.toLowerCase()) {
      notes.push(`odstępstwo ${override.path}: nieuznane: zgłoszenie ${override.issue} jest w innym repozytorium niż ${repo}`);
      continue;
    }
    const number = Number(match[2]);
    const issue = await getJson(`${endpoints.api}/repos/${repo}/issues/${number}`);
    const denial = issueDenial(issue, number);
    if (denial === null) {
      approved.add(override.path);
      notes.push(`odstępstwo ${override.path}: uznane do ${override.until} (zgłoszenie ${override.issue} otwarte, ${AUDIT_OK})`);
    } else {
      notes.push(`odstępstwo ${override.path}: nieuznane: ${denial} (${override.issue})`);
    }
  }
  return { approved, notes };
}

module.exports = { OverrideApiError, makeApiGet, issueDenial, verifyOverrides, MAX_BODY };
