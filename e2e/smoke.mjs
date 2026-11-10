// Quick look: start the app with the given files and save a screenshot.
//   node e2e/smoke.mjs <work dir> <screenshot.png> [files...]

import { launch } from './harness.mjs';

const [workDir, shot, ...files] = process.argv.slice(2);
if (!workDir || !shot) {
  console.error('usage: node e2e/smoke.mjs <work dir> <screenshot.png> [files...]');
  process.exit(2);
}

const app = await launch({ workDir, files });
const errors = [];
app.page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
app.page.on('pageerror', (e) => errors.push(String(e)));

try {
  await app.page.getByRole('heading', { name: 'Queue' }).waitFor({ timeout: 30000 });
  console.log(`ready in ${Date.now() - app.startedAt} ms`);
  if (files.length > 0) {
    // The simple view checks the first video by itself and suggests a choice.
    await app.page.getByText('Suggested', { exact: true }).waitFor({ timeout: 180000 });
    console.log(`choices measured after ${Date.now() - app.startedAt} ms`);
  }
  await app.page.waitForTimeout(2000);
  await app.page.screenshot({ path: shot });
  console.log('screenshot saved');
} finally {
  if (errors.length) console.log('console errors:\n' + errors.join('\n'));
  await app.kill();
}
