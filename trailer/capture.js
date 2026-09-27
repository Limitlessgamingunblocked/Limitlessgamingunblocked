// Captures staged in-engine shots from haunted-camcorder.html as JPEG sequences.
// Usage: node capture.js <outDir> [threeJsPath]
// Each shot drives the game's debug handle (window.HauntedCamcorder) frame by frame
// and grabs the rendered VHS frame straight from the WebGL canvas.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = process.argv[2] || path.join(__dirname, 'cap');
const THREE_JS = process.argv[3];
const GAME = path.resolve(__dirname, '..', 'haunted-camcorder.html');
const ONLY = process.env.SHOTS ? process.env.SHOTS.split(',') : null;
const [VW, VH] = (process.env.VIEW || '1920x1080').split('x').map(Number);

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: VW, height: VH } });
  if (process.env.DEBUG_HANG) { // kill -USR2 <pid> prints where the page's JS currently is
    const cdp = await page.context().newCDPSession(page); await cdp.send('Debugger.enable');
    cdp.on('Debugger.paused', (e) => { console.log('PAUSED', e.callFrames.slice(0, 12).map((f) => `${f.functionName || '(anon)'}:${f.location.lineNumber + 1}:${f.location.columnNumber}`).join(' < ')); cdp.send('Debugger.resume'); });
    process.on('SIGUSR2', () => cdp.send('Debugger.pause'));
  }
  page.on('pageerror', (e) => console.error('pageerror', e.message));
  if (THREE_JS) await page.route('**/three.min.js', (r) => r.fulfill({ path: THREE_JS, contentType: 'application/javascript' }));
  // no audio in capture: a headless AudioContext never advances, so every scheduled node and
  // automation event would be kept alive forever (the renderer grows until it is OOM-killed)
  await page.addInitScript(() => { window.AudioContext = undefined; window.webkitAudioContext = undefined; });
  await page.goto('file://' + GAME);
  await page.waitForFunction(() => window.HauntedCamcorder && window.HauntedCamcorder.G.mode === 'title', null, { timeout: 90000 });
  // start a night and skip to the first chapter
  await page.evaluate(() => { localStorage.setItem('hc_settings', ''); });
  await page.click('#pressplay'); await page.waitForTimeout(200);
  if (await page.isVisible('#btnTutGo')) await page.click('#btnTutGo');
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    const H = window.HauntedCamcorder, S = H.Story;
    S.cardClick(); S.cardClick(); S.closeDoc(); S.closeDoc();
    H.G.mode = 'editor'; // stop the live loop: we drive every frame from here
    window.requestAnimationFrame = () => 0; // and kill it outright, so no state change (a death, a card) can restart real-time rendering
    // nothing on the page needs to be composited; we read frames straight from the canvas
    for (const el of document.body.children) el.style.display = 'none';
    H.Director.next = 1e9; H.Director.dreadT = 1e9; S.ch = 99;
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    window.CAP = {
      H, V, dim: 1,
      place(x, y, z, eye) { H.Op.place(V(x, y, z), 0); if (eye) H.Op.eye = eye; },
      look(x, y, z) { const O = H.Op, dx = x - O.pos.x, dy = y - (O.pos.y + O.eye), dz = z - O.pos.z; O.yaw = Math.atan2(-dx, -dz); O.pitch = Math.atan2(dy, Math.hypot(dx, dz)); },
      step(dt = 1 / 30) { H.G.mode = 'editor'; H.Director.next = 1e9; H.Director.dreadT = 1e9; H.G.lightDim = this.dim; H.step(dt); },
      skip(sec) { for (let i = 0; i < Math.round(sec * 30); i++) this.step(); },
      prof: { step: 0, render: 0, read: 0, n: 0 },
      frame() {
        const gl = H.R.renderer.getContext(), px = new Uint8Array(4), P = this.prof; let a = performance.now();
        this.step(); P.step += performance.now() - a; a = performance.now();
        H.G.rt += 1 / 30; H.R.render(H.G.rt); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px); P.render += performance.now() - a; a = performance.now();
        const url = H.R.renderer.domElement.toDataURL('image/jpeg', 0.9); P.read += performance.now() - a; P.n++; return url;
      }
    };
    CAP.skip(2);
  }, null);
  // The game's full VHS pass is very slow in software GL; capture with a grade-only pass instead.
  // Scanlines, chroma bleed, grain and tracking are re-created in the compositor.
  await page.evaluate(() => {
    const m = window.HauntedCamcorder.R.postMat;
    m.fragmentShader = `precision highp float;
uniform sampler2D tDiffuse; uniform vec2 uRes; uniform float uTime, uGlitch, uNV, uFx, uBlack, uFlash, uStatic, uExposure, uFade, uVig, uWarp, uPresence;
varying vec2 vUv;
float h21(vec2 p){ vec3 p3 = fract(vec3(p.xyx) * .1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }
void main(){
  vec2 uv = vUv; float pr = uPresence;
  uv.x += sin(uv.y * 34.0 + uTime * 7.0) * 0.006 * pr;
  vec3 col = texture2D(tDiffuse, uv).rgb * uExposure;
  if (uNV > 0.5) { float l = dot(col, vec3(0.3, 0.59, 0.11)); l = 1.0 - exp(-l * 5.0); col = vec3(0.28, 1.0, 0.38) * (l * 1.15 + 0.035); }
  else { col = aces(col); col *= vec3(0.93, 0.99, 1.08); float lum = dot(col, vec3(0.3, 0.59, 0.11)); col = mix(vec3(lum), col, 0.68 - 0.45 * pr); col *= 1.0 - 0.25 * pr; }
  col = pow(max(col, 0.0), vec3(1.0 / 2.2)) * 0.96 + 0.01;
  float n = h21(vUv * uRes + fract(uTime * 7.13) * 1000.0);
  col = mix(col, vec3(n * 0.9), clamp(uStatic, 0.0, 1.0));
  col = mix(col, vec3(1.0), uFlash);
  col *= (1.0 - uBlack) * (1.0 - uFade);
  gl_FragColor = vec4(col, 1.0);
}`;
    m.needsUpdate = true;
  });
  // optional: render the 3D scene at a lower internal resolution (the VHS pass upsamples it anyway)
  if (process.env.INTERNAL) await page.evaluate((ih) => { const R = window.HauntedCamcorder.R, iw = Math.round(ih * innerWidth / innerHeight); R.resize = () => {}; R.rt.setSize(iw, ih); R.postMat.uniforms.uRes.value.set(iw, ih); }, Number(process.env.INTERNAL));

  const shots = [];
  const shot = (name, frames, setup, each) => shots.push({ name, frames, setup, each });
  // ── PART ONE ──
  shot('foyer_push', 96, `CAP.dim = 1; CAP.place(0, 0, 11.2); CAP.look(0, 5.6, -11.8);`,
    `CAP.H.Op.pos.z = 11.2 - i * 0.045; CAP.look(Math.sin(i * 0.02) * 0.6, 5.6 - i * 0.01, -11.8);`);
  shot('title_bg', 180, `CAP.dim = 0.9; CAP.place(3.2, 0, 9.4);`,
    `const t = i / 30; CAP.H.Op.pos.set(Math.sin(t * 0.25) * 3.2, 0, 9.4 - t * 0.35); CAP.look(Math.sin(t * 0.2) * 2, 3.4, -6);`);
  shot('library_tape', 72, `CAP.dim = 1; CAP.place(-6.7, 0, -8.2); CAP.look(-9.25, 0.8, -8.35);`,
    `CAP.H.Op.pos.x = -6.7 - i * 0.012; CAP.look(-9.25, 0.82, -8.35); CAP.H.Op.fovT = 75 - i * 0.35;`);
  shot('library_reset', 1, `CAP.H.Op.fovT = 75; CAP.H.Op.fov = 75;`, ``);
  shot('pale_woman', 84, `CAP.dim = 1; const g = CAP.H.Director.ghosts.sheet; g.float(CAP.V(-5.2, 0, -3.2), CAP.V(5.2, 0, -3.2), 2.0); CAP.place(0.4, 0, 5.8); CAP.look(-2, 1.5, -3.2);`,
    `const p = CAP.H.Director.ghosts.sheet.group.position; CAP.look(p.x * 0.8, 1.5, -3.2); if (i === 60) { const g = CAP.H.Director.ghosts.sheet; g.reveal = 1; }`);
  shot('doll', 72, `CAP.dim = 1; const d = CAP.H.Director.doll; d.place(CAP.V(-12, 4.5, -2.2), CAP.V(-12, 4.5, 3)); d.visible = true; d.glow = 0; CAP.place(-12, 4.5, 1.4); CAP.look(-12, 4.9, -2.2);`,
    `CAP.H.Op.pos.z = 1.4 - i * 0.03; CAP.look(-12, 4.85, -2.2); const d = CAP.H.Director.doll; if (i > 40) d.glow = Math.min(1, (i - 40) / 8);`);
  shot('gallery_hall', 60, `CAP.dim = 1; CAP.place(-3.6, 4.5, -9.4); CAP.look(-13, 6.6, -11.84); CAP.H.Director.force('gallery'); CAP.skip(1.6);`,
    `CAP.look(-12 - i * 0.05, 6.6, -11.84);`);
  shot('gallery_mother', 66, `CAP.skip(1.4); CAP.place(0, 4.5, -8.4); CAP.look(0, 6.9, -11.84);`,
    `CAP.look(0, 6.85, -11.84); CAP.H.Op.fovT = 75 - i * 0.5;`);
  shot('crawler', 96, `CAP.skip(4); CAP.H.Op.fovT = 75; CAP.dim = 0.95; const c = CAP.H.Director.ghosts.crawler; c.nvOnly = false; c.place(CAP.V(-18.5, 4.3, -1.5), Math.PI / 2 + 0.3, true); c.gait = 0; CAP.place(-10.5, 0, 1.2); CAP.look(-15, 3.6, -3);`,
    `const c = CAP.H.Director.ghosts.crawler, p = c.group.position; if (i < 56) { p.x += 0.085; p.z -= 0.035; c.gait += 0.35; } else { const want = -1.4; c.headYaw += (want - c.headYaw) * 0.25; } CAP.look(p.x + 0.4, 3.3, p.z);`);
  shot('mother_glimpse', 90, `const c = CAP.H.Director.ghosts.crawler; c.hide(); const M = CAP.H.Director.mother; M.group.position.set(12.25, 0, -13.3); M.group.rotation.y = 0.05; M.active = true; M.manual = true; M.alpha = 1; M.mouthOpen = 0.35; M.reach = 0.1; CAP.dim = 0.85; CAP.place(13.2, 0, 1.8); CAP.look(12.25, 2.9, -13.3); CAP.H.Op.fovT = 70;`,
    `CAP.H.Op.fovT = Math.max(24, 70 - i * 0.62); CAP.look(12.25, 2.95, -13.3); const M = CAP.H.Director.mother; M.mouthOpen = 0.35 + Math.max(0, i - 60) / 30 * 0.6;`);
  shot('mother_chase', 96, `CAP.H.Op.fovT = 75; CAP.H.Op.fov = 75; CAP.dim = 0.35; const M = CAP.H.Director.mother; M.group.position.set(9, 9, 9.5); M.alpha = 1; CAP.place(15.5, 9, 4.2); CAP.H.G.ghostLight = { obj: M.headG, color: new THREE.Color(0xff2020), intensity: 7, scare: null };`,
    `const M = CAP.H.Director.mother, mp = M.group.position, o = CAP.H.Op.pos; if (i % 7 === 0) { mp.x += (o.x - mp.x) * 0.1; mp.z += (o.z - mp.z) * 0.1; } o.x += 0.012; o.z -= 0.008; M.group.rotation.y = Math.atan2(o.x - mp.x, o.z - mp.z); M.mouthOpen = Math.min(1, i / 70); M.reach = Math.min(1, i / 60); CAP.look(mp.x, mp.y + 2.6, mp.z); CAP.H.Op.trauma = i > 70 ? 0.5 : 0.1;`);
  shot('jump_mother', 26, `CAP.H.G.ghostLight = null; CAP.H.fire('inface', { tex: CAP.H.Director.mother.faceMat.map });`, ``);
  shot('rose_crib', 90, `const M = CAP.H.Director.mother; M.active = false; M.alpha = 0; M.manual = false; CAP.dim = 0.8; const r = CAP.H.Director.ghosts.rose; r.place(CAP.V(-18.6, 5.0, -6.3), Math.PI / 2, true); const d = CAP.H.Director.doll; d.place(CAP.V(-18.55, 5.01, -6.75), CAP.V(-12, 5, -6.3)); d.glow = 0; CAP.place(-12.6, 4.5, -5.6); CAP.look(-18.6, 5.4, -6.3);`,
    `CAP.H.Op.pos.x = -12.6 - i * 0.03; CAP.look(-18.6, 5.45, -6.3); CAP.H.Op.fovT = 75 - i * 0.3;`);
  shot('jump_rose', 24, `CAP.H.Op.fovT = 75; CAP.H.Op.fov = 75; CAP.H.fire('inface', { tex: CAP.H.Director.ghosts.rose.faceMat.map });`, ``);
  // ── PART TWO ──
  shot('door_slam', 75, `CAP.H.Director.ghosts.rose.hide(); CAP.dim = 1; CAP.skip(1); const S = CAP.H.Story; S.flags = {}; CAP.H.world().frontDoor.release(); CAP.skip(2.5); CAP.place(0, 0, 9.4); CAP.look(0, 1.8, 12.2); CAP.skip(0.3);`,
    `if (i === 20) { CAP.H.Story.ch = 7; CAP.H.Story.partTwo(); CAP.H.Story.ch = 99; const G = CAP.H.G; G.flashOutUntil = G.t + 0.3; G.flickerUntil = G.t + 1.4; } CAP.H.Op.light = true; CAP.look(0, 1.8, 12.2); CAP.dim = i > 20 ? 0.6 : 1;`);
  shot('kept', 132, `CAP.skip(5); CAP.H.Story.ch = 99; CAP.dim = 0.35; CAP.H.Hunt.stop(); const K = CAP.H.Director.ghosts.kept; const spots = [[-2.2, 0, 1.5, 0], [0.4, 0, -0.5, 4], [2.6, 0, 2.2, 1]]; K.forEach((k, j) => { if (spots[j]) k.place(CAP.V(spots[j][0], spots[j][1], spots[j][2]), 0, spots[j][3]); else k.hide(); }); CAP.place(0, 0, 9.5); CAP.look(0, 1.4, 1);`,
    `const K = CAP.H.Director.ghosts.kept, o = CAP.H.Op.pos; CAP.look(0, 1.4, 1); const beat = [34, 68, 100]; if (beat.includes(i)) CAP.H.G.flashOutUntil = CAP.H.G.t + 0.2; if (beat.map((b) => b + 5).includes(i)) { K.slice(0, 3).forEach((k, j) => { const p = k.group.position; p.x += (o.x - p.x) * (i > 100 ? 0.55 : 0.32); p.z += (o.z - p.z) * (i > 100 ? 0.55 : 0.32); k.newPose(); k.faceTo(o); }); }`);
  shot('lady', 96, `const K = CAP.H.Director.ghosts.kept; K.forEach((k) => k.hide()); CAP.dim = 0.3; const pw = CAP.H.Director.ghosts.sheet; window.LP = CAP.V(-15, 4.5, -10); pw.puppetTo(LP, Math.PI / 2, 0); CAP.place(-5.5, 4.5, -10.3); CAP.look(-15, 5.9, -10); CAP.H.Op.crouch = true; CAP.H.Op.eye = 1.05;`,
    `const pw = CAP.H.Director.ghosts.sheet; if (i < 62) LP.x += 0.035; else LP.x += 0.16; pw.puppetTo(LP, Math.PI / 2, i < 62 ? 0 : 1); CAP.look(LP.x, 5.7, -10);`);
  shot('below_nv', 96, `CAP.H.Op.crouch = false; CAP.H.Director.ghosts.sheet.hide(); CAP.dim = 0.2; CAP.H.Op.nv = true; const c = CAP.H.Director.ghosts.crawler; c.nvOnly = true; c.place(CAP.V(17.5, -0.2, -14.2), Math.PI * 0.8, true); CAP.place(11, -4, -21); CAP.look(15, -0.8, -16);`,
    `const c = CAP.H.Director.ghosts.crawler, p = c.group.position; if (i < 60) { p.x -= 0.05; p.z -= 0.06; c.gait += 0.4; c.group.rotation.y = Math.atan2(-0.05, -0.06); } else c.headYaw += (-(Math.PI * 0.9) - c.headYaw) * 0.2; CAP.look(p.x - 0.3, p.y - 0.7, p.z);`);
  shot('stalker', 108, `CAP.H.Op.nv = false; CAP.H.Director.ghosts.crawler.hide(); CAP.dim = 0.35; const sf = CAP.H.Director.ghosts.shadow; sf.show(CAP.V(8.5, 9, 10.2), 0); sf.alpha = 1; CAP.place(17, 9, 2.4); CAP.look(8.5, 11.2, 10.2);`,
    `const sf = CAP.H.Director.ghosts.shadow, p = sf.group.position, o = CAP.H.Op.pos; if (i === 30 || i === 60 || i === 84) CAP.H.G.flashOutUntil = CAP.H.G.t + 0.25; if (i === 36 || i === 66 || i === 90) { p.x += (o.x - p.x) * 0.38; p.z += (o.z - p.z) * 0.38; sf.group.rotation.y = Math.atan2(o.x - p.x, o.z - p.z); } CAP.look(p.x, p.y + 2.5, p.z); if (i > 92) CAP.H.Op.fovT = 26;`);
  shot('danny_corner', 90, `CAP.H.Op.fovT = 75; CAP.H.Op.fov = 75; CAP.H.Director.ghosts.shadow.vanish(); CAP.dim = 0.35; const w = CAP.H.Director.ghosts.watcher; w.faceless = false; w.show(CAP.V(6.7, 9, 11.3)); w.group.rotation.y = Math.atan2(-0.7, 0.7); CAP.place(10.8, 9, 7.4); CAP.look(6.7, 10.5, 11.3);`,
    `const o = CAP.H.Op.pos; o.x -= 0.028; o.z += 0.027; CAP.look(6.7, 10.5, 11.3); const w = CAP.H.Director.ghosts.watcher; if (i === 76) { w.faceTo(o); CAP.H.G.glitchKick = 1.2; }`);
  shot('rose_found', 72, `CAP.H.Director.ghosts.watcher.vanish(); CAP.dim = 0.3; const r = CAP.H.Director.ghosts.rose; r.place(CAP.V(17.9, 0, -4), -Math.PI / 2, true); CAP.place(12.5, 0, -1.4); CAP.look(17.9, 0.6, -4);`,
    `CAP.H.Op.pos.x = 12.5 + i * 0.03; CAP.look(17.9, 0.62, -4); const r = CAP.H.Director.ghosts.rose; if (i === 48) { r.crouch = 0; }`);
  shot('jump_kept', 24, `CAP.H.Director.ghosts.rose.hide(); CAP.H.fire('inface', { tex: CAP.H.Director.ghosts.watcher.faceMat.map });`, ``);

  fs.mkdirSync(OUT, { recursive: true });
  const last = ONLY ? Math.max(...shots.map((s, k) => ONLY.includes(s.name) ? k : -1)) : shots.length - 1;
  for (const s of shots.slice(0, last + 1)) {
    await page.evaluate((code) => { new Function(code)(); }, s.setup);
    if (ONLY && !ONLY.includes(s.name)) {
      console.log('skip', s.name, new Date().toTimeString().slice(0, 8));
      // step through shots we don't need, in small batches so the page gets to breathe (GC, timers) between them.
      for (let i0 = 0; i0 < s.frames; i0 += 10) await page.evaluate(([code, i0, n]) => { for (let i = i0; i < Math.min(n, i0 + 10); i++) { if (code) new Function('i', code)(i); CAP.step(); CAP.H.G.rt += 1 / 30; } }, [s.each, i0, s.frames]);
      continue;
    }
    const dir = path.join(OUT, s.name); fs.mkdirSync(dir, { recursive: true });
    const t0 = Date.now();
    for (let i = 0; i < s.frames; i++) {
      const url = await page.evaluate(([code, i]) => { if (code) new Function('i', code)(i); return CAP.frame(); }, [s.each, i]);
      fs.writeFileSync(path.join(dir, String(i).padStart(4, '0') + '.jpg'), Buffer.from(url.split(',')[1], 'base64'));
    }
    console.log(s.name, s.frames, 'frames', ((Date.now() - t0) / 1000).toFixed(1) + 's', JSON.stringify(await page.evaluate(() => { const P = CAP.prof, o = { step: P.step / P.n, render: P.render / P.n, read: P.read / P.n }; CAP.prof = { step: 0, render: 0, read: 0, n: 0 }; return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v)])); })));
  }
  await browser.close();
})();
