import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bundleRoot = path.dirname(fileURLToPath(import.meta.url));
const installerPath = path.join(bundleRoot, 'apply-v11-auth-ownership.mjs');

function isProjectRoot(candidate) {
  if (!candidate || !fs.existsSync(path.join(candidate, 'package.json'))) return false;
  if (!fs.existsSync(path.join(candidate, 'src', 'app.js'))) return false;
  if (!fs.existsSync(path.join(candidate, 'tests', 'integration', 'api.test.js'))) return false;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(candidate, 'package.json'), 'utf8'));
    return pkg.name === 'evalforge' && typeof pkg.scripts?.test === 'string';
  } catch {
    return false;
  }
}

const candidates = [
  process.cwd(),
  path.resolve(bundleRoot, '..'),
  path.resolve(process.cwd(), '..'),
  path.resolve(process.cwd(), '..', '..')
];
const root = candidates.find(isProjectRoot);
if (!root) {
  console.error('Could not locate the EvalForge project root. Extract this bundle so evalforge-v11-auth-patch is beside package.json, then run:');
  console.error('  node evalforge-v11-auth-patch/install-and-test.mjs');
  process.exit(2);
}

console.log(`EvalForge project root: ${root}`);
console.log('\n[1/4] Applying the authentication and ownership patch...');
const install = spawnSync(process.execPath, [installerPath], { cwd: root, stdio: 'inherit' });
if (install.error) {
  console.error(`Could not run installer: ${install.error.message}`);
  process.exit(2);
}
if (install.status !== 0) {
  console.error('\nInstaller did not complete. No test command was run. Share the complete installer output before retrying.');
  process.exit(install.status ?? 2);
}

const requiredMarkers = [
  ['src/app.js', "app.use('/api/datasets', authenticate, requireAuthentication"],
  ['src/app.js', "app.use('/api/auth', createAuthRouter"],
  ['src/repositories/datasets.repository.js', 'owner_id'],
  ['src/repositories/evaluations.repository.js', 'owner_id'],
  ['src/services/auth.service.js', 'export const authService = {'],
  ['tests/integration/auth.test.js', 'rejects unauthenticated requests to user resources']
];
for (const [relative, marker] of requiredMarkers) {
  const full = path.join(root, relative);
  if (!fs.existsSync(full) || !fs.readFileSync(full, 'utf8').includes(marker)) {
    console.error(`\nPost-install verification failed: expected marker not found in ${relative}: ${marker}`);
    console.error('Do not deploy. Share this output so the patch can be reconciled with your source revision.');
    process.exit(3);
  }
}

function runNpm(args, label) {
  console.log(`\n[${label}] npm ${args.join(' ')}`);
  const result = spawnSync('npm', args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: process.env
  });
  if (result.error) {
    console.error(`Could not run npm: ${result.error.message}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`\nCommand failed: npm ${args.join(' ')} (exit ${result.status ?? 'unknown'}).`);
    process.exit(result.status ?? 1);
  }
}

runNpm(['test'], '2/4');
runNpm(['run', 'test:regression'], '3/4');
console.log('\n[4/4] Patch verification complete: unit/integration and regression test commands both passed.');
console.log('This does not replace manual cross-account authorization and database-migration checks before deployment.');
