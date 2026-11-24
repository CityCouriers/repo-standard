'use strict';
// Kontrola rozjazdu wzorca (`standard-drift`). Kod z domyślnej gałęzi; HEAD PR jest wyłącznie DANYMI: pliki wzorca
// i plik parametrów są czytane przez REST (`contents`) do katalogu tymczasowego pod ścieżkami z zaufanego manifestu,
// nic z PR nie jest wykonywane, a nazwy plików PR służą tylko do porównania napisów.
//
//   node drift_run.js pr     (pull_request_target: jawny commit status `standard-drift` na HEAD PR)
//   node drift_run.js push   (push na domyślną gałąź: reconciler statusów otwartych PR + kontrola gałęzi)
//   node drift_run.js check  (harmonogram, ręcznie: kontrola gałęzi, kod 1 przy rozjeździe)
//   node drift_run.js issue  (harmonogram: jedno zgłoszenie „Rozjazd wzorca")
//
// Kody wyjścia: 0 zgodne, 1 rozjazd, 2 błąd działania (nigdy „brak rozjazdu"). Zmienne: GITHUB_REPOSITORY,
// GITHUB_TOKEN i GH_TOKEN (ten sam token), PR_NUMBER (tylko `pr`), GITHUB_REF_NAME i GITHUB_SHA.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sync = require('../standard_sync');
const params = require('../common/params');
const core = require('./drift_core');
const { DriftError, makeApi } = require('./drift_api');
const status = require('./commit_status');

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const encodePath = (rel) => rel.split('/').map(encodeURIComponent).join('/');

/** Plik z HEAD jako dane: Buffer albo null (brak, katalog, dowiązanie, moduł); zbyt duży albo niespójny to błąd. */
function readHeadFile(api, repo, sha, rel) {
  let entry;
  try {
    entry = api.get(`repos/${repo}/contents/${encodePath(rel)}?ref=${sha}`);
  } catch (error) {
    if (error instanceof DriftError && error.notFound) return null;
    throw error;
  }
  if (entry?.type !== 'file') return null;
  if (entry.encoding !== 'base64' || typeof entry.content !== 'string') throw new DriftError(`${rel}: API nie zwróciło treści pliku (zbyt duży?)`);
  const data = Buffer.from(entry.content, 'base64');
  if (data.length !== entry.size) throw new DriftError(`${rel}: rozmiar treści nie zgadza się z odpowiedzią API`);
  return data;
}

/** Zapisuje pliki z HEAD do nowego katalogu tymczasowego pod ścieżkami z manifestu; zwraca ścieżkę katalogu. */
function materialize(api, repo, sha, relPaths) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'standard-drift-'));
  try {
    for (const rel of relPaths) {
      const segments = rel.split('/');
      if (path.isAbsolute(rel) || segments.some((part) => part === '' || part === '.' || part === '..')) throw new DriftError(`niedozwolona ścieżka pliku wzorca: ${core.sanitize(rel)}`);
      const data = readHeadFile(api, repo, sha, rel);
      if (data === null) continue;
      const target = path.join(root, ...segments);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, data);
    }
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

function report(title, lines, env) {
  const clean = lines.map((line) => core.sanitize(line, 400));
  console.log(`## ${core.sanitize(title)}`);
  for (const line of clean) console.log(`- ${line}`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `## ${core.sanitize(title)}\n\n${clean.map((line) => `- ${line}\n`).join('')}\n`);
    } catch (error) {
      console.error(`nie zapisano podsumowania: ${core.sanitize(error.message)}`);
    }
  }
}

function context(env, deps) {
  const repo = env.GITHUB_REPOSITORY;
  if (!REPO.test(repo)) throw new DriftError('GITHUB_REPOSITORY: oczekiwano postaci wlasciciel/repo');
  if (!env.GITHUB_TOKEN) throw new DriftError('brak GITHUB_TOKEN');
  const baseSha = status.validSha(env.GITHUB_SHA, 'GITHUB_SHA');
  return {
    repo,
    baseTag: short(baseSha),
    env,
    api: deps.api || makeApi(),
    workspace: deps.workspace || process.cwd(),
    syncDeps: {
      fetch: deps.fetch || sync.makeHttpGet(),
      endpoints: deps.endpoints || sync.DEFAULT_ENDPOINTS,
      todayMs: sync.todayUtcMs(deps.now || new Date()),
      apiGet: deps.apiGet,
    },
  };
}

/** Parametry konsumenta z drzewa roboczego (domyślna gałąź): zaufane. */
function workspaceParams(ctx) {
  const data = sync.readPlainFile(ctx.workspace, params.PARAMS_PATH);
  if (data === null) throw new DriftError(`brak ${params.PARAMS_PATH} na domyślnej gałęzi`);
  return sync.loadConsumerParams(data);
}

const short = (sha) => String(sha).slice(0, 7);


// ---------------------------------------------------------------- kontrola PR

/** Wynik kontroli PR: { state, description, lines, code }. Błąd działania to wyjątek niezłapany tutaj. */
async function evaluatePr(ctx, number, headSha) {
  const base = workspaceParams(ctx);
  const baseManifest = await sync.fetchManifest(ctx.syncDeps.endpoints, sync.STANDARD_REPO, base.standard.sha, ctx.syncDeps.fetch);
  const baseTag = ctx.baseTag;
  const files = ctx.api.getAll(`repos/${ctx.repo}/pulls/${number}/files?per_page=100`);
  if (!core.touchesStandard(files, baseManifest.files.map((entry) => entry.path))) {
    return { state: 'success', description: `PR nie dotyka plików wzorca (baza ${baseTag})`, lines: ['PR nie dotyka plików wzorca ani .github/: wczesne wyjście'], code: 0 };
  }
  const headData = readHeadFile(ctx.api, ctx.repo, headSha, params.PARAMS_PATH);
  if (headData === null) {
    return { state: 'failure', description: `brak ${params.PARAMS_PATH} w HEAD PR`, lines: [`${params.PARAMS_PATH}: brak pliku w HEAD PR`], code: 1 };
  }
  let headParams;
  try {
    headParams = sync.loadConsumerParams(headData);
  } catch (error) {
    return { state: 'failure', description: 'plik parametrów w HEAD PR niepoprawny', lines: [error.message], code: 1 };
  }
  const choice = await core.choosePin(base.standard, headParams.standard, (version) => sync.resolveTag(ctx.syncDeps.endpoints, sync.STANDARD_REPO, version, ctx.syncDeps.fetch));
  const manifest = await sync.fetchManifest(ctx.syncDeps.endpoints, sync.STANDARD_REPO, choice.pin.sha, ctx.syncDeps.fetch);
  const root = materialize(ctx.api, ctx.repo, headSha, [...new Set([params.PARAMS_PATH, ...manifest.files.map((entry) => entry.path)])]);
  let result;
  try {
    result = await sync.evaluateConsumer(root, headParams, choice.pin, { verify: true, env: ctx.env }, ctx.syncDeps);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const findings = [...choice.findings, ...result.findings];
  const lines = [...findings, ...choice.notes, ...result.notes];
  if (findings.length === 0) return { state: 'success', description: `zgodne z wzorcem ${choice.pin.version} (baza ${baseTag})`, lines, code: 0 };
  return { state: 'failure', description: `rozjazd wzorca ${choice.pin.version}: ${findings.length} (${findings[0]})`, lines, code: 1 };
}

/** Czy czubek domyślnej gałęzi nadal jest commitem, dla którego biegnie ten przebieg (GITHUB_SHA). */
function baseIsCurrent(ctx) {
  const info = ctx.api.get(`repos/${ctx.repo}`);
  const tip = ctx.api.get(`repos/${ctx.repo}/git/ref/heads/${encodeURIComponent(info.default_branch)}`);
  return tip.object.sha === ctx.env.GITHUB_SHA;
}

/** Jeden PR: wspólny mechanizm statusu (pending, kontrola, ponowny odczyt HEAD, zapis) i raport przebiegu. */
async function processPr(ctx, number, announce) {
  const head = status.readPrHead(ctx.api, ctx.repo, number);
  const { result, written, current, stale } = await status.guardedResult(ctx.api, ctx.repo, number, head, core.CONTEXT,
    () => evaluatePr(ctx, number, head),
    { announce: announce ? `kontrola w toku (baza ${ctx.baseTag})` : null, isCurrent: () => baseIsCurrent(ctx) });
  if (stale) {
    report(`standard-drift PR ${number}`, [`baza przesunęła się w trakcie biegu (${ctx.baseTag}): wynik nie zapisany, status zostaje pending do przeliczenia po zmianie bazy`], ctx.env);
  } else if (!written) {
    report(`standard-drift PR ${number}`, [`HEAD zmienił się w trakcie biegu (${short(head)} na ${short(current)}): wynik nie zapisany`], ctx.env);
  } else {
    report(`standard-drift PR ${number} (${short(head)}): ${result.state}`, result.lines, ctx.env);
  }
  return result.code;
}

async function runPr(ctx) {
  const number = Number(ctx.env.PR_NUMBER);
  if (!Number.isSafeInteger(number) || number < 1 || String(number) !== ctx.env.PR_NUMBER) throw new DriftError('PR_NUMBER: oczekiwano numeru PR');
  const info = ctx.api.get(`repos/${ctx.repo}`);
  const pr = ctx.api.get(`repos/${ctx.repo}/pulls/${number}`);
  if (pr.base.ref !== info.default_branch) {
    report(`standard-drift PR ${number}`, [`PR do gałęzi ${pr.base.ref}, nie do domyślnej (${info.default_branch}): poza zakresem`], ctx.env);
    return 0;
  }
  return processPr(ctx, number, true);
}

// ---------------------------------------------------------------- kontrola gałęzi

/** Kontrola drzewa roboczego: { findings, notes, version } (zaufane: domyślna gałąź). */
async function evaluateTree(ctx) {
  const own = workspaceParams(ctx);
  const result = await sync.evaluateConsumer(ctx.workspace, own, own.standard, { verify: true, env: ctx.env }, ctx.syncDeps);
  return { findings: result.findings, notes: result.notes, version: own.standard.version, strict: own.drift.strict };
}

async function runCheck(ctx) {
  const tree = await evaluateTree(ctx);
  report(`standard-drift (${tree.version}): ${tree.findings.length ? 'rozjazd' : 'zgodne'}`, [...tree.findings, ...tree.notes, ...(tree.findings.length ? [] : ['pliki zgodne z manifestem'])], ctx.env);
  return tree.findings.length ? 1 : 0;
}

/**
 * Reconciler po zmianie domyślnej gałęzi: (1) `pending` na HEAD każdego otwartego PR (pierwszy krok, przed jakimkolwiek
 * przeliczeniem), (2) przeliczenie dla pary (HEAD, nowa baza) do MAX_RECALC PR; reszta zostaje `pending`. Z
 * `drift.strict` = true robi to GitHub (PR musi być aktualny), więc reconciler nic nie zmienia. Na końcu kontrola gałęzi.
 */
async function runPush(ctx) {
  const info = ctx.api.get(`repos/${ctx.repo}`);
  if (ctx.env.GITHUB_REF_NAME !== info.default_branch) {
    report('standard-drift push', [`gałąź ${ctx.env.GITHUB_REF_NAME} nie jest domyślną (${info.default_branch}): poza zakresem`], ctx.env);
    return 0;
  }
  const own = workspaceParams(ctx);
  const baseTag = ctx.baseTag;
  let code = 0;
  const lines = [];
  if (own.drift.strict) {
    lines.push('drift.strict=true: aktualność PR wymusza ruleset, reconciler nie przelicza statusów');
  } else {
    const outcome = await status.reconcileOpenPrs(ctx.api, ctx.repo, info.default_branch, core.CONTEXT,
      `przeliczanie po zmianie bazy ${baseTag}`, (number) => processPr(ctx, number, false));
    lines.push(...outcome.lines);
    code = outcome.code;
    if (outcome.skipped > 0) lines.push(`limit przeliczania ${core.MAX_RECALC}: ${outcome.skipped} PR zostaje pending (uruchom ponownie)`);
    lines.push(`otwartych PR: ${outcome.open}, przeliczono: ${outcome.recomputed}`);
  }
  report(`standard-drift push (${baseTag})`, lines, ctx.env);
  const tree = await runCheck(ctx);
  return Math.max(code, tree);
}

// ---------------------------------------------------------------- zgłoszenie rozjazdu

async function runIssue(ctx) {
  const tree = await evaluateTree(ctx);
  const open = core.ownIssues(ctx.api.getAll(`repos/${ctx.repo}/issues?state=open&labels=${core.LABELS.map(encodeURIComponent).join(',')}&per_page=100`));
  const plan = core.planIssue(open, tree.findings.length ? { repo: ctx.repo, version: tree.version, findings: tree.findings } : null);
  const lines = [];
  for (const op of plan.ops) {
    if (op.type === 'create') {
      const created = ctx.api.send('POST', `repos/${ctx.repo}/issues`, { title: op.title, body: op.body, labels: op.labels });
      lines.push(`założono zgłoszenie ${created.number}`);
    } else if (op.type === 'update') {
      ctx.api.send('PATCH', `repos/${ctx.repo}/issues/${op.number}`, { body: op.body });
      lines.push(`zaktualizowano zgłoszenie ${op.number}`);
    } else if (op.type === 'comment') {
      ctx.api.send('POST', `repos/${ctx.repo}/issues/${op.number}/comments`, { body: op.comment });
      lines.push(`dopisano komentarz w ${op.number}`);
    } else {
      ctx.api.send('POST', `repos/${ctx.repo}/issues/${op.number}/comments`, { body: op.comment });
      ctx.api.send('PATCH', `repos/${ctx.repo}/issues/${op.number}`, { state: 'closed', state_reason: 'completed' });
      lines.push(`zamknięto zgłoszenie ${op.number}`);
    }
  }
  if (plan.anomaly) lines.push(`anomalia: otwartych zgłoszeń rozjazdu jest ${open.length}, prowadzone jest najstarsze (${open[0].number})`);
  if (lines.length === 0) lines.push('zgłoszenie bez zmian');
  report(`standard-drift zgłoszenie: ${tree.findings.length ? 'rozjazd' : 'zgodne'}`, lines, ctx.env);
  return plan.anomaly || tree.findings.length ? 1 : 0;
}

const COMMANDS = { pr: runPr, push: runPush, check: runCheck, issue: runIssue };

/** Punkt wejścia (też dla testów): `deps` = { api, fetch, endpoints, now, apiGet, workspace }. Zwraca kod wyjścia. */
async function main(argv, env = process.env, deps = {}) {
  try {
    if (argv.length !== 1 || !Object.prototype.hasOwnProperty.call(COMMANDS, argv[0])) throw new DriftError('użycie: drift_run.js pr | push | check | issue');
    return await COMMANDS[argv[0]](context(env, deps));
  } catch (error) {
    report('standard-drift: przerwano', [`${error.name}: ${error.message}`], env);
    return 2;
  }
}

module.exports = { readHeadFile, materialize, evaluatePr, processPr, main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; });
}
