// A workflow's `run: |` blocks, as bash would get them (tests/workflow_scripts_test.mjs checks every one
// parses; tests/shell_export_test.mjs checks the public repo's test.yml and the forks' release template too).
const indentOf = l => l.length - l.trimStart().length;

/** Each `run: |` block: its workflow, line, script (dedented, `${{ … }}` stood in for) and whether bash runs it. */
export function runBlocks(file, text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(?:- )?run: \|[-+]?\s*$/.exec(lines[i]);
    if (!m) continue;
    const keyIndent = indentOf(lines[i]) + (lines[i].trimStart().startsWith('- ') ? 2 : 0);
    const body = [];
    let j = i + 1;
    for (; j < lines.length; j++) {
      if (lines[j].trim() === '') { body.push(''); continue; }
      if (indentOf(lines[j]) <= keyIndent) break;
      body.push(lines[j]);
    }
    const ind = Math.min(...body.filter(Boolean).map(indentOf));
    const script = body.map(l => l.slice(ind)).join('\n').replace(/\$\{\{[\s\S]*?\}\}/g, 'X');
    // The step's own keys (from its "- " line to the end of the block) and the job's runs-on decide the shell.
    let s = i; while (s > 0 && !(indentOf(lines[s]) === keyIndent - 2 && lines[s].trimStart().startsWith('- '))) s--;
    const step = lines.slice(s, j).join('\n');
    let r = s; while (r > 0 && !/^\s{4}runs-on:/.test(lines[r])) r--;
    const runsOn = lines[r] || '';
    const shell = /\n\s*shell: (\w+)/.exec(step)?.[1] ?? (/windows/.test(runsOn) && !/matrix/.test(runsOn) ? 'pwsh' : 'bash');
    out.push({ file, line: i + 1, script, shell });
  }
  return out;
}
