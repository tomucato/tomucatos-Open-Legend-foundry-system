/**
 * Publish a release to the Foundry VTT Package Release API.
 * https://foundryvtt.com/article/package-release-api/
 *
 * Usage:
 *   FOUNDRY_RELEASE_TOKEN=fvttp_xxx node scripts/foundry-release.mjs --dry-run
 *   FOUNDRY_RELEASE_TOKEN=fvttp_xxx node scripts/foundry-release.mjs
 *
 * Options:
 *   --dry-run            Validate the release without saving it on foundryvtt.com
 *   --version <x.y.z>    Override the version (defaults to system.json "version")
 *
 * The token is the "Package Release Token" from the package's page on
 * foundryvtt.com. The git tag v<version> must already be pushed, because the
 * release manifest URL points at that tag.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const API_URL = 'https://foundryvtt.com/_api/packages/release_version/';
const REPO = 'tomucato/tomucatos-Open-Legend-foundry-system';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const versionFlag = args.indexOf('--version');
const versionOverride = versionFlag !== -1 ? args[versionFlag + 1] : null;

const token = process.env.FOUNDRY_RELEASE_TOKEN;
if (!token) {
  console.error('Error: FOUNDRY_RELEASE_TOKEN environment variable is not set.');
  console.error('Find it in the "Package Release Token" field on the package page at foundryvtt.com.');
  process.exit(1);
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const system = JSON.parse(await readFile(join(root, 'system.json'), 'utf8'));
const version = versionOverride ?? system.version;

const payload = {
  id: system.id,
  ...(dryRun && { 'dry-run': true }),
  release: {
    version,
    // Must be a version-specific manifest URL, not the main branch one.
    manifest: `https://raw.githubusercontent.com/${REPO}/v${version}/system.json`,
    notes: `https://github.com/${REPO}/blob/v${version}/CHANGELOG.md`,
    compatibility: {
      minimum: String(system.compatibility.minimum),
      verified: String(system.compatibility.verified),
      ...(system.compatibility.maximum != null && {
        maximum: String(system.compatibility.maximum),
      }),
    },
  },
};

console.log(`Releasing ${system.id} v${version}${dryRun ? ' (dry run)' : ''}...`);
console.log(JSON.stringify(payload, null, 2));

const response = await fetch(API_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: token,
  },
  body: JSON.stringify(payload),
});

const body = await response.json().catch(() => null);
console.log(`HTTP ${response.status}`);
console.log(JSON.stringify(body, null, 2));

if (!response.ok || body?.status !== 'success') {
  if (response.status === 429) {
    console.error(`Rate limited. Retry after ${response.headers.get('Retry-After') ?? '60'}s.`);
  }
  process.exit(1);
}

console.log(dryRun
  ? 'Dry run OK. Re-run without --dry-run to publish.'
  : `Released. Package page: ${body.page}`);
