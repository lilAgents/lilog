// lilOG: scan a live URL for its real meta tags, preview the cards across
// platforms, tweak the values, and copy a clean head block.
// The scan runs through /.netlify/functions/og-fetch (browsers can't read
// cross-origin HTML); everything else is client-side.

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

/* ---------- theme (OS-aware, matches the family) ---------- */
const MOON_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path fill="currentColor" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>';
const SUN_SVG = '<svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4l1.4-1.4M18 6l1.4-1.4"/></g></svg>';

function setThemeIcon(btn, theme) {
  if (theme === 'dark') {
    btn.innerHTML = SUN_SVG;
    btn.setAttribute('aria-label', 'Switch to light mode');
  } else {
    btn.innerHTML = MOON_SVG;
    btn.setAttribute('aria-label', 'Switch to dark mode');
  }
}

function initTheme() {
  const btn = $('#ui-theme-btn');
  const current = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
  setThemeIcon(btn, current());
  btn.addEventListener('click', () => {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem('lilog-theme', next); } catch (e) { /* storage may be unavailable; safe to ignore */ }
    setThemeIcon(btn, next);
  });
}

/* ---------- helpers ---------- */
const esc = (s) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function domainOf(url) {
  if (!url) return 'example.com';
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : 'https://' + url);
    return u.hostname.replace(/^www\./, '');
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0] || 'example.com';
  }
}

const ICON = {
  err: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6M9 9l6 6"/></svg>',
  warn: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.8 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.8a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>',
  ok: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
};

/* ---------- image state (URL probe + local upload) ---------- */
const imgState = { url: '', ok: false, w: 0, h: 0, loading: false };
const upload = { active: false, url: '', name: '' };
let imgTimer = 0;

function previewSrc() {
  if (upload.active) return upload.url;
  return imgState.ok || imgState.loading ? imgState.url : '';
}

function applyImage() {
  const src = previewSrc();
  $$('[data-img]').forEach((el) => { el.src = src || ''; });
  $$('.og-imgwrap').forEach((w) => w.classList.toggle('is-empty', !src));
}

function loadImage(url) {
  imgState.url = url;
  if (!url) {
    imgState.ok = false; imgState.w = 0; imgState.h = 0; imgState.loading = false;
    applyImage(); render();
    return;
  }
  imgState.ok = false; imgState.loading = true;
  applyImage();
  const probe = new Image();
  probe.onload = () => {
    if (imgState.url !== url) return;
    imgState.ok = true; imgState.loading = false;
    imgState.w = probe.naturalWidth; imgState.h = probe.naturalHeight;
    applyImage(); render();
  };
  probe.onerror = () => {
    if (imgState.url !== url) return;
    imgState.ok = false; imgState.loading = false; imgState.w = 0; imgState.h = 0;
    applyImage(); render();
  };
  probe.src = url;
}

function setUpload(file) {
  if (upload.url) { try { URL.revokeObjectURL(upload.url); } catch (e) { /* storage may be unavailable; safe to ignore */ } }
  upload.active = true;
  upload.url = URL.createObjectURL(file);
  upload.name = file.name;
  $('#upload-name').textContent = upload.name;
  $('#upload-chip').classList.remove('is-hidden');
  const probe = new Image();
  probe.onload = () => {
    upload.w = probe.naturalWidth; upload.h = probe.naturalHeight;
    applyImage(); render();
  };
  probe.src = upload.url;
  applyImage(); render();
}

function clearUpload() {
  if (upload.url) { try { URL.revokeObjectURL(upload.url); } catch (e) { /* storage may be unavailable; safe to ignore */ } }
  upload.active = false; upload.url = ''; upload.name = ''; upload.w = 0; upload.h = 0;
  $('#upload-chip').classList.add('is-hidden');
  $('#f-upload').value = '';
  applyImage(); render();
}

function imgDims() {
  if (upload.active) return { ok: !!upload.w, w: upload.w || 0, h: upload.h || 0, loading: false };
  return imgState;
}

/* ---------- scan ---------- */
function scanNote(kind, msg) {
  const el = $('#scan-note');
  el.textContent = msg;
  el.className = 'scan-note' + (kind ? ' scan-note--' + kind : '');
}

async function runScan() {
  const raw = $('#scan-url').value.trim();
  if (!raw) { $('#scan-url').focus(); return; }
  const btn = $('#scan-btn');
  btn.disabled = true;
  scanNote('busy', 'Scanning ' + raw + ' …');
  try {
    const res = await fetch('/.netlify/functions/og-fetch?url=' + encodeURIComponent(raw), {
      headers: { accept: 'application/json' },
    });
    const d = await res.json();
    if (d.error) { scanNote('err', d.error); return; }
    clearUpload();
    $('#f-title').value = d.ogTitle || d.pageTitle || '';
    $('#f-desc').value = d.ogDescription || d.description || '';
    $('#f-image').value = d.ogImage || d.twitterImage || '';
    $('#f-url').value = d.ogUrl || d.url || '';
    $('#f-site').value = d.ogSiteName || '';
    loadImage($('#f-image').value.trim());
    render();
    const found = [d.ogTitle && 'og:title', d.ogDescription && 'og:description', d.ogImage && 'og:image', d.ogSiteName && 'og:site_name'].filter(Boolean);
    scanNote('ok', found.length
      ? `Pulled tags from ${domainOf(d.url)} (${found.join(', ')}). Tweak anything below.`
      : `Scanned ${domainOf(d.url)}, but it has no Open Graph tags. The fields show what platforms would fall back to.`);
  } catch (e) {
    scanNote('err', 'Could not reach the scanner. If you are running locally without Netlify, the scan function is unavailable.');
  } finally {
    btn.disabled = false;
  }
}

/* ---------- inspector ---------- */
function buildChecks() {
  const title = $('#f-title').value.trim();
  const desc = $('#f-desc').value.trim();
  const url = $('#f-url').value.trim();
  const site = $('#f-site').value.trim();
  const img = $('#f-image').value.trim();
  const c = [];

  if (!title) c.push({ t: 'warn', h: 'No title yet', m: 'Add a title so every platform has a headline to show.' });
  else if (title.length <= 60) c.push({ t: 'ok', h: 'Title length looks good', m: `${title.length} characters, within the ~60 most platforms show in full.` });
  else c.push({ t: 'warn', h: 'Title is on the long side', m: `${title.length} characters. X and LinkedIn usually trim past ~60.` });

  if (!desc) c.push({ t: 'warn', h: 'No description yet', m: 'Facebook and WhatsApp show a description under the title.' });
  else if (desc.length <= 125) c.push({ t: 'ok', h: 'Description length looks good', m: `${desc.length} characters, within the ~125 most previews show.` });
  else c.push({ t: 'warn', h: 'Description is a bit long', m: `${desc.length} characters. Mobile previews often cut off near 125.` });

  const d = imgDims();
  if (upload.active) {
    if (d.ok) {
      const r = d.w / d.h;
      if (d.w === 1200 && d.h === 630) c.push({ t: 'ok', h: 'Uploaded image size is perfect', m: '1200x630, the size every major platform expects.' });
      else if (Math.abs(r - 1.91) <= 0.06) c.push({ t: 'ok', h: 'Uploaded image ratio looks right', m: `${d.w}x${d.h}. The shape is right; 1200x630 is the sharpest target.` });
      else c.push({ t: 'warn', h: 'Uploaded image may get cropped', m: `${d.w}x${d.h} (${r.toFixed(2)}:1). Platforms crop toward ~1.91:1 (1200x630).` });
    }
    c.push({ t: 'warn', h: 'Uploaded image is preview-only', m: 'It lives in your browser. Host it on your site and paste its URL so platforms can fetch it.' });
  } else if (!img) {
    c.push({ t: 'err', h: 'No image set', m: 'Most platforms need an og:image to show a rich card instead of a plain link.' });
  } else if (d.loading) {
    c.push({ t: 'warn', h: 'Checking the image', m: 'Loading the image to read its size.' });
  } else if (!d.ok) {
    c.push({ t: 'err', h: 'Image could not load', m: 'That URL did not return an image. Check the link is public and correct.' });
  } else {
    const r = d.w / d.h;
    if (d.w === 1200 && d.h === 630) c.push({ t: 'ok', h: 'Image size is perfect', m: '1200x630, the size every major platform expects.' });
    else if (Math.abs(r - 1.91) <= 0.06) c.push({ t: 'ok', h: 'Image ratio looks right', m: `${d.w}x${d.h}. The shape is right; 1200x630 is the sharpest target.` });
    else c.push({ t: 'warn', h: 'Image may get cropped', m: `${d.w}x${d.h} (${r.toFixed(2)}:1). Platforms crop toward ~1.91:1 (1200x630).` });
  }

  if (site) c.push({ t: 'ok', h: 'Site name is set', m: `"${site}" shows as the eyebrow on Discord and a few others.` });
  else c.push({ t: 'warn', h: 'No site name', m: 'Add og:site_name to show your brand above the title on Discord.' });

  if (url) c.push({ t: 'ok', h: 'Page URL is set', m: `Previews will show ${domainOf(url)} as the source.` });
  else c.push({ t: 'warn', h: 'No page URL', m: 'Add the page URL so previews show your real domain.' });

  c.push({ t: 'ok', h: 'X uses a large image', m: 'The generated tags set twitter:card to summary_large_image, so X shows the image full width.' });

  return c;
}

function renderInspector() {
  const checks = buildChecks();
  const n = { err: 0, warn: 0, ok: 0 };
  checks.forEach((x) => { n[x.t]++; });
  $('#n-err').textContent = n.err;
  $('#n-warn').textContent = n.warn;
  $('#n-ok').textContent = n.ok;
  $('#insp-list').innerHTML = checks
    .map(
      (x) =>
        `<div class="insp-item insp--${x.t}"><span class="insp-ic">${ICON[x.t]}</span><div><div class="insp-item__t">${x.h}</div><div class="insp-item__m">${x.m}</div></div></div>`
    )
    .join('');
}

/* ---------- head-block generator ---------- */
function genHtml() {
  const title = $('#f-title').value.trim();
  const desc = $('#f-desc').value.trim();
  const url = $('#f-url').value.trim();
  const site = $('#f-site').value.trim();
  const img = $('#f-image').value.trim();
  const L = [];
  if (title) L.push(`<title>${esc(title)}</title>`);
  if (desc) L.push(`<meta name="description" content="${esc(desc)}" />`);
  L.push('');
  L.push('<!-- Open Graph -->');
  L.push('<meta property="og:type" content="website" />');
  if (site) L.push(`<meta property="og:site_name" content="${esc(site)}" />`);
  if (title) L.push(`<meta property="og:title" content="${esc(title)}" />`);
  if (desc) L.push(`<meta property="og:description" content="${esc(desc)}" />`);
  if (url) L.push(`<meta property="og:url" content="${esc(url)}" />`);
  if (img) L.push(`<meta property="og:image" content="${esc(img)}" />`);
  L.push('');
  L.push('<!-- Twitter -->');
  L.push('<meta name="twitter:card" content="summary_large_image" />');
  if (title) L.push(`<meta name="twitter:title" content="${esc(title)}" />`);
  if (desc) L.push(`<meta name="twitter:description" content="${esc(desc)}" />`);
  if (img) L.push(`<meta name="twitter:image" content="${esc(img)}" />`);
  return L.join('\n');
}

/* ---------- card text ---------- */
function setField(name, value) {
  $$(`[data-field="${name}"]`).forEach((el) => { el.textContent = value; });
}

function renderCards() {
  const title = $('#f-title').value.trim();
  const desc = $('#f-desc').value.trim();
  const url = $('#f-url').value.trim();
  const site = $('#f-site').value.trim();

  setField('title', title || 'Your title here');
  setField('desc', desc || 'Your description preview shows up right here.');
  setField('domain', domainOf(url));

  $$('[data-site-eyebrow]').forEach((el) => {
    el.textContent = site;
    el.classList.toggle('is-hidden', !site);
  });
}

/* ---------- counts ---------- */
function renderCounts() {
  const title = $('#f-title').value.trim();
  const desc = $('#f-desc').value.trim();
  const img = $('#f-image').value.trim();

  const tc = $('#title-count');
  tc.textContent = title ? `${title.length} chars` : '';
  tc.className = 'count ' + (title.length > 60 ? 'count--warn' : 'count--ok');

  const dc = $('#desc-count');
  dc.textContent = desc ? `${desc.length} chars` : '';
  dc.className = 'count ' + (desc.length > 125 ? 'count--warn' : 'count--ok');

  const ic = $('#img-count');
  const d = imgDims();
  if (upload.active) {
    ic.textContent = d.ok ? `uploaded · ${d.w}x${d.h}` : 'uploaded';
    ic.className = 'count count--ok';
  } else if (!img) { ic.textContent = ''; ic.className = 'count'; }
  else if (d.loading) { ic.textContent = 'checking…'; ic.className = 'count'; }
  else if (!d.ok) { ic.textContent = 'no image'; ic.className = 'count count--warn'; }
  else {
    const perfect = d.w === 1200 && d.h === 630;
    const ratioOk = Math.abs(d.w / d.h - 1.91) <= 0.06;
    ic.textContent = `${d.w}x${d.h}`;
    ic.className = 'count ' + (perfect || ratioOk ? 'count--ok' : 'count--warn');
  }
}

/* ---------- master render ---------- */
function render() {
  renderCards();
  renderCounts();
  renderInspector();
  $('#og-code').textContent = genHtml();
}

/* ---------- actions ---------- */
function flash(btn, label) {
  const prev = btn.textContent;
  btn.textContent = label;
  btn.classList.add('btn--done');
  setTimeout(() => { btn.textContent = prev; btn.classList.remove('btn--done'); }, 1100);
}

function copyHtml(btn) {
  const text = $('#og-code').textContent;
  if (!text) return;
  const done = () => flash(btn, 'Copied');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => fallbackCopy(text, done));
  } else {
    fallbackCopy(text, done);
  }
}
function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } catch (e) { /* storage may be unavailable; safe to ignore */ }
  document.body.removeChild(ta); done();
}

/* ---------- example ---------- */
const EXAMPLE = {
  title: 'Acme Studio | Brand & Web Design for Teams',
  desc: 'We craft brands and build fast, modern websites that help teams launch and grow without the bloat.',
  image: '/sample-og.svg',
  url: 'https://acme.studio',
  site: 'Acme Studio',
};

function fill(values) {
  $('#f-title').value = values.title;
  $('#f-desc').value = values.desc;
  $('#f-image').value = values.image;
  $('#f-url').value = values.url;
  $('#f-site').value = values.site;
  loadImage(values.image);
}

/* ---------- tabs ---------- */
function showTab(name) {
  $$('.og-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  $$('.og-slot').forEach((s) => s.classList.toggle('is-shown', s.dataset.card === name));
}

/* ---------- wire-up ---------- */
function initOg() {
  initTheme();

  $('#scan-form').addEventListener('submit', (e) => { e.preventDefault(); runScan(); });

  ['f-title', 'f-desc', 'f-url', 'f-site'].forEach((id) =>
    $('#' + id).addEventListener('input', render));

  $('#f-image').addEventListener('input', (e) => {
    if (upload.active) clearUpload();
    renderCounts();
    clearTimeout(imgTimer);
    const val = e.target.value.trim();
    imgState.loading = !!val;
    imgTimer = setTimeout(() => loadImage(val), 350);
  });

  $('#upload-btn').addEventListener('click', () => $('#f-upload').click());
  $('#f-upload').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setUpload(f);
  });
  $('#upload-clear').addEventListener('click', clearUpload);

  $$('.og-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  $('#ex-btn').addEventListener('click', () => { clearUpload(); fill(EXAMPLE); render(); });
  $('#clear-btn').addEventListener('click', () => {
    clearUpload();
    fill({ title: '', desc: '', image: '', url: '', site: '' });
    $('#scan-url').value = '';
    $('#f-title').focus();
    render();
  });
  $('#og-copy').addEventListener('click', (e) => copyHtml(e.currentTarget));

  // Start on the example so the cards look alive; a scan replaces everything.
  fill(EXAMPLE);
  render();
}

export { initOg };
