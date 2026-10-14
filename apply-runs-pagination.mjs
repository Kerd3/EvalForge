import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const appPath = path.join(root, 'public', 'app.js');
const cssPath = path.join(root, 'public', 'styles.css');

function fail(message) {
  console.error(`\nPagination patch not applied: ${message}`);
  process.exit(1);
}

for (const file of [appPath, cssPath]) {
  if (!fs.existsSync(file)) fail(`Expected file not found: ${path.relative(root, file)}. Run this script from the EvalForge project root.`);
}

let app = fs.readFileSync(appPath, 'utf8');
let css = fs.readFileSync(cssPath, 'utf8');
const originalApp = app;
const originalCss = css;

if (app.includes('function renderRunsPagination(') && app.includes('runsPageSize')) {
  console.log('Run pagination already appears to be installed. No files changed.');
  process.exit(0);
}

// Add client-side page state without replacing any existing dashboard state.
if (!app.includes('runsPageSize')) {
  const stateStart = app.indexOf('const state = {');
  const stateEnd = stateStart >= 0 ? app.indexOf('\n};', stateStart) : -1;
  if (stateStart < 0 || stateEnd < 0) fail('Could not locate the dashboard state object.');
  const stateBlock = app.slice(stateStart, stateEnd);
  if (!/\bruns\s*:\s*\[\]\s*,/.test(stateBlock)) fail('Could not find the runs array in the dashboard state.');
  app = app.slice(0, stateStart) + stateBlock.replace(/(\bruns\s*:\s*\[\]\s*,)/, '$1\n  runsPage: 1,\n  runsPageSize: 10,') + app.slice(stateEnd);
}

// Existing endpoint returns up to 100 newest runs; 38 current runs fit in the pageable list.
app = app.replace("api('/api/evaluations?limit=50')", "api('/api/evaluations?limit=100')");

const renderStart = app.indexOf('function renderRuns() {');
const renderEnd = renderStart >= 0 ? app.indexOf('\nfunction renderDatasets()', renderStart) : -1;
if (renderStart < 0 || renderEnd < 0) fail('Could not locate the renderRuns() function.');
let renderBlock = app.slice(renderStart, renderEnd);

const countLineRegex = /^\s*\$\('#runs-count'\)\.textContent\s*=\s*`Showing \$\{state\.runs\.length\} run\$\{state\.runs\.length === 1 \? '' : 's'\}`;\s*$/m;
if (!countLineRegex.test(renderBlock)) fail('Could not find the expected runs-count line in renderRuns(). No changes were written.');
renderBlock = renderBlock.replace(countLineRegex, `  const pageSize = Number(state.runsPageSize) || 10;
  const totalRunCount = state.runs.length;
  const totalRunPages = Math.max(1, Math.ceil(totalRunCount / pageSize));
  state.runsPage = Math.min(Math.max(1, Number(state.runsPage) || 1), totalRunPages);
  const runPageStart = totalRunCount ? (state.runsPage - 1) * pageSize : 0;
  const visibleRuns = state.runs.slice(runPageStart, runPageStart + pageSize);
  const firstVisibleRun = totalRunCount ? runPageStart + 1 : 0;
  const lastVisibleRun = Math.min(runPageStart + pageSize, totalRunCount);
  $('#runs-count').textContent = totalRunCount
    ? \`Showing \${firstVisibleRun}–\${lastVisibleRun} of \${totalRunCount} runs\`
    : 'Showing 0 runs';`);

if (!renderBlock.includes('tbody.innerHTML = state.runs.map((run) => {')) fail('Could not find the run-row rendering expression. No changes were written.');
renderBlock = renderBlock.replace('tbody.innerHTML = state.runs.map((run) => {', 'tbody.innerHTML = visibleRuns.map((run) => {');

const compareBarCall = '  renderCompareBar();';
if (!renderBlock.includes(compareBarCall)) fail('Could not find the end of renderRuns(). No changes were written.');
renderBlock = renderBlock.replace(compareBarCall, `${compareBarCall}\n  renderRunsPagination(totalRunCount, totalRunPages);`);

const paginationFunction = `function renderRunsPagination(totalRuns, totalPages) {
  const footer = $('.table-footer');
  if (!footer) return;

  let container = $('#runs-pagination');
  if (!container) {
    container = document.createElement('nav');
    container.id = 'runs-pagination';
    container.className = 'runs-pagination';
    container.setAttribute('aria-label', 'Recent evaluation run pages');
    footer.insertAdjacentElement('afterend', container);
  }

  if (totalRuns === 0 || totalPages <= 1) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }

  container.hidden = false;
  const currentPage = Number(state.runsPage) || 1;
  const pageButtons = Array.from({ length: totalPages }, (_, index) => {
    const page = index + 1;
    const current = page === currentPage;
    return \
      \`<button type="button" class="run-page-button\${current ? ' active' : ''}" data-run-page="\${page}" aria-label="Go to page \${page}" \${current ? 'aria-current="page"' : ''}>\${page}</button>\`;
  }).join('');

  container.innerHTML = \
    \`<div class="runs-pagination-controls">
      <button type="button" class="run-page-button run-page-step" data-run-page="\${currentPage - 1}" \${currentPage <= 1 ? 'disabled' : ''}>← Previous</button>
      <div class="run-page-numbers">\${pageButtons}</div>
      <button type="button" class="run-page-button run-page-step" data-run-page="\${currentPage + 1}" \${currentPage >= totalPages ? 'disabled' : ''}>Next →</button>
    </div>\`;

  container.querySelectorAll('button[data-run-page]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextPage = Number(button.dataset.runPage);
      if (!Number.isInteger(nextPage) || nextPage < 1 || nextPage > totalPages || nextPage === currentPage) return;
      state.runsPage = nextPage;
      renderRuns();
    });
  });
}

`;
app = app.slice(0, renderStart) + paginationFunction + renderBlock + app.slice(renderEnd);

// When new evaluations arrive, return to page 1 so the newest run is immediately visible.
const latestRunsAnchor = `    state.datasets = datasets;\n    state.runs = runs;`;
if (app.includes(latestRunsAnchor) && !app.includes('previousLatestRunId')) {
  app = app.replace(latestRunsAnchor, `    const previousLatestRunId = state.runs[0]?.id ?? null;\n    state.datasets = datasets;\n    state.runs = runs;\n    if (runs[0]?.id && runs[0].id !== previousLatestRunId) state.runsPage = 1;`);
}

const paginationCss = `

/* Recent-runs pagination */
.runs-pagination{display:flex;justify-content:flex-end;align-items:center;padding:12px 0 2px;}
.runs-pagination[hidden]{display:none!important}
.runs-pagination-controls{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-wrap:wrap}
.run-page-numbers{display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.run-page-button{display:inline-flex;align-items:center;justify-content:center;min-width:34px;min-height:32px;padding:6px 10px;border:1px solid var(--line);border-radius:8px;background:var(--surface);color:var(--muted);font-size:11px;font-weight:700;transition:background .15s,border-color .15s,color .15s}
.run-page-button:hover:not(:disabled){border-color:var(--purple);color:var(--text);background:var(--surface-2)}
.run-page-button.active{border-color:rgba(158,139,255,.65);background:rgba(126,99,244,.18);color:#d9d3ff}
.run-page-button:disabled{opacity:.35;cursor:not-allowed}
@media(max-width:560px){.runs-pagination{justify-content:center}.runs-pagination-controls{gap:5px}.run-page-button{min-width:30px;padding:6px 8px}.run-page-step{font-size:10px}}
`;
if (!css.includes('/* Recent-runs pagination */')) css += paginationCss;

// Minimal safety checks before writing any files.
if (!app.includes('renderRunsPagination(totalRunCount, totalRunPages)') || !app.includes('tbody.innerHTML = visibleRuns.map((run) => {')) {
  fail('Pagination verification failed. No files were written.');
}

const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evalforge-runs-pagination-'));
fs.copyFileSync(appPath, path.join(backupRoot, 'app.js.before'));
fs.copyFileSync(cssPath, path.join(backupRoot, 'styles.css.before'));
fs.writeFileSync(appPath, app, 'utf8');
fs.writeFileSync(cssPath, css, 'utf8');

console.log('Recent-runs pagination installed successfully.');
console.log('Activity now displays 10 runs per page with numbered pages, Previous/Next controls, and a range counter.');
console.log(`Backup files saved outside the project at: ${backupRoot}`);
console.log('The existing API response shape and database schema are unchanged.');
console.log('Next: run node --check public/app.js, then npm test and npm run test:regression.');
