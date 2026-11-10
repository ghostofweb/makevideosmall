// End-to-end walkthrough of the real app.
//
//   node e2e/run.mjs <work dir>
//
// Generates its own test media, drives the window like a person would, and
// checks every output file with ffprobe. Screenshots go to <work dir>/shots.
// Native file pickers cannot be automated, so files are handed to the app the
// same way Windows "Open with" does: on the command line.

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { launch, waitFor } from './harness.mjs';

const workDir = path.resolve(process.argv[2] ?? '');
if (!process.argv[2]) {
  console.error('usage: node e2e/run.mjs <work dir>');
  process.exit(2);
}
const media = path.join(workDir, 'media');
const shots = path.join(workDir, 'shots');
rmSync(media, { recursive: true, force: true });
rmSync(shots, { recursive: true, force: true });
mkdirSync(media, { recursive: true });
mkdirSync(shots, { recursive: true });

// ───────────────────────────── helpers ─────────────────────────────

const results = [];
let failures = 0;
function check(name, condition, detail = '') {
  results.push({ name, ok: !!condition, detail });
  if (!condition) failures++;
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

function ffmpeg(args) {
  execFileSync('ffmpeg', ['-hide_banner', '-y', '-nostdin', '-loglevel', 'error', ...args], { stdio: 'pipe' });
}

function probe(file) {
  const out = execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8' });
  const data = JSON.parse(out);
  const of = (type) => data.streams.filter((s) => s.codec_type === type);
  return { video: of('video')[0], audio: of('audio'), subtitles: of('subtitle'), duration: Number(data.format.duration), size: Number(data.format.size) };
}

function imageSize(file) {
  const v = probe(file).video;
  return { w: v.width, h: v.height, pix: v.pix_fmt };
}

let shotIndex = 0;
async function shot(page, name) {
  shotIndex += 1;
  await page.screenshot({ path: path.join(shots, `${String(shotIndex).padStart(2, '0')}-${name}.png`) });
}

const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance;
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const out = (name) => path.join(media, name);
const consoleErrors = [];
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
  page.on('pageerror', (e) => consoleErrors.push(String(e)));
};
const region = (page, name) => page.getByRole('region', { name, exact: true });
const progressOf = async (queue) => {
  const bar = queue.getByRole('progressbar').first();
  return (await bar.count()) > 0 ? Number(await bar.getAttribute('aria-valuenow')) : -1;
};

/** Run one scenario; a failure inside is recorded and the run carries on. */
async function scenario(name, launchOptions, body, killOptions) {
  console.log(`\n── ${name}`);
  const app = await launch({ workDir, ...launchOptions });
  watch(app.page);
  try {
    await app.page.getByRole('heading', { name: 'Queue' }).or(app.page.getByRole('heading', { name: 'Pictures' })).first().waitFor({ timeout: 40000 });
    await body(app.page, app);
  } catch (e) {
    check(`${name}: ran to the end`, false, String(e).split('\n')[0]);
    await shot(app.page, `failure-${name.replace(/\W+/g, '-').toLowerCase()}`).catch(() => {});
  }
  await app.kill(killOptions);
}

// ───────────────────────────── test media ─────────────────────────────

console.log('Generating test media…');
const srt = path.join(media, 'subs.srt');
writeFileSync(srt, '1\n00:00:01,000 --> 00:00:06,000\nWelcome to the demo clip\n\n2\n00:00:08,000 --> 00:00:16,000\nSubtitles can be burned in\n');

const holiday = path.join(media, 'Holiday trip.mkv'); // letterboxed 1080p, 2 audio tracks, subtitle
ffmpeg([
  '-f', 'lavfi', '-i', 'testsrc2=size=1920x800:rate=24,pad=1920:1080:0:140:black,noise=alls=6:allf=t',
  '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
  '-f', 'lavfi', '-i', 'sine=frequency=660:sample_rate=48000',
  '-i', srt, '-t', '24',
  '-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '3:s',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '17', '-pix_fmt', 'yuv420p',
  '-c:a:0', 'aac', '-b:a:0', '192k', '-ac:a:0', '2', '-c:a:1', 'ac3', '-b:a:1', '448k', '-ac:a:1', '6',
  '-c:s', 'srt', '-metadata:s:a:0', 'language=eng', '-metadata:s:a:1', 'language=hin', '-metadata:s:s:0', 'language=eng',
  holiday,
]);
const screen = path.join(media, 'Screen recording.mp4');
ffmpeg(['-f', 'lavfi', '-i', 'mandelbrot=size=1280x720:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000', '-t', '15',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', screen]);
const tape = path.join(media, 'Old tape.mkv'); // different shape and frame rate, to test joining
ffmpeg(['-f', 'lavfi', '-i', 'smptebars=size=720x576:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000', '-t', '12',
  '-vf', 'interlace', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-flags', '+ilme+ildct', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', tape]);
const long = path.join(media, 'Long clip.mp4'); // slow enough to pause and interrupt
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30,noise=alls=10:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=500:sample_rate=48000', '-t', '40',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k', long]);
const photo = path.join(media, 'Photo.png');
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=2400x1600:rate=1,noise=alls=10', '-frames:v', '1', photo]);
const icon = path.join(media, 'Small icon.png');
ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=200x150:rate=1', '-frames:v', '1', icon]);
const exif = path.join(media, 'Camera photo.jpg');
copyFileSync(path.join(import.meta.dirname, '..', 'src-tauri', 'tests', 'fixtures', 'exif.jpg'), exif);

// ───────────────────────────── 1. the simple way ─────────────────────────────

await scenario('Simple video flow', { files: [holiday, screen, tape] }, async (page, app) => {
  const files = region(page, 'Files');
  const editor = region(page, 'Settings');
  const queue = region(page, 'Queue');
  await waitFor('three videos to be listed', async () => (await files.locator('li').count()) === 3);
  check('App starts and lists the three videos it was opened with', true, `${Date.now() - app.startedAt} ms to interactive`);
  check('The simple view is the default (no expert tabs)', (await page.getByRole('tab').count()) === 0);

  // Pick the letterboxed clip; the app checks it by itself.
  await files.getByRole('button', { name: 'Holiday trip.mkv', exact: true }).click();
  const checkStarted = Date.now();
  await editor.getByText('Suggested', { exact: true }).waitFor({ timeout: 180000 });
  const cards = editor.getByRole('radiogroup', { name: 'How small should it be?' }).getByRole('radio');
  const cardText = await cards.allTextContents();
  check('The video is checked automatically and three sizes are offered', (await cards.count()) === 3 && cardText.every((t) => /\d+(\.\d+)? (KB|MB|GB)/.test(t) && /Takes about/.test(t)), `${((Date.now() - checkStarted) / 1000).toFixed(0)} s; ${cardText.map((t) => t.replace(/\s+/g, ' ').slice(0, 70)).join(' | ')}`);
  check('Exactly one choice is marked as suggested', (await editor.getByText('Suggested', { exact: true }).count()) === 1);

  // Original and the chosen size play side by side.
  await waitFor('both comparison clips to play', () =>
    page.evaluate(() => {
      const v = [...document.querySelectorAll('video')];
      return v.length === 2 && v.every((x) => x.readyState >= 2 && x.videoWidth > 0 && !x.paused);
    }),
  );
  const dims = await page.evaluate(() => [...document.querySelectorAll('video')].map((v) => `${v.videoWidth}x${v.videoHeight}`));
  check('Original and result play side by side, black bars already removed', dims[0] === dims[1] && dims[0] === '1920x800', dims.join(' vs '));
  await page.waitForTimeout(600);
  await shot(page, 'simple-choices');

  // Choose a different size.
  const balanced = cards.filter({ hasText: 'Balanced' });
  await balanced.click();
  await waitFor('Balanced to be selected', async () => (await balanced.getAttribute('aria-checked')) === 'true');
  check('Clicking a card selects it', true);

  // Cut: keep the first 12 seconds.
  await editor.getByRole('button', { name: 'Cut the start or end' }).click();
  const end = editor.getByLabel('End', { exact: true });
  await end.fill('0:12');
  await end.press('Enter');
  await editor.getByText(/Keeping 0:12\.0 of 0:24\.0/).waitFor();
  await shot(page, 'simple-cut');
  await editor.getByRole('button', { name: 'Done', exact: true }).click();
  await editor.getByText('Keeping 0:00.0 to 0:12.0').waitFor();
  check('Cutting keeps 12 of 24 seconds', true);

  await editor.getByRole('button', { name: 'Add to queue' }).click();
  await waitFor('the job to be queued', async () => (await queue.locator('li').count()) === 1);

  // Join the other two into one video.
  await files.getByRole('checkbox', { name: 'Tick Screen recording.mp4' }).click();
  await files.getByRole('checkbox', { name: 'Tick Old tape.mkv' }).click();
  await shot(page, 'join-ticked');
  await files.getByRole('button', { name: 'Join these 2 into one video' }).click();
  await files.getByRole('button', { name: '2 videos joined', exact: true }).waitFor();
  await editor.getByRole('heading', { name: '2 videos will be joined into one' }).waitFor();
  check('Two ticked videos become one joined item', (await files.locator('li').count()) === 1);
  await shot(page, 'join-ready');
  await editor.getByRole('button', { name: 'Add to queue' }).click();
  await waitFor('two jobs in the queue', async () => (await queue.locator('li').count()) === 2);
  check('The video list is empty once everything is queued', (await files.locator('li').count()) === 0);

  // Drag the second job to the top.
  const order = () => queue.locator('li p.font-medium').allTextContents();
  const before = await order();
  const grip = queue.getByRole('button', { name: `Drag to reorder ${before[1]}` });
  const from = await grip.boundingBox();
  const to = await queue.locator('li').first().boundingBox();
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2, from.y - 20, { steps: 6 });
  await page.mouse.move(to.x + to.width / 2, to.y + 4, { steps: 12 });
  await page.mouse.up();
  await waitFor('the queue to reorder', async () => (await order())[0] === before[1], 8000).catch(() => {});
  const after = await order();
  check('Dragging reorders the queue', after[0] === before[1], `${before.join(' | ')}  →  ${after.join(' | ')}`);
  await shot(page, 'queued');

  await queue.getByRole('button', { name: 'Start' }).click();
  await page.getByText(/Queue finished: 2 files compressed/).waitFor({ timeout: 600000 });
  check('The queue finishes both jobs', (await queue.getByText(/% (smaller|larger)|same size/).count()) === 2);
  await shot(page, 'queue-finished');

  const h = probe(out('Holiday trip_small.mp4'));
  check('Holiday trip: black bars cropped off automatically', h.video.width === 1920 && h.video.height === 800, `${h.video.codec_name} ${h.video.width}x${h.video.height}`);
  check('Holiday trip: cut to 12 seconds', near(h.duration, 12, 0.4), `${h.duration.toFixed(2)} s`);
  check('Holiday trip: both audio tracks kept', h.audio.length === 2, h.audio.map((a) => a.codec_name).join(', '));
  check('Holiday trip: smaller than the original', h.size < statSync(holiday).size, `${mb(statSync(holiday).size)} → ${mb(h.size)}`);

  const j = probe(out('Screen recording_joined.mp4'));
  check('Joined video: both clips, one after the other', near(j.duration, 27, 0.6), `${j.duration.toFixed(2)} s (15 + 12)`);
  check('Joined video: takes the shape of the first clip, with sound', j.video.width === 1280 && j.video.height === 720 && j.audio.length === 1, `${j.video.width}x${j.video.height}, ${j.audio.length} audio`);
  check('Joining leaves the originals alone', existsSync(screen) && existsSync(tape));

  // The log for a finished job.
  await queue.getByRole('button', { name: /More actions for Holiday trip/ }).click();
  await page.getByRole('menuitem', { name: 'Show log' }).click();
  await page.locator('pre', { hasText: '$ ffmpeg' }).waitFor();
  await shot(page, 'job-log');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).first().click();

  // Settings read as plain questions and save as they change.
  await page.getByRole('button', { name: 'Settings' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Where should finished files go?' }).waitFor();
  await shot(page, 'settings');
  const readSettings = () => JSON.parse(readFileSync(path.join(app.dataDir, 'settings.json'), 'utf8'));
  const smallest = dialog.getByRole('radio', { name: /Smallest files/ });
  if ((await smallest.count()) > 0) {
    await smallest.click();
    await waitFor('the choice to be saved', () => readSettings().preferGpu === false, 5000);
    await dialog.getByRole('radio', { name: /Finish quickly/ }).click();
    await waitFor('the choice to be saved', () => readSettings().preferGpu === true, 5000);
    check('Settings are saved the moment they change', true);
  } else {
    console.log('SKIP  speed-or-size question (no graphics card encoder here)');
  }
  await page.keyboard.press('Escape');
});

// ───────────────────────────── 2. pause, crash, recover ─────────────────────────────

await scenario('Pause and crash', { files: [long], fresh: false }, async (page) => {
  const queue = region(page, 'Queue');
  await waitFor('finished jobs to be restored', async () => (await queue.getByText(/% (smaller|larger)|same size/).count()) === 2);
  check('Finished jobs are remembered after closing the app', true);
  await queue.getByRole('button', { name: 'Clear 2 finished' }).click();
  await waitFor('the queue to empty', async () => (await queue.locator('li').count()) === 0);

  // Expert controls are one switch away.
  await page.getByRole('switch', { name: 'Advanced controls' }).click();
  await page.getByRole('tab', { name: 'Video' }).click();
  check('The Advanced switch reveals the detailed controls', true);
  await page.getByRole('combobox', { name: 'Encoder' }).click();
  await page.getByRole('option', { name: 'H.265 / HEVC (x265)' }).click();
  await page.getByRole('radio', { name: 'Slow', exact: true }).click();
  await region(page, 'Settings').getByRole('button', { name: 'Add to queue' }).click();
  await queue.getByRole('button', { name: 'Start' }).click();
  await waitFor('the slow encode to make progress', async () => (await progressOf(queue)) >= 2, 120000);

  await queue.getByRole('button', { name: 'Pause' }).click();
  await queue.getByText(/^Paused /).waitFor();
  await page.waitForTimeout(1200);
  const frozenA = await progressOf(queue);
  await page.waitForTimeout(2500);
  const frozenB = await progressOf(queue);
  check('Pause freezes the encode', frozenA === frozenB, `stayed at ${frozenA}%`);
  await shot(page, 'paused');
  await queue.getByRole('button', { name: 'Resume' }).click();
  await waitFor('the encode to move again', async () => (await progressOf(queue)) > frozenB, 30000);
  check('Resume carries on from where it stopped', true);
  await shot(page, 'encoding');
  check('A partial output file exists while encoding', existsSync(out('Long clip_small.mp4')));
}, { tree: false }); // a crash or forced close mid-encode: only the app itself dies

await new Promise((r) => setTimeout(r, 2500));
const ffmpegLeft = execFileSync('tasklist', ['/fi', 'imagename eq ffmpeg.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
check('No ffmpeg process is left running after the app is killed', !/ffmpeg\.exe/i.test(ffmpegLeft));

await scenario('Recover', { fresh: false }, async (page) => {
  const queue = region(page, 'Queue');
  await waitFor('the interrupted job to be restored', async () => (await queue.locator('li').count()) === 1);
  const text = await queue.locator('li').first().textContent();
  check('The interrupted job is back in the queue as waiting', /Waiting/.test(text ?? ''), (text ?? '').replace(/\s+/g, ' ').slice(0, 80));
  check('The queue does not restart by itself', await queue.getByRole('button', { name: 'Start' }).isEnabled());
  await shot(page, 'restored-after-crash');

  await queue.getByRole('button', { name: 'Start' }).click();
  await waitFor('the encode to restart', async () => (await progressOf(queue)) >= 1, 60000);
  await queue.getByRole('button', { name: /^Cancel Long clip/ }).click();
  await queue.getByText('Cancelled').waitFor();
  await waitFor('the partial file to be deleted', () => !existsSync(out('Long clip_small.mp4')), 10000);
  check('Cancelling removes the partial file', true);
  await queue.getByRole('button', { name: /More actions for Long clip/ }).click();
  await page.getByRole('menuitem', { name: 'Remove from queue' }).click();
});

// ───────────────────────────── 3. the expert way ─────────────────────────────

await scenario('Advanced video flow', { files: [holiday], fresh: false }, async (page, app) => {
  const files = region(page, 'Files');
  const editor = region(page, 'Settings');
  const queue = region(page, 'Queue');
  await waitFor('the video to be listed', async () => (await files.locator('li').count()) === 1);
  await page.getByRole('tab', { name: 'Summary' }).waitFor(); // Advanced stayed on from last time
  check('The Advanced switch is remembered between launches', true);

  await page.getByRole('button', { name: 'Check for black bars and noise' }).click();
  await page.getByText('Black bars found: the picture itself is 1920×800.').waitFor({ timeout: 60000 });
  await page.getByRole('button', { name: 'Crop them off' }).click();
  await page.getByText('Applied').first().waitFor();
  await shot(page, 'advanced-summary');

  await page.getByRole('tab', { name: 'Video' }).click();
  await page.getByRole('combobox', { name: 'Encoder' }).click();
  await shot(page, 'advanced-encoders');
  await page.getByRole('option', { name: 'AV1 (SVT-AV1)' }).click();
  await page.getByRole('radio', { name: 'Fastest' }).click();
  await page.getByRole('combobox', { name: 'Resolution' }).click();
  await page.getByRole('option', { name: '720p' }).click();
  await shot(page, 'advanced-video');

  await page.getByRole('tab', { name: /^Audio/ }).click();
  await editor.getByRole('checkbox').nth(1).click();
  await page.getByRole('combobox', { name: 'Format for track 1' }).click();
  await page.getByRole('option', { name: 'Opus' }).click();
  await page.getByRole('tab', { name: 'Audio 1/2' }).waitFor();
  check('Audio: one of two tracks kept, as Opus', true);
  await shot(page, 'advanced-audio');

  await page.getByRole('tab', { name: /^Subtitles/ }).click();
  await page.getByRole('radio', { name: 'Burn into the picture' }).click();
  await page.getByRole('tab', { name: 'Filters' }).click();
  await page.getByRole('radiogroup', { name: 'Reduce noise' }).getByRole('radio', { name: 'Light' }).click();
  await shot(page, 'advanced-filters');

  const end = editor.getByLabel('End', { exact: true });
  await end.fill('0:10');
  await end.press('Enter');
  await editor.getByText(/Keeping 0:10\.0 of 0:24\.0/).waitFor();

  await page.getByRole('tab', { name: 'Summary' }).click();
  await page.getByRole('button', { name: 'Estimate size and time' }).click();
  await page.getByText(/Measured from three short samples/).waitFor({ timeout: 120000 });
  check('Advanced: a size estimate is produced', true);

  await page.getByRole('button', { name: 'Compare before and after' }).click();
  await page.getByText('Original', { exact: true }).waitFor({ timeout: 120000 });
  await waitFor('both comparison clips to play', () =>
    page.evaluate(() => {
      const v = [...document.querySelectorAll('video')];
      return v.length === 2 && v.every((x) => x.readyState >= 2 && x.videoWidth > 0 && !x.paused);
    }),
  );
  check('Advanced: before/after comparison plays', true);
  await shot(page, 'advanced-compare');
  await page.getByRole('button', { name: 'Close comparison' }).click();

  await editor.getByRole('button', { name: 'Custom settings' }).click();
  await page.getByRole('menuitem', { name: 'Save these settings as a preset…' }).click();
  await page.getByPlaceholder('Preset name').fill('My AV1 720p');
  await page.getByRole('button', { name: 'Save preset' }).click();
  await page.getByText('Saved preset "My AV1 720p"').waitFor();
  const presets = JSON.parse(readFileSync(path.join(app.dataDir, 'presets.json'), 'utf8'));
  check('Advanced: your own preset is saved to disk', presets.length === 1 && presets[0].name === 'My AV1 720p');

  await editor.getByRole('button', { name: 'Add to queue' }).click();
  await queue.getByRole('button', { name: 'Start' }).click();
  await page.getByText(/Queue finished: 1 file compressed/).waitFor({ timeout: 600000 });

  // "Holiday trip_small.mp4" exists from the first scenario, so this one is numbered.
  const h = probe(out('Holiday trip_small (2).mp4'));
  check('Advanced output: AV1, cropped then scaled to 720p', h.video.codec_name === 'av1' && h.video.width === 1728 && h.video.height === 720, `${h.video.codec_name} ${h.video.width}x${h.video.height}`);
  check('Advanced output: 10 seconds, one Opus track, subtitle burned in', near(h.duration, 10, 0.4) && h.audio.length === 1 && h.audio[0].codec_name === 'opus' && h.subtitles.length === 0, `${h.duration.toFixed(1)} s, ${h.audio.map((a) => a.codec_name).join(',')}, ${h.subtitles.length} subtitle tracks`);
  check('An existing file is never overwritten', existsSync(out('Holiday trip_small.mp4')));

  // Back to the simple view for whoever uses the app next.
  await page.getByRole('switch', { name: 'Advanced controls' }).click();
});

// ───────────────────────────── 4. pictures ─────────────────────────────

await scenario('Pictures', { files: [photo, icon, exif], fresh: false }, async (page) => {
  const images = region(page, 'Images');
  const tools = region(page, 'Image settings');
  const tool = (name) => tools.getByRole('radiogroup', { name: 'What to do with the pictures' }).getByRole('radio', { name });
  const go = (name) => tools.getByRole('button', { name });
  const idle = () => tools.getByRole('button', { name: 'Stop', exact: true }).waitFor({ state: 'hidden', timeout: 240000 });
  await waitFor('three pictures to be listed', async () => (await images.locator('li').count()) === 3, 30000);
  check('Pictures the app is opened with go to the picture tools', (await page.getByRole('radio', { name: 'Images' }).getAttribute('aria-checked')) === 'true');
  await shot(page, 'pictures-loaded');

  // Make smaller.
  await go('Make 3 pictures smaller').click();
  await page.getByText('3 pictures done').first().waitFor({ timeout: 120000 });
  await idle();
  const webp = out('Photo_small.webp');
  check('Make smaller: the WebP copy is smaller', existsSync(webp) && statSync(webp).size < statSync(photo).size, `${Math.round(statSync(photo).size / 1024)} KB → ${Math.round(statSync(webp).size / 1024)} KB`);
  check('Make smaller: camera and location data is left out', !readFileSync(out('Camera photo_small.webp')).includes('TestModel') && readFileSync(exif).includes('TestModel'));
  await images.getByRole('button', { name: 'Photo.png', exact: true }).click();
  await page.waitForTimeout(500);
  await shot(page, 'pictures-smaller');

  // Fit a size limit.
  await tool(/Fit a size limit/).click();
  await tools.getByRole('radio', { name: 'JPEG' }).click();
  await tools.getByRole('button', { name: '1 MB', exact: true }).click();
  await go('Make 3 pictures smaller').click();
  await waitFor('the sized JPEG to be written', () => existsSync(out('Photo_small.jpg')), 120000);
  await idle();
  const jpg = statSync(out('Photo_small.jpg')).size;
  check('Fit a size limit: lands under 1 MB without wasting the room', jpg <= 1024 * 1024 && jpg >= 400 * 1024, `${Math.round(jpg / 1024)} KB`);

  // Crop the selected picture to a square.
  await tool(/^Crop/).click();
  await tools.getByRole('button', { name: 'Square' }).click();
  const corner = page.getByTestId('crop-se');
  await corner.waitFor();
  const c = await corner.boundingBox();
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x - 60, c.y - 60, { steps: 8 });
  await page.mouse.up();
  await shot(page, 'pictures-crop');
  await go('Crop this picture').click();
  await waitFor('the cropped copy to be written', () => existsSync(out('Photo_cropped.png')), 60000);
  await idle();
  const cropped = imageSize(out('Photo_cropped.png'));
  check('Crop: the saved picture is the square that was drawn', cropped.w === cropped.h && cropped.w > 100 && cropped.w < 1600, `${cropped.w}x${cropped.h} from 2400x1600`);

  // Remove the background.
  await tool(/Remove background/).click();
  await go('Remove the background from 3 pictures').click();
  await waitFor('the cut-outs to be written', () => ['Photo', 'Small icon', 'Camera photo'].every((n) => existsSync(out(`${n}_no_background.png`))), 120000);
  await idle();
  const cut = imageSize(out('Camera photo_no_background.png'));
  check('Remove background: saved as a PNG that can be see-through', /a/.test(cut.pix) && cut.w === 640 && cut.h === 480, `${cut.w}x${cut.h} ${cut.pix}`);
  await page.waitForTimeout(500);
  await shot(page, 'pictures-background');

  // Make bigger: only the small icon.
  for (const name of ['Photo.png', 'Camera photo.jpg']) {
    await images.getByRole('button', { name: `Remove ${name} from the list` }).click({ force: true });
  }
  const bigger = tool(/Make bigger/);
  if (await bigger.isEnabled()) {
    await bigger.click();
    await go('Make 1 picture bigger').click();
    await waitFor('the enlarged picture to be written', () => existsSync(out('Small icon_4x.png')), 180000);
    await idle();
    check('Make bigger: no error is shown', (await images.getByRole('alert').count()) === 0);
    const big = imageSize(out('Small icon_4x.png'));
    check('Make bigger: 200×150 becomes 800×600', big.w === 800 && big.h === 600, `${big.w}x${big.h}`);
    await page.waitForTimeout(500);
    await shot(page, 'pictures-bigger');
  } else {
    console.log('SKIP  Make bigger (upscaler not installed)');
  }
});

// ───────────────────────────── summary ─────────────────────────────

check('No errors in the app console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));
console.log(`\n${results.length - failures} passed, ${failures} failed. Screenshots: ${shots}`);
process.exit(failures === 0 ? 0 : 1);
