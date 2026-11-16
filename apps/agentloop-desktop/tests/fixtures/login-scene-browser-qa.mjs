import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright-core';

// Run explicitly: node apps/agentloop-desktop/tests/fixtures/login-scene-browser-qa.mjs
// Paint checks catch an animated spark hidden by another SVG or the mascot.
const webRoot = process.env.LOGIN_SCENE_QA_WEB_DIR ?? fileURLToPath(new URL('../../web/', import.meta.url));
const output = process.env.LOGIN_SCENE_QA_OUTPUT;
if (output) await mkdir(output, { recursive: true });
const engine = process.env.LOGIN_SCENE_QA_ENGINE ?? 'chromium';
assert.ok(['chromium', 'webkit'].includes(engine));
const browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // Serve the real frontend assets without account data or external services.
  await page.route('http://desktop.test/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/auth/config') return route.fulfill({ json: { configured: true } });
    if (path === '/api/session') return route.fulfill({ status: 401, json: {} });
    const assets = {
      '/login': ['login.html', 'text/html'], '/register': ['login.html', 'text/html'],
      '/login.css': ['login.css', 'text/css'], '/login.js': ['login.js', 'text/javascript'],
      '/assets/xuanwu-mascot-icon.png': ['xuanwu-mascot-icon.png', 'image/png'],
    };
    const asset = assets[path];
    if (!asset) return route.fulfill({ status: 404 });
    return route.fulfill({ body: await readFile(join(webRoot, asset[0])), contentType: asset[1] });
  });
  await page.goto('http://desktop.test/login');
  await page.locator('#auth-submit:not([disabled])').waitFor();
  await page.evaluate(async () => {
    await Promise.all([...document.images].map(image => image.decode()));
    for (const svg of document.querySelectorAll('svg')) svg.pauseAnimations();
    for (const animation of document.getAnimations()) animation.pause();
  });
  const positions = [];
  // Two full turns, including the right-hand transition and foreground arc.
  for (let time = 0; time <= 32; time += 0.5) {
    const position = await page.evaluate(time => {
      for (const svg of document.querySelectorAll('svg')) svg.setCurrentTime(time);
      const spark = document.querySelector('.orbit-spark');
      spark.style.visibility = 'visible';
      const box = spark.getBoundingClientRect();
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }, time);
    const clip = { x: Math.floor(position.x) - 3, y: Math.floor(position.y) - 3, width: 6, height: 6 };
    const visible = await page.screenshot({ clip });
    await page.locator('.orbit-spark').evaluate(spark => { spark.style.visibility = 'hidden'; });
    const hidden = await page.screenshot({ clip });
    assert.ok(!visible.equals(hidden), `spark must visibly paint at ${time}s (${engine})`);
    positions.push(position);
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  assert.ok(distance(positions[0], positions[32]) < 1, 'first turn closes');
  assert.ok(distance(positions[0], positions[64]) < 1, 'second turn closes');
  assert.ok(distance(positions[16], positions[32]) > 200, 'spark traverses the other half');
  // The character moves, loops seamlessly, and remains still for reduced motion.
  const transforms = await page.locator('.hero-mascot').evaluate(mascot => {
    const animation = mascot.getAnimations()[0];
    if (!animation) return [];
    return [0, 2500, 5000].map(time => {
      animation.currentTime = time;
      return getComputedStyle(mascot).transform;
    });
  });
  assert.equal(transforms.length, 3, 'mascot has a live animation');
  assert.notEqual(transforms[0], transforms[1], 'mascot visibly moves');
  assert.equal(transforms[0], transforms[2], 'mascot returns to its starting pose');
  await page.locator('.orbit-spark').evaluate(spark => { spark.style.visibility = 'visible'; });
  if (output) await page.screenshot({ path: join(output, `login-scene-${engine}.png`), fullPage: true });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.orbit-spark').isVisible(), false);
  assert.equal(await page.locator('.hero-mascot').evaluate(mascot => mascot.getAnimations().length), 0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.goto('http://desktop.test/register');
  assert.equal(await page.locator('#auth-title').innerText(), '认识一下，新的伙伴');
  assert.equal(await page.locator('.loop-scene').isVisible(), true);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.locator('.loop-scene').isVisible(), false);
  assert.deepEqual(errors, []);
  console.log(`${engine}: 65 painted positions across two turns; mascot loop, reduced motion, registration and mobile passed`);
} finally {
  await browser.close();
}
