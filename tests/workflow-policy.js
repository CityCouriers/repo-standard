'use strict';
// Polityka workflow (AC-6): kontrola tekstowa bez zależności. Zwraca listę naruszeń dla treści pliku workflow.

const FULL_SHA_USES = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+@[0-9a-f]{40}$/;
const VERSION_COMMENT = /#\s*v?[0-9]+(\.[0-9]+)*/;
const HOSTED_RUNNERS = new Set(['ubuntu-24.04', 'ubuntu-22.04', 'windows-2022', 'windows-2025', 'macos-14', 'macos-15']);

function workflowFindings(text) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const topLevel = lines.filter((line) => /^permissions:/.test(line));
  if (topLevel.length !== 1) findings.push('brak jednego bloku permissions na poziomie workflow');
  else if (!/^permissions:\s*\{\}\s*(#.*)?$/.test(topLevel[0])) findings.push(`permissions na poziomie workflow musi być {}: "${topLevel[0].trim()}"`);

  lines.forEach((line, index) => {
    const where = `wiersz ${index + 1}`;
    const uses = /^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/.exec(line);
    if (uses) {
      const [, ref, rest] = uses;
      if (!ref.startsWith('./')) {
        if (!FULL_SHA_USES.test(ref)) findings.push(`${where}: akcja bez pełnego SHA: ${ref}`);
        else if (!VERSION_COMMENT.test(rest)) findings.push(`${where}: brak komentarza z wersją przy ${ref}`);
      }
    }
    const runsOn = /^\s*runs-on:\s*(.*?)\s*$/.exec(line);
    if (runsOn) {
      const value = runsOn[1].replace(/\s+#.*$/, '');
      if (!HOSTED_RUNNERS.has(value)) findings.push(`${where}: runs-on nie jest literalną etykietą GitHub-hosted: ${value}`);
    }
  });
  return findings;
}

module.exports = { workflowFindings };
