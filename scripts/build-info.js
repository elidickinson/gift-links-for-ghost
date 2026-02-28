// Generates src/build-info.js with git commit info, run by wrangler [build] command.
// Uses JSON.stringify for safe escaping of commit messages in JS output.
import { execSync } from 'child_process';
import { writeFileSync } from 'fs';

function git(cmd) {
  try { return execSync(cmd, { encoding: 'utf8' }).trim(); }
  catch { return null; }
}

const sha = git('git rev-parse --short HEAD') || 'unknown';
const message = git('git log -1 --format=%s') || '';
const deployedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

writeFileSync('src/build-info.js',
  `export const GIT_SHA = ${JSON.stringify(sha)};\n` +
  `export const GIT_MSG = ${JSON.stringify(message)};\n` +
  `export const DEPLOYED_AT = ${JSON.stringify(deployedAt)};\n`
);
