import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const bundledRoot = path.dirname(fileURLToPath(import.meta.url));
const backupRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'evalforge-v11-auth-'));
const requiredFiles = [
  'src/app.js', 'src/server.js', 'src/repositories/datasets.repository.js',
  'src/repositories/evaluations.repository.js', 'src/services/dataset.service.js',
  'src/services/evaluation.service.js', 'src/services/evaluation-campaign.service.js',
  'src/routes/datasets.routes.js', 'src/routes/evaluations.routes.js',
  'src/routes/evaluation-campaigns.routes.js', 'public/app.js', 'public/index.html',
  'public/styles.css', 'tests/integration/api.test.js', 'docker-compose.yml', 'README.md', 'scripts/seed.js'
];

function fail(message) {
  console.error(`\nPatch was not applied: ${message}`);
  process.exit(1);
}
function read(relative) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full)) fail(`Required file is missing: ${relative}`);
  return fs.readFileSync(full, 'utf8');
}
function replaceOnce(content, before, after, label) {
  const count = content.split(before).length - 1;
  if (count !== 1) fail(`${label}: expected one anchor, found ${count}. No project files have been written.`);
  return content.replace(before, after);
}
function replaceInBlock(content, startAnchor, endAnchor, transform, label) {
  const start = content.indexOf(startAnchor);
  const end = start >= 0 ? content.indexOf(endAnchor, start + startAnchor.length) : -1;
  if (start < 0 || end < 0) fail(`${label}: could not locate source block. No project files have been written.`);
  return content.slice(0, start) + transform(content.slice(start, end)) + content.slice(end);
}

// Validate all expected source paths and create a complete in-memory change set first.
const changes = new Map();
for (const file of requiredFiles) changes.set(file, read(file));
const newFiles = [
  'src/security/passwords.js', 'src/middleware/authentication.js', 'src/services/auth.service.js',
  'src/routes/auth.routes.js', 'database/migrations/004_auth_and_resource_ownership.sql',
  'tests/unit/passwords.test.js', 'tests/unit/ownership.repository.test.js', 'tests/unit/auth.service.test.js', 'tests/integration/auth.test.js',
  'docs/V1.1-IMPLEMENTATION-ROADMAP.md'
];
for (const file of newFiles) {
  const sourcePath = path.join(bundledRoot, file);
  if (!fs.existsSync(sourcePath)) fail(`Patch bundle is incomplete: ${file}`);
  const bundledContent = fs.readFileSync(sourcePath, 'utf8');
  const targetPath = path.join(root, file);
  if (fs.existsSync(targetPath)) {
    const existingContent = fs.readFileSync(targetPath, 'utf8');
    if (existingContent !== bundledContent) {
      fail(`Refusing to overwrite existing non-identical file: ${file}. Review it manually; no project files have been written.`);
    }
  }
  // Permit a safe retry when the bundle's new files were already copied into the
  // repository before the installer was run. Non-identical files still stop preflight.
  changes.set(file, bundledContent);
}

const envExamplePath = path.join(root, '.env.example');
if (fs.existsSync(envExamplePath)) {
  let envContent = fs.readFileSync(envExamplePath, 'utf8');
  const missingAuthEnv = [];
  if (!envContent.includes('EVALFORGE_REGISTRATION_ENABLED=')) missingAuthEnv.push('EVALFORGE_REGISTRATION_ENABLED=true');
  if (!envContent.includes('AUTH_COOKIE_SECURE=')) missingAuthEnv.push('AUTH_COOKIE_SECURE=false');
  if (!envContent.includes('EVALFORGE_BOOTSTRAP_SECRET=')) missingAuthEnv.push('EVALFORGE_BOOTSTRAP_SECRET=');
  if (missingAuthEnv.length) envContent += `\n\n# EvalForge account configuration\n${missingAuthEnv.join('\n')}\n`;
  changes.set('.env.example', envContent);
} else {
  changes.set('.env.example', fs.readFileSync(path.join(bundledRoot, '.env.example'), 'utf8'));
}

// 1) Dataset repository ownership filters.
{
  let c = changes.get('src/repositories/datasets.repository.js');
  c = replaceOnce(c, 'export async function createDataset(data) {', 'export async function createDataset(data, ownerId) {', 'Dataset create signature');
  c = replaceOnce(c,
    "'INSERT INTO datasets(id, name, description) VALUES ($1, $2, $3)',\n      [datasetId, data.name, data.description ?? '']",
    "'INSERT INTO datasets(id, name, description, owner_id) VALUES ($1, $2, $3, $4)',\n      [datasetId, data.name, data.description ?? '', ownerId]",
    'Dataset insert ownership');
  c = replaceInBlock(c, 'export async function createDataset(data, ownerId) {', '\n/**\n * Save edits', (block) => replaceOnce(block, 'return getDatasetById(datasetId);', 'return getDatasetById(datasetId, ownerId);', 'Dataset create return ownership'), 'Dataset create block');
  c = replaceOnce(c, 'export async function createDatasetVersion(datasetId, data) {', 'export async function createDatasetVersion(datasetId, data, ownerId) {', 'Dataset version signature');
  c = replaceOnce(c, "'SELECT id FROM datasets WHERE id = $1 FOR UPDATE', [datasetId]", "'SELECT id FROM datasets WHERE id = $1 AND owner_id = $2 FOR UPDATE', [datasetId, ownerId]", 'Dataset edit ownership');
  c = replaceInBlock(c, 'export async function createDatasetVersion(datasetId, data, ownerId) {', '\nexport async function listDatasets', (block) => replaceOnce(block, 'return getDatasetById(datasetId);', 'return getDatasetById(datasetId, ownerId);', 'Dataset version return ownership'), 'Dataset version block');
  c = replaceOnce(c, 'export async function listDatasets() {', 'export async function listDatasets(ownerId) {', 'Dataset list signature');
  c = replaceOnce(c,
    '     LEFT JOIN test_cases tc ON tc.dataset_version_id = v.id\n     GROUP BY d.id, v.id, v.version_number\n     ORDER BY d.updated_at DESC, d.created_at DESC`\n  );',
    '     LEFT JOIN test_cases tc ON tc.dataset_version_id = v.id\n     WHERE d.owner_id = $1\n     GROUP BY d.id, v.id, v.version_number\n     ORDER BY d.updated_at DESC, d.created_at DESC`, [ownerId]\n  );',
    'Dataset list owner predicate');
  c = replaceOnce(c, 'export async function getDatasetById(datasetId) {', 'export async function getDatasetById(datasetId, ownerId) {', 'Dataset get signature');
  c = replaceOnce(c, '     WHERE d.id = $1`, [datasetId]', '     WHERE d.id = $1 AND d.owner_id = $2`, [datasetId, ownerId]', 'Dataset get owner predicate');
  changes.set('src/repositories/datasets.repository.js', c);
}

// 2) Evaluation/campaign repository ownership and safe lookups.
{
  let c = changes.get('src/repositories/evaluations.repository.js');
  c = replaceOnce(c,
    'export async function createEvaluationRun({ datasetId, datasetVersionId, provider, model, systemPrompt }) {',
    'export async function createEvaluationRun({ datasetId, datasetVersionId, provider, model, systemPrompt, ownerId }) {',
    'Evaluation create signature');
  c = c.replaceAll(
    "'SELECT id FROM dataset_versions WHERE dataset_id = $1 ORDER BY version_number DESC LIMIT 1', [datasetId]",
    "'SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.dataset_id = $1 AND d.owner_id = $2 ORDER BY v.version_number DESC LIMIT 1', [datasetId, ownerId]"
  );
  c = c.replaceAll(
    "'SELECT id FROM dataset_versions WHERE id = $1', [versionId]",
    "'SELECT v.id FROM dataset_versions v JOIN datasets d ON d.id = v.dataset_id WHERE v.id = $1 AND d.owner_id = $2', [versionId, ownerId]"
  );
  c = replaceOnce(c,
    "(id, dataset_version_id, provider, model, system_prompt, status, total_cases)\n       VALUES ($1,$2,$3,$4,$5,'queued',$6)",
    "(id, dataset_version_id, provider, model, system_prompt, status, total_cases, owner_id)\n       VALUES ($1,$2,$3,$4,$5,'queued',$6,$7)",
    'Evaluation insert owner columns');
  c = replaceOnce(c,
    '[runId, versionId, provider, model, systemPrompt, casesResult.rowCount]',
    '[runId, versionId, provider, model, systemPrompt, casesResult.rowCount, ownerId]',
    'Evaluation insert owner value');
  // Campaign creation is a separate function and uses the same owner-scoped dataset version checks.
  c = replaceOnce(c,
    'export async function createEvaluationCampaign({ datasetId, datasetVersionId, provider, model, systemPrompt, repeatCount }) {',
    'export async function createEvaluationCampaign({ datasetId, datasetVersionId, provider, model, systemPrompt, repeatCount, ownerId }) {',
    'Campaign create signature');
  c = replaceOnce(c,
    "(id, dataset_version_id, provider, model, system_prompt, repeat_count, status)\n       VALUES ($1,$2,$3,$4,$5,$6,'queued')`,\n      [campaignId, versionId, provider, model, systemPrompt, repeatCount]",
    "(id, dataset_version_id, provider, model, system_prompt, repeat_count, status, owner_id)\n       VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,\n      [campaignId, versionId, provider, model, systemPrompt, repeatCount, ownerId]",
    'Campaign insert owner');
  c = replaceOnce(c,
    "(id, dataset_version_id, provider, model, system_prompt, status, total_cases, campaign_id, repetition_index)\n         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8)`,\n        [runId, versionId, provider, model, systemPrompt, casesResult.rowCount, campaignId, repetitionIndex]",
    "(id, dataset_version_id, provider, model, system_prompt, status, total_cases, campaign_id, repetition_index, owner_id)\n         VALUES ($1,$2,$3,$4,$5,'queued',$6,$7,$8,$9)`,\n        [runId, versionId, provider, model, systemPrompt, casesResult.rowCount, campaignId, repetitionIndex, ownerId]",
    'Campaign child run owner');
  c = replaceOnce(c, 'return getEvaluationCampaignById(campaignId);', 'return getEvaluationCampaignById(campaignId, ownerId);', 'Campaign creation scoped return');
  c = replaceOnce(c, 'export async function getEvaluationCampaignState(campaignId) {\n  const { rows } = await pool.query(\'SELECT * FROM evaluation_campaigns WHERE id = $1\', [campaignId]);',
    "export async function getEvaluationCampaignState(campaignId, ownerId = null) {\n  const { rows } = await pool.query('SELECT * FROM evaluation_campaigns WHERE id = $1 AND ($2::uuid IS NULL OR owner_id = $2)', [campaignId, ownerId]);",
    'Campaign state ownership');
  c = replaceInBlock(c, 'export async function cancelEvaluationCampaign(campaignId) {', '\nexport async function getEvaluationCampaignById', (block) => {
    block = block.replace('export async function cancelEvaluationCampaign(campaignId) {', 'export async function cancelEvaluationCampaign(campaignId, ownerId = null) {');
    block = replaceOnce(block,
      "    await client.query(\n      `UPDATE evaluation_campaigns SET status='cancelled', completed_at=NOW()\n       WHERE id=$1 AND status IN ('queued','running')`, [campaignId]\n    );",
      "    const ownedCampaign = await client.query(\n      `UPDATE evaluation_campaigns SET status='cancelled', completed_at=NOW()\n       WHERE id=$1 AND ($2::uuid IS NULL OR owner_id=$2) AND status IN ('queued','running') RETURNING id`, [campaignId, ownerId]\n    );\n    if (!ownedCampaign.rowCount) { await client.query('COMMIT'); return false; }",
      'Campaign cancel owner');
    return block;
  }, 'Campaign cancellation block');
  c = replaceOnce(c,
    'export async function getEvaluationCampaignById(campaignId) {',
    'export async function getEvaluationCampaignById(campaignId, ownerId = null) {',
    'Campaign get signature');
  c = replaceOnce(c,
    '     WHERE c.id = $1`, [campaignId]',
    '     WHERE c.id = $1 AND ($2::uuid IS NULL OR c.owner_id = $2)`, [campaignId, ownerId]',
    'Campaign get owner predicate');
  c = replaceOnce(c, 'export async function listEvaluations(limit = 50) {', 'export async function listEvaluations(limit = 50, ownerId = null) {', 'Evaluation list signature');
  c = replaceOnce(c,
    '     ) model_summary ON TRUE\n     ORDER BY r.created_at DESC LIMIT $1`, [limit]',
    '     ) model_summary ON TRUE\n     WHERE ($2::uuid IS NULL OR r.owner_id = $2)\n     ORDER BY r.created_at DESC LIMIT $1`, [limit, ownerId]',
    'Evaluation list owner predicate');
  c = replaceOnce(c, 'export async function getEvaluationById(runId) {', 'export async function getEvaluationById(runId, ownerId = null) {', 'Evaluation get signature');
  c = replaceOnce(c,
    '     WHERE r.id = $1`, [runId]',
    '     WHERE r.id = $1 AND ($2::uuid IS NULL OR r.owner_id = $2)`, [runId, ownerId]',
    'Evaluation get owner predicate');
  c = replaceOnce(c,
    'export async function getEvaluationWithResults(runId) {\n  const run = await getEvaluationById(runId);',
    'export async function getEvaluationWithResults(runId, ownerId = null) {\n  const run = await getEvaluationById(runId, ownerId);',
    'Evaluation result view ownership');
  c = replaceOnce(c,
    'export async function cancelEvaluationCampaign(campaignId, ownerId = null) {',
    'export async function cancelEvaluationCampaign(campaignId, ownerId = null) {',
    'No-op marker to validate campaign cancel signature');
  // Keep run status mutation owner-scoped when called from the user-facing cancel endpoint.
  c = replaceOnce(c,
    'export async function updateRunStatus(runId, status, errorMessage = null) {',
    'export async function updateRunStatus(runId, status, errorMessage = null, ownerId = null) {',
    'Run status mutation signature');
  c = replaceOnce(c,
    "`UPDATE evaluation_runs SET status = $2, error_message = $3 ${times}\n     WHERE id = $1 AND (status = $2 OR (status IN ('queued','running') AND $2 IN ('running','completed','failed','cancelled')))`,\n    [runId, status, errorMessage]",
    "`UPDATE evaluation_runs SET status = $2, error_message = $3 ${times}\n     WHERE id = $1 AND ($4::uuid IS NULL OR owner_id = $4) AND (status = $2 OR (status IN ('queued','running') AND $2 IN ('running','completed','failed','cancelled')))`,\n    [runId, status, errorMessage, ownerId]",
    'Run status owner predicate');
  // Compare only runs visible to this account.
  c = replaceOnce(c,
    'export async function compareEvaluationRuns(baselineId, candidateId) {\n  const [baseline, candidate] = await Promise.all([\n    getEvaluationWithResults(baselineId), getEvaluationWithResults(candidateId)\n  ]);',
    'export async function compareEvaluationRuns(baselineId, candidateId, ownerId = null) {\n  const [baseline, candidate] = await Promise.all([\n    getEvaluationWithResults(baselineId, ownerId), getEvaluationWithResults(candidateId, ownerId)\n  ]);',
    'Run comparison ownership');
  changes.set('src/repositories/evaluations.repository.js', c);
}

// 3) Propagate user IDs from routes through services into repositories.
{
  let c = changes.get('src/services/dataset.service.js');
  c = replaceOnce(c, '  create(data) {\n    return createDataset(data);', '  create(data, ownerId) {\n    return createDataset(data, ownerId);', 'Dataset service create');
  c = replaceOnce(c, '  async createVersion(id, data) {\n    const dataset = await createDatasetVersion(id, data);', '  async createVersion(id, data, ownerId) {\n    const dataset = await createDatasetVersion(id, data, ownerId);', 'Dataset service version');
  c = replaceOnce(c, '  list() {\n    return listDatasets();', '  list(ownerId) {\n    return listDatasets(ownerId);', 'Dataset service list');
  c = replaceOnce(c, '  async getById(id) {\n    const dataset = await getDatasetById(id);', '  async getById(id, ownerId) {\n    const dataset = await getDatasetById(id, ownerId);', 'Dataset service get');
  changes.set('src/services/dataset.service.js', c);

  let e = changes.get('src/services/evaluation.service.js');
  e = replaceOnce(e, '    async create(data) {', '    async create(data, ownerId) {', 'Evaluation service create');
  e = replaceOnce(e, '        systemPrompt: data.system_prompt\n      });', '        systemPrompt: data.system_prompt,\n        ownerId\n      });', 'Evaluation create owner argument');
  e = replaceOnce(e, '      return getEvaluationById(run.id);', '      return getEvaluationById(run.id, ownerId);', 'Evaluation create scoped return');
  e = replaceOnce(e, '    async list(limit = 50) {\n      return listEvaluations(limit);', '    async list(limit = 50, ownerId) {\n      return listEvaluations(limit, ownerId);', 'Evaluation service list');
  e = replaceOnce(e, '    async getById(id) {\n      const run = await getEvaluationWithResults(id);', '    async getById(id, ownerId) {\n      const run = await getEvaluationWithResults(id, ownerId);', 'Evaluation service get');
  e = replaceOnce(e, '    async cancel(id) {\n      const run = await getEvaluationById(id);', '    async cancel(id, ownerId) {\n      const run = await getEvaluationById(id, ownerId);', 'Evaluation service cancel lookup');
  e = replaceInBlock(e, '    async cancel(id, ownerId) {', '\n    compare(baselineId, candidateId)', (block) => {
    block = replaceOnce(block, "      await updateRunStatus(id, 'cancelled');", "      const cancelled = await updateRunStatus(id, 'cancelled', null, ownerId);\n      if (!cancelled) throw new HttpError(409, 'Evaluation run changed state before cancellation. Refresh and try again.');", 'Evaluation service cancel mutation');
    block = replaceOnce(block, '      return getEvaluationById(id);', '      return getEvaluationById(id, ownerId);', 'Evaluation cancellation scoped response');
    return block;
  }, 'Evaluation cancellation block');
  e = replaceOnce(e, '    compare(baselineId, candidateId) {\n      return compareEvaluationRuns(baselineId, candidateId);', '    compare(baselineId, candidateId, ownerId) {\n      return compareEvaluationRuns(baselineId, candidateId, ownerId);', 'Evaluation compare ownership');
  changes.set('src/services/evaluation.service.js', e);

  let camp = changes.get('src/services/evaluation-campaign.service.js');
  camp = replaceOnce(camp, '    async create(data) {', '    async create(data, ownerId) {', 'Campaign service create');
  camp = replaceOnce(camp, '        repeatCount: data.repeat_count\n      });', '        repeatCount: data.repeat_count,\n        ownerId\n      });', 'Campaign service create owner');
  camp = replaceOnce(camp, '      return getEvaluationCampaignById(campaign.id);', '      return getEvaluationCampaignById(campaign.id, ownerId);', 'Campaign create scoped return');
  camp = replaceOnce(camp, '    async getById(id) {\n      const campaign = await getEvaluationCampaignById(id);', '    async getById(id, ownerId) {\n      const campaign = await getEvaluationCampaignById(id, ownerId);', 'Campaign service get');
  camp = replaceOnce(camp, '    async cancel(id) {\n      const campaign = await getEvaluationCampaignState(id);', '    async cancel(id, ownerId) {\n      const campaign = await getEvaluationCampaignState(id, ownerId);', 'Campaign service cancel lookup');
  camp = replaceOnce(camp, '      await cancelEvaluationCampaign(id);\n      return getEvaluationCampaignById(id);', '      const cancelled = await cancelEvaluationCampaign(id, ownerId);\n      if (!cancelled) throw new HttpError(404, \'Evaluation campaign not found\');\n      return getEvaluationCampaignById(id, ownerId);', 'Campaign service cancel owner');
  changes.set('src/services/evaluation-campaign.service.js', camp);

  let dr = changes.get('src/routes/datasets.routes.js');
  dr = replaceOnce(dr, 'datasetService.list()', 'datasetService.list(req.user.id)', 'Dataset route list owner');
  dr = replaceOnce(dr, 'datasetService.create(parsed.data)', 'datasetService.create(parsed.data, req.user.id)', 'Dataset route create owner');
  dr = replaceOnce(dr, 'datasetService.createVersion(req.params.id, parsed.data)', 'datasetService.createVersion(req.params.id, parsed.data, req.user.id)', 'Dataset route version owner');
  dr = replaceOnce(dr, 'datasetService.getById(req.params.id)', 'datasetService.getById(req.params.id, req.user.id)', 'Dataset route get owner');
  changes.set('src/routes/datasets.routes.js', dr);

  let er = changes.get('src/routes/evaluations.routes.js');
  er = replaceOnce(er, 'evaluationService.list(rawLimit)', 'evaluationService.list(rawLimit, req.user.id)', 'Evaluation route list owner');
  er = replaceOnce(er, 'evaluationService.create(parsed.data)', 'evaluationService.create(parsed.data, req.user.id)', 'Evaluation route create owner');
  er = replaceOnce(er, 'evaluationService.compare(parsed.data.baseline_run_id, parsed.data.candidate_run_id)', 'evaluationService.compare(parsed.data.baseline_run_id, parsed.data.candidate_run_id, req.user.id)', 'Evaluation route compare owner');
  er = replaceOnce(er, 'evaluationService.getById(req.params.id)', 'evaluationService.getById(req.params.id, req.user.id)', 'Evaluation route get owner');
  er = replaceOnce(er, 'evaluationService.cancel(req.params.id)', 'evaluationService.cancel(req.params.id, req.user.id)', 'Evaluation route cancel owner');
  changes.set('src/routes/evaluations.routes.js', er);

  let cr = changes.get('src/routes/evaluation-campaigns.routes.js');
  cr = replaceOnce(cr, 'campaignService.create(parsed.data)', 'campaignService.create(parsed.data, req.user.id)', 'Campaign route create owner');
  cr = replaceOnce(cr, 'campaignService.getById(req.params.id)', 'campaignService.getById(req.params.id, req.user.id)', 'Campaign route get owner');
  cr = replaceOnce(cr, 'campaignService.cancel(req.params.id)', 'campaignService.cancel(req.params.id, req.user.id)', 'Campaign route cancel owner');
  changes.set('src/routes/evaluation-campaigns.routes.js', cr);
}

// 4) Wire session authentication and CSRF origin check into the API.
{
  let c = changes.get('src/app.js');
  let dashboardJs = changes.get('public/app.js');
  dashboardJs = replaceOnce(dashboardJs,
    '  if (!response.ok) throw new Error(body?.error?.message ?? `Request failed (${response.status})`);',
    "  if (!response.ok) {\n    if (response.status === 401 && document.body.classList.contains('authenticated')) showSignedOut('Your session expired. Please sign in again.');\n    throw new Error(body?.error?.message ?? `Request failed (${response.status})`);\n  }",
    'Handle expired dashboard sessions');
  changes.set('public/app.js', dashboardJs);

  c = replaceOnce(c, "import { createEvaluationCampaignsRouter } from './routes/evaluation-campaigns.routes.js';", "import { createEvaluationCampaignsRouter } from './routes/evaluation-campaigns.routes.js';\nimport { createAuthRouter } from './routes/auth.routes.js';\nimport { createAuthenticationMiddleware, requireAuthentication, sameOriginMutationGuard } from './middleware/authentication.js';", 'App auth imports');
  c = replaceOnce(c, 'export function createApp({ datasetService, evaluationService, campaignService, healthCheck = async () => ({ status: \'ok\' }) }) {', 'export function createApp({ datasetService, evaluationService, campaignService, authService, authMiddleware, healthCheck = async () => ({ status: \'ok\' }) }) {', 'App dependency signature');
  c = replaceOnce(c, "  app.use('/api', rateLimit({", "  const authenticate = authMiddleware ?? createAuthenticationMiddleware(authService);\n  app.use('/api', rateLimit({", 'App auth middleware declaration');
  c = replaceOnce(c, "  app.use(helmet({ contentSecurityPolicy: false }));", `  app.use(helmet({ contentSecurityPolicy: { directives: {
    defaultSrc: ["'self'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'none'"],
    objectSrc: ["'none'"], scriptSrc: ["'self'"], connectSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'], fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    styleSrc: ["'self'", 'https://fonts.googleapis.com', "'unsafe-inline'"]
  } } }));`, 'Enable restrictive content security policy');
  c = replaceOnce(c, "  app.get('/api/health', async (req, res, next) => {", "  app.use('/api', sameOriginMutationGuard);\n  if (authService) app.use('/api/auth', createAuthRouter({ authService, authenticationMiddleware: authenticate }));\n\n  app.get('/api/health', async (req, res, next) => {", 'App auth route mount');
  c = replaceOnce(c, "  app.use('/api/datasets', createDatasetsRouter({ datasetService }));\n  app.use('/api/evaluations', createEvaluationsRouter({ evaluationService }));\n  if (campaignService) app.use('/api/evaluation-campaigns', createEvaluationCampaignsRouter({ campaignService }));", "  app.use('/api/datasets', authenticate, requireAuthentication, createDatasetsRouter({ datasetService }));\n  app.use('/api/evaluations', authenticate, requireAuthentication, createEvaluationsRouter({ evaluationService }));\n  if (campaignService) app.use('/api/evaluation-campaigns', authenticate, requireAuthentication, createEvaluationCampaignsRouter({ campaignService }));", 'App protected routers');
  changes.set('src/app.js', c);

  let s = changes.get('src/server.js');
  s = replaceOnce(s, "import { createEvaluationCampaignService } from './services/evaluation-campaign.service.js';", "import { createEvaluationCampaignService } from './services/evaluation-campaign.service.js';\nimport { authService } from './services/auth.service.js';\nimport { createAuthenticationMiddleware } from './middleware/authentication.js';", 'Server auth imports');
  s = replaceOnce(s, 'const campaignService = createEvaluationCampaignService({ enqueue: enqueueEvaluationCampaign });\nconst app = createApp({', 'const campaignService = createEvaluationCampaignService({ enqueue: enqueueEvaluationCampaign });\nconst authenticationMiddleware = createAuthenticationMiddleware(authService);\nconst app = createApp({', 'Server auth instance');
  s = replaceOnce(s, '  campaignService,\n  healthCheck:', '  campaignService,\n  authService,\n  authMiddleware: authenticationMiddleware,\n  healthCheck:', 'Server auth app injection');
  changes.set('src/server.js', s);
}

// 5) Add an authentication screen and gate dashboard data loading on a valid session.
{
  let html = changes.get('public/index.html');
  html = replaceOnce(html, '<body>\n  <div class="app-shell">', `<body>\n  <section id="auth-screen" class="auth-screen" aria-labelledby="auth-title">\n    <div class="auth-card">\n      <a class="brand auth-brand" href="/" aria-label="EvalForge home"><span class="brand-mark"><span></span><span></span><span></span></span><span>eval<span class="brand-accent">forge</span><small>AI RELIABILITY WORKSPACE</small></span></a>\n      <div class="section-kicker">PRIVATE WORKSPACE</div>\n      <h1 id="auth-title">Sign in to EvalForge<span class="heading-period">.</span></h1>\n      <p id="auth-description" class="page-subtitle">Sign in to access your datasets, evaluations, and reliability campaigns.</p>\n      <form id="auth-form" class="stack-form" autocomplete="on">\n        <label for="auth-email">Email address</label>\n        <input id="auth-email" name="email" type="email" autocomplete="email" maxlength="254" required>\n        <label for="auth-password">Password</label>\n        <input id="auth-password" name="password" type="password" autocomplete="current-password" minlength="1" maxlength="128" required>\n        <div id="auth-bootstrap-group" hidden><label for="auth-bootstrap-secret">First-account bootstrap secret</label><input id="auth-bootstrap-secret" name="bootstrap_secret" type="password" autocomplete="off" maxlength="256" aria-describedby="auth-bootstrap-help"><small id="auth-bootstrap-help" class="field-help">Use the private EVALFORGE_BOOTSTRAP_SECRET configured in .env for the first account.</small></div>\n        <small id="auth-password-help" class="field-help">Use your account password.</small>\n        <button class="button button-primary button-wide" type="submit" id="auth-submit">Sign in</button>\n        <div id="auth-message" class="form-message" role="status" aria-live="polite"></div>\n      </form>\n      <button type="button" id="auth-mode-toggle" class="text-link auth-mode-toggle">Need an account? Create one</button>\n      <p class="auth-security-note">Passwords are hashed before storage. Session tokens are stored server-side as hashes.</p>\n    </div>\n  </section>\n  <div class="app-shell">`, 'Auth screen HTML');
  html = replaceOnce(html, '<div class="avatar">EF</div>', '<div class="account-controls"><span id="account-email" class="account-email"></span><button class="subtle-button" id="logout-button" type="button">Sign out</button></div>', 'Account controls');
  changes.set('public/index.html', html);

  let js = changes.get('public/app.js');
  const authFunctions = `\nconst authUiState = { mode: 'login', registrationEnabled: true, bootstrapRequired: false };\n\nfunction setAuthMode(mode) {\n  authUiState.mode = mode === 'register' ? 'register' : 'login';\n  const registering = authUiState.mode === 'register';\n  $('#auth-title').textContent = registering ? 'Create your EvalForge account.' : 'Sign in to EvalForge.';\n  $('#auth-description').textContent = registering\n    ? 'Create an individual account. Your datasets and evaluations are private to your account.'\n    : 'Sign in to access your datasets, evaluations, and reliability campaigns.';\n  $('#auth-submit').textContent = registering ? 'Create account' : 'Sign in';\n  $('#auth-password').minLength = registering ? 12 : 1;\n  $('#auth-password').autocomplete = registering ? 'new-password' : 'current-password';\n  $('#auth-password-help').textContent = registering ? 'Use 12–128 characters. Prefer a unique password.' : 'Use your account password.';\n  $('#auth-bootstrap-group').hidden = !(registering && authUiState.bootstrapRequired);\n  $('#auth-bootstrap-secret').required = registering && authUiState.bootstrapRequired;\n  $('#auth-mode-toggle').hidden = !authUiState.registrationEnabled;\n  $('#auth-mode-toggle').textContent = registering ? 'Already have an account? Sign in' : 'Need an account? Create one';\n  $('#auth-message').textContent = '';\n  $('#auth-message').className = 'form-message';\n}\n\nfunction clearPrivateUiState() {\n  state.datasets = []; state.runs = []; state.runsPage = 1;\n  state.selectedRun = null; state.selectedCampaign = null; state.selectedCampaignId = null;\n  state.selectedCompareRuns = []; state.selectedDatasetId = null;\n  state.editingDatasetId = null; state.editingDatasetVersion = null;\n  $('#run-detail-panel').hidden = true;\n  $('#campaign-detail-panel').hidden = true;\n  $('#result-inspection').hidden = true;\n  $('#compare-result').hidden = true;\n}\n\nfunction showSignedOut(message = '') {\n  clearPrivateUiState();\n  document.body.classList.remove('authenticated');\n  $('#auth-screen').hidden = false;\n  $('#account-email').textContent = '';\n  setAuthMode(authUiState.mode);\n  if (message) { $('#auth-message').textContent = message; $('#auth-message').className = 'form-message error'; }\n}\n\nfunction showSignedIn(user) {\n  document.body.classList.add('authenticated');\n  $('#auth-screen').hidden = true;\n  $('#account-email').textContent = user?.email ?? '';\n}\n\nasync function initializeAuthentication() {\n  try {\n    const session = await api('/api/auth/me');\n    authUiState.registrationEnabled = session.registration_enabled === true;
    authUiState.bootstrapRequired = session.bootstrap_required === true;\n    if (session.authenticated && session.user?.id) {\n      showSignedIn(session.user);\n      await refreshAll({ quiet: true });\n    } else {\n      showSignedOut();\n    }\n  } catch (error) {\n    showSignedOut('Could not verify your session. Check that the API is running, then try again.');\n  }\n}\n\n$('#auth-mode-toggle').addEventListener('click', () => setAuthMode(authUiState.mode === 'login' ? 'register' : 'login'));\n$('#auth-form').addEventListener('submit', async (event) => {\n  event.preventDefault();\n  const registering = authUiState.mode === 'register';\n  const submit = $('#auth-submit');\n  submit.disabled = true;\n  $('#auth-message').textContent = registering ? 'Creating account…' : 'Signing in…';\n  $('#auth-message').className = 'form-message';\n  try {\n    const result = await api(registering ? '/api/auth/register' : '/api/auth/login', {\n      method: 'POST',\n      body: JSON.stringify({ email: $('#auth-email').value.trim(), password: $('#auth-password').value, bootstrap_secret: registering && authUiState.bootstrapRequired ? $('#auth-bootstrap-secret').value : undefined })\n    });\n    $('#auth-password').value = '';\n    $('#auth-bootstrap-secret').value = '';\n    authUiState.bootstrapRequired = false;\n    showSignedIn(result.user);\n    showToast(registering ? 'Account created.' : 'Signed in successfully.');\n    await refreshAll({ quiet: true });\n  } catch (error) {\n    $('#auth-message').textContent = error.message;\n    $('#auth-message').className = 'form-message error';\n  } finally { submit.disabled = false; }\n});\n\n$('#logout-button').addEventListener('click', async () => {\n  const button = $('#logout-button');\n  button.disabled = true;\n  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); }\n  catch (error) { showToast(error.message, 'error'); }\n  finally {\n    state.datasets = []; state.runs = []; state.selectedRun = null; state.selectedCampaign = null;\n    state.selectedCampaignId = null; state.selectedCompareRuns = []; state.selectedDatasetId = null; state.editingDatasetId = null; state.editingDatasetVersion = null;
    authUiState.bootstrapRequired = false;\n    $('#run-detail-panel').hidden = true; $('#campaign-detail-panel').hidden = true;\n    showSignedOut('You have signed out.');\n    button.disabled = false;\n  }\n});\n`;
  js = replaceOnce(js, 'refreshAll();\nwindow.setInterval', authFunctions + '\ninitializeAuthentication();\nwindow.setInterval', 'Auth JS bootstrap');
  changes.set('public/app.js', js);

  let css = changes.get('public/styles.css');
  css += `\n\n/* v1.1 account and authentication screen */\nbody:not(.authenticated) .app-shell{display:none}\n.auth-screen{min-height:100vh;display:grid;place-items:center;padding:28px 16px;background:radial-gradient(ellipse at 65% -15%,#17244b 0%,transparent 55%),var(--bg)}\n.auth-screen[hidden]{display:none!important}\n.auth-card{width:min(100%,440px);padding:30px;background:rgba(15,21,36,.97);border:1px solid var(--line);border-radius:18px;box-shadow:0 24px 90px rgba(0,0,0,.28)}\n.auth-brand{margin:0 0 34px;display:flex}\n.auth-card h1{margin:12px 0;font-size:28px;letter-spacing:-1px}\n.auth-card .stack-form{margin-top:24px}\n.auth-card input{width:100%;min-height:42px;padding:10px 12px;border:1px solid var(--line);border-radius:9px;background:var(--surface-2);color:var(--text)}\n.auth-mode-toggle{display:inline-block;margin-top:18px;background:none;border:0;padding:0;cursor:pointer}\n.auth-security-note{margin-top:24px;color:var(--muted-2);font-size:10px;line-height:1.6}\n.account-controls{display:flex;align-items:center;gap:12px}\n.account-email{font-size:11px;color:var(--muted);max-width:240px;overflow-wrap:anywhere}\n@media(max-width:560px){.auth-card{padding:22px}.account-email{display:none}}\n`;
  changes.set('public/styles.css', css);
}

// 6) Keep startup seeding compatible with per-user ownership.
{
  let seed = changes.get('scripts/seed.js');
  seed = replaceOnce(seed,
    '    await createDataset({',
    "    const firstUser = await pool.query('SELECT id FROM users ORDER BY created_at ASC LIMIT 1');\n    const seedOwnerId = firstUser.rows[0]?.id ?? null;\n    await createDataset({",
    'Seed dataset owner lookup');
  seed = replaceOnce(seed,
    '    });\n    console.log(`Seeded demo dataset with ${demoCases.length} test cases.`);',
    '    }, seedOwnerId);\n    console.log(`Seeded demo dataset with ${demoCases.length} test cases.`);',
    'Seed dataset owner argument');
  changes.set('scripts/seed.js', seed);
}

// 7) Server Compose and safe local environment template.
{
  let compose = changes.get('docker-compose.yml');
  const apiEnvironmentAnchor = '      NODE_ENV: production\n      PORT: 3000';
  compose = replaceOnce(compose, apiEnvironmentAnchor, '      NODE_ENV: production\n      AUTH_COOKIE_SECURE: ${AUTH_COOKIE_SECURE:-false}\n      EVALFORGE_REGISTRATION_ENABLED: ${EVALFORGE_REGISTRATION_ENABLED:-false}\n      EVALFORGE_BOOTSTRAP_SECRET: ${EVALFORGE_BOOTSTRAP_SECRET:-}\n      PORT: 3000', 'Compose authentication settings');
  compose = replaceOnce(compose, '"3000:3000"', '"127.0.0.1:3000:3000"', 'Bind dashboard/API host port to loopback');
  compose = replaceOnce(compose, '"5432:5432"', '"127.0.0.1:5432:5432"', 'Bind PostgreSQL host port to loopback');
  compose = replaceOnce(compose, '"6379:6379"', '"127.0.0.1:6379:6379"', 'Bind Redis host port to loopback');
  changes.set('docker-compose.yml', compose);

  let readme = changes.get('README.md');
  readme = readme.replace('- Dataset versions are immutable after creation; the current API creates a new dataset for new content rather than supporting version append/edit endpoints.', '- Dataset edits are saved as new immutable versions. Historical run records keep the version they evaluated.');
  readme = readme.replace(
    '- Authentication, per-user permissions, run ownership, and multi-tenant isolation are not implemented. Do not expose an unprotected instance publicly with real user data or secrets.',
    '- Individual accounts, server-side sessions, and per-user ownership for datasets, runs, and campaigns are introduced by the v1.1 security phase. Validate migrations and cross-user denial tests before relying on it for real user data. Team workspaces, email verification, password reset, and MFA are not included; this is not yet a public-production-hardened service.'
  );
  readme = readme.replace(
    '- Authentication, authorization, and run ownership before public deployment',
    '- Complete the v1.1 security acceptance checks in `docs/V1.1-IMPLEMENTATION-ROADMAP.md` before public deployment'
  );
  if (!readme.includes('## Authentication and local accounts')) {
    const anchor = '## Quick start with Docker';
    readme = replaceOnce(readme, anchor, `## Authentication and local accounts\n\nThe v1.1 authentication upgrade adds individual accounts and server-side sessions. Passwords are hashed with Node.js scrypt; raw session tokens are sent in an HttpOnly, SameSite=Lax cookie while only their hashes are stored in PostgreSQL. Dataset, run, and campaign API routes require a session and filter resources by owner. See [the v1.1+ implementation roadmap](./docs/V1.1-IMPLEMENTATION-ROADMAP.md) for phased scope and acceptance criteria.\n\nRegistration is disabled by default in Docker Compose. For local setup, add \`EVALFORGE_REGISTRATION_ENABLED=true\` to \`.env\` temporarily. If the database contains the seeded demo dataset or legacy v1.0 records, create a private bootstrap secret (for example, \`node -e \"console.log(require('node:crypto').randomBytes(32).toString('base64url'))\"\`), put it in \`EVALFORGE_BOOTSTRAP_SECRET\` in \`.env\` before creating the first account, then enter that secret on the registration screen. The first account claims unowned legacy rows; later accounts only see resources created under their own account. After setup, set \`EVALFORGE_REGISTRATION_ENABLED=false\` and restart. The dashboard/API and database ports bind to loopback by default; for a remote self-hosted deployment, expose only the dashboard/API through a trusted reverse proxy and enable HTTPS with \`AUTH_COOKIE_SECURE=true\`. Never expose PostgreSQL or Redis directly to untrusted networks. Session/account security must be validated in the actual deployment before public exposure.\n\n${anchor}`, 'README auth section');
  }
  changes.set('README.md', readme);
}

// 7) Adapt API tests to pass an explicit test-only identity, and adjust service argument expectations.
{
  let tests = changes.get('tests/integration/api.test.js');
  tests = replaceOnce(tests,
    '  return { app: createApp({ datasetService, evaluationService, campaignService }), datasetService, evaluationService, campaignService };',
    "  const authMiddleware = (req, res, next) => { req.user = { id: '11111111-1111-4111-8111-111111111111', email: 'test@example.invalid' }; next(); };\n  return { app: createApp({ datasetService, evaluationService, campaignService, authMiddleware }), datasetService, evaluationService, campaignService };",
    'API tests test-only authentication identity');
  tests = replaceOnce(tests,
    "expect(datasetService.createVersion).toHaveBeenCalledWith(datasetId, expect.objectContaining({",
    "expect(datasetService.createVersion).toHaveBeenCalledWith(datasetId, expect.objectContaining({",
    'Validate dataset version test anchor');
  tests = replaceOnce(tests,
    "expect(evaluationService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', model: 'gemini-3.8-flash' }));",
    "expect(evaluationService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'gemini', model: 'gemini-3.8-flash' }), '11111111-1111-4111-8111-111111111111');",
    'Evaluation create owner expectation');
  tests = replaceOnce(tests,
    "expect(campaignService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock', repeat_count: 3 }));",
    "expect(campaignService.create).toHaveBeenCalledWith(expect.objectContaining({ provider: 'mock', repeat_count: 3 }), '11111111-1111-4111-8111-111111111111');",
    'Campaign create owner expectation');
  // Existing assertion closes at the known object block; add the third owner arg after it.
  tests = replaceOnce(tests,
    "      })]\n    }));\n  });\n\n  it('rejects invalid dataset edits before calling the service'",
    "      })]\n    }), '11111111-1111-4111-8111-111111111111');\n  });\n\n  it('rejects invalid dataset edits before calling the service'",
    'Dataset version owner expectation');
  changes.set('tests/integration/api.test.js', tests);
}

// Add standalone deterministic auth tests using injected fakes; no database is used here.
changes.set('tests/unit/passwords.test.js', changes.get('tests/unit/passwords.test.js'));
changes.set('tests/integration/auth.test.js', changes.get('tests/integration/auth.test.js'));

// Verify expected changes exist before any write; then back up every changed existing file.
if (!changes.get('src/repositories/evaluations.repository.js').includes('owner_id')) fail('Evaluation owner changes are missing.');
if (!changes.get('src/app.js').includes('requireAuthentication')) fail('Authentication middleware was not wired.');
if (!changes.get('public/app.js').includes('initializeAuthentication();')) fail('Dashboard authentication bootstrap is missing.');
for (const [file, content] of changes) {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) {
    const backup = path.join(backupRoot, file);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(target, backup);
  }
}
for (const [file, content] of changes) fs.writeFileSync(path.join(root, file), content, 'utf8');

console.log('EvalForge v1.1 authentication and ownership phase installed.');
console.log(`Backups of replaced files: ${backupRoot}`);
console.log('Next: run node --check on changed JavaScript, then npm test and npm run test:regression.');
console.log('Do not deploy publicly until cross-user authorization, cookie behavior behind HTTPS, and existing-data migration are tested.');
