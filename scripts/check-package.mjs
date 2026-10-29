import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Install the actual tarball outside the checkout so missing exports or types
// cannot be hidden by source files or the SDK's development dependencies.
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'authrail-node-package-'));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
try {
  const packed = JSON.parse(execFileSync(npm,
    ['pack', '--json', '--silent', '--pack-destination', scratch],
    { cwd: repository, encoding: 'utf8' }));
  assert.equal(packed.length, 1);
  const tarball = join(scratch, packed[0].filename);
  writeFileSync(join(scratch, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  execFileSync(npm, ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball],
    { cwd: scratch, stdio: 'inherit' });
  writeFileSync(join(scratch, 'consumer.ts'), `
import { ObserveClient, EnforceClient, discover, lookupCustomerFact,
  newOpenAIDecisionsExtractor } from '@authrail/sdk-node';
import type { ObserveOperation, ApprovalContinuation, GuardHandler } from '@authrail/sdk-node';
const exported = [ObserveClient, EnforceClient, discover, lookupCustomerFact, newOpenAIDecisionsExtractor];
export type PublicContracts = [ObserveOperation, ApprovalContinuation, GuardHandler];
for (const value of exported) {
  if (typeof value !== 'function') throw new Error('Missing public package export');
}
`);
  execFileSync(process.execPath, [join(repository, 'node_modules/typescript/bin/tsc'),
    '--strict', '--skipLibCheck', '--target', 'ES2022', '--module', 'NodeNext',
    '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: scratch, stdio: 'inherit' });
  execFileSync(process.execPath, ['consumer.js'], { cwd: scratch, stdio: 'inherit' });
  const installed = JSON.parse(readFileSync(join(scratch, 'node_modules/@authrail/sdk-node/package.json'), 'utf8'));
  assert.equal(installed.version, JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8')).version);
  console.log('Packed SDK installs, exposes its public API, and compiles consumer types.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
