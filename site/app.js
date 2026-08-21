// Ghost Type — scroll site engine. One rAF loop, native scroll + CSS sticky, no deps.
const rm = matchMedia('(prefers-reduced-motion: reduce)').matches;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

// progress of a tall (pinned) section: 0 when its top hits the viewport top, 1 when its
// bottom would leave — i.e. while the sticky child is pinned.
function pinProgress(sec) {
  const r = sec.getBoundingClientRect();
  const span = sec.offsetHeight - innerHeight;
  return span > 0 ? clamp(-r.top / span, 0, 1) : (r.top <= 0 ? 1 : 0);
}

/* ---------- hero intro ---------- */
requestAnimationFrame(() => $('#hero').classList.add('lit'));

/* ---------- reveal-on-enter ---------- */
const io = new IntersectionObserver((es) => {
  es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } });
}, { threshold: 0.18 });
$$('.rv, .stag, #gap').forEach(el => io.observe(el));

/* ---------- one-shot typewriters ---------- */
function typeInto(el, text, { speed = 22, delay = 0, em = 0 } = {}) {
  if (rm) { el.textContent = text; return; }
  const a = document.createElement('span'), b = document.createElement('span');
  b.className = 'em'; el.textContent = ''; el.append(a, b);
  let i = 0;
  const tick = () => {
    if (i > text.length) return;
    const cut = text.length - em;
    a.textContent = text.slice(0, Math.min(i, cut));
    b.textContent = i > cut ? text.slice(cut, i) : '';
    i++; setTimeout(tick, speed);
  };
  setTimeout(tick, delay);
}
let punched = false, voiced = false;
const punchObs = new IntersectionObserver((es) => es.forEach(e => {
  if (e.isIntersecting && !punched) { punched = true; typeInto($('#punchtxt'), 'Ghost Type is the first to write the next thing you’d type.', { em: 27 }); }
}), { threshold: 0.6 });
punchObs.observe($('#gap'));
const voiceObs = new IntersectionObserver((es) => es.forEach(e => {
  if (e.isIntersecting && !voiced) { voiced = true; typeInto($('#voicetype'), 'the observer never fires in jsdom — mock it, or assert on the loading attribute instead', { speed: 16, em: 0 }); }
}), { threshold: 0.4 });
voiceObs.observe($('#voice'));

/* ---------- the loop terminal (scroll-scrubbed typing) ---------- */
const LINES = [
  { cls: 'sys', step: -1, t: '$ ghost on "make the gallery lazy-load"' },
  { cls: 'pre', step: 0, t: '▸ cloned sitecraft — isolated, origin removed' },
  { cls: 'you', step: 1, t: 'make the gallery lazy-load images below the fold' },
  { cls: 'sys', step: 1, t: '  … claude working …' },
  { cls: 'pre', step: 2, t: '▸ session stopped — running the test myself' },
  { cls: 'sys', step: 3, t: '  ✗ IntersectionObserver never fires in the test' },
  { cls: 'you', step: 4, t: 'the observer never fires in jsdom — mock it, or assert on the loading attribute instead' },
  { cls: 'sys', step: 4, t: '  ✓ 12 passed' },
  { cls: 'pre', step: 5, t: '▸ shipped → ghost/2026-08-21-gallery · review it in the morning' },
];
const TOTAL = LINES.reduce((n, l) => n + l.t.length + 1, 0);
const termBody = $('#termbody'), term = $('#term'), stepEls = $$('#steps .stepline');

function renderTerm(p) {
  const typed = Math.floor(clamp(p * 1.08, 0, 1) * TOTAL);
  let acc = 0, html = '', active = -1;
  for (const l of LINES) {
    const len = l.t.length + 1;
    if (acc + len <= typed) { html += `<div class="ln ${l.cls}">${escapeHtml(l.t)}</div>`; active = l.step; }
    else if (acc < typed) {
      const n = typed - acc;
      html += `<div class="ln ${l.cls}">${escapeHtml(l.t.slice(0, n))}<span class="tc"></span></div>`;
      active = l.step; break;
    } else break;
    acc += len;
  }
  termBody.innerHTML = html || '<div class="ln sys"><span class="tc"></span></div>';
  term.classList.toggle('glow', p > 0.01 && p < 0.995);
  stepEls.forEach(s => s.classList.toggle('on', +s.dataset.i <= active));
}
function escapeHtml(s) { return s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

/* ---------- scrub videos ---------- */
function setupScrub(id) {
  const v = $('#' + id);
  v && v.pause();
  return v;
}
const leaveVid = setupScrub('leaveVid'), morningVid = setupScrub('morningVid');
function scrub(v, sec) {
  if (!v || !v.duration || rm) return 0;
  const p = pinProgress(sec);
  const t = clamp(p, 0, 0.999) * v.duration;
  if (Math.abs(v.currentTime - t) > 0.03) { try { v.currentTime = t; } catch {} }
  return p;
}

/* ---------- morning report assemble + toast ---------- */
const reportRows = $$('#report .row'), toast = $('#toast');

/* ---------- night clock ---------- */
const clockEl = $('#clocktime');
function fmtClock(p) {
  let mins = (23 * 60 + p * 480) % 1440;   // 11:00 PM → +8h
  let h = Math.floor(mins / 60), m = Math.floor(mins / 10) * 10 % 60;
  const ap = h >= 12 ? 'PM' : 'AM'; let h12 = h % 12; if (h12 === 0) h12 = 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap}`;
}

/* ---------- parallax ---------- */
const paraEls = $$('[data-speed]');

/* ---------- magnetic CTA ---------- */
const mag = $('#mag'), magBtn = mag && mag.firstElementChild;
if (mag && !rm) {
  mag.addEventListener('pointermove', e => {
    const r = mag.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    magBtn.style.transform = `translate(${dx * 0.25}px, ${dy * 0.35}px)`;
  });
  mag.addEventListener('pointerleave', () => { magBtn.style.transform = ''; });
}

/* ---------- the loop ---------- */
const cue = $('#cue'), rail = $('#rail'), loopSec = $('#loop'), leaveSec = $('#leaveScrub'), morningSec = $('#morningScrub');
function frame() {
  const y = scrollY, max = document.documentElement.scrollHeight - innerHeight;
  const prog = max > 0 ? y / max : 0;
  rail.style.transform = `scaleX(${prog})`;
  clockEl.textContent = fmtClock(prog);
  if (cue) cue.style.opacity = clamp(1 - y / 300, 0, 1);

  if (!rm) for (const el of paraEls) {
    const r = el.getBoundingClientRect(), speed = +el.dataset.speed;
    const off = (r.top + r.height / 2 - innerHeight / 2) * (speed - 1) * 0.14;
    el.style.transform = `translate3d(0, ${off.toFixed(2)}px, 0)`;
  }

  renderTerm(pinProgress(loopSec));
  scrub(leaveVid, leaveSec);
  const mp = scrub(morningVid, morningSec);
  const mpp = rm ? (morningSec.getBoundingClientRect().top < innerHeight * 0.6 ? 1 : 0) : mp;
  reportRows.forEach((row, i) => row.classList.toggle('in', mpp > 0.15 + i * 0.14));
  toast.classList.toggle('in', mpp > 0.62 && mpp < 0.98);

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// keep video durations ready for scrubbing
[leaveVid, morningVid].forEach(v => v && v.addEventListener('loadedmetadata', () => { v.pause(); }));
