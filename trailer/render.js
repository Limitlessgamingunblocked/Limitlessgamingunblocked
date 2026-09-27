/* Trailer renderer: loads compose.html in headless Chromium, renders every frame and
   the synthesized soundtrack, and muxes them to an MP4 with ffmpeg.

   usage: node render.js <capDir> <out.mp4>
     STILLS=3,8,16   render only these timestamps (seconds) to <out>-<t>.jpg for review
     FROM=0 TO=1920  frame range (for partial renders)
     AUDIO_ONLY=1    only write the soundtrack (<out>.wav)
*/
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { chromium } = require('playwright');

const HERE = __dirname, CAP = path.resolve(process.argv[2] || 'cap'), OUT = path.resolve(process.argv[3] || 'haunted-camcorder-trailer.mp4');
const TYPES = { '.html': 'text/html', '.jpg': 'image/jpeg', '.ttf': 'font/ttf' };

(async () => {
  const browser = await chromium.launch({ args: ['--disable-gpu-vsync', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  page.on('console', (m) => { if (m.type() === 'error') console.error('[page]', m.text()); });
  page.on('pageerror', (e) => console.error('[pageerror]', e.message));
  // serve everything from one origin so the canvas is never tainted
  await page.route('https://trailer.local/**', (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname.slice(1));
    const file = rel.startsWith('cap/') ? path.join(CAP, rel.slice(4)) : path.join(HERE, rel);
    if (!fs.existsSync(file)) return route.fulfill({ status: 404, body: '' });
    route.fulfill({ status: 200, contentType: TYPES[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
  });
  await page.goto('https://trailer.local/compose.html');
  await page.waitForFunction(() => window.renderFrame && document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.fonts].map((f) => f.load())));
  const FRAMES = await page.evaluate(() => window.FRAMES);

  if (process.env.STILLS) {
    for (const s of process.env.STILLS.split(',').map(Number)) {
      const url = await page.evaluate((i) => window.renderFrame(i), Math.round(s * 30));
      fs.writeFileSync(OUT.replace(/\.mp4$/, '') + `-${s}.jpg`, Buffer.from(url.split(',')[1], 'base64'));
    }
    await browser.close(); return;
  }

  const t0 = Date.now();
  const { wav, peak } = await page.evaluate(() => window.renderAudio());
  const wavPath = OUT.replace(/\.mp4$/, '.wav'); fs.writeFileSync(wavPath, Buffer.from(wav, 'base64'));
  console.log('audio', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'peak', peak.toFixed(3));
  if (process.env.AUDIO_ONLY) { await browser.close(); return; }

  const from = +(process.env.FROM || 0), to = Math.min(FRAMES, +(process.env.TO || FRAMES));
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'mjpeg', '-i', '-',
    '-ss', String(from / 30), '-i', wavPath, '-map', '0:v', '-map', '1:a', '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
    '-pix_fmt', 'yuv420p', '-tune', 'grain', '-c:a', 'aac', '-b:a', '256k', '-t', String((to - from) / 30),
    '-movflags', '+faststart', OUT], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res) => ff.on('close', res));
  const t1 = Date.now();
  for (let i = from; i < to; i++) {
    const url = await page.evaluate((k) => window.renderFrame(k), i);
    if (!ff.stdin.write(Buffer.from(url.split(',')[1], 'base64'))) await new Promise((r) => ff.stdin.once('drain', r));
    if (i % 60 === 0) console.log('frame', i, ((Date.now() - t1) / 1000).toFixed(0) + 's');
  }
  ff.stdin.end(); const code = await done;
  console.log('ffmpeg exit', code, 'total', ((Date.now() - t0) / 1000).toFixed(0) + 's');
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
