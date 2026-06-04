// lilOG meta fetcher.
// Fetches a live page server-side (browsers can't read cross-origin HTML) and
// returns its title, description, Open Graph, and Twitter card tags.

const MAX_HOPS = 5;
const TIMEOUT_MS = 9000;
const MAX_BYTES = 600000;

// Block local / private / link-local targets (basic SSRF guard), checked on
// every hop since a public URL can redirect to a private one.
function isBlockedHost(hostname) {
  const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local')) return true;
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = +m[1], b = +m[2];
    if (a === 0 || a === 127 || a === 10) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
  }
  return false;
}

const NAMED_ENTITIES = {
  quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', middot: '·',
  mdash: '—', ndash: '–', hellip: '…', bull: '•',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  copy: '©', reg: '®', trade: '™', amp: '&',
};

function decodeEntities(s) {
  return String(s)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
}

function parseMeta(html, baseUrl) {
  const metas = {};
  const tagRe = /<meta\b[^>]*>/gi;
  const attrRe = /([a-zA-Z][a-zA-Z0-9:_-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let t;
  while ((t = tagRe.exec(html))) {
    const attrs = {};
    let a;
    attrRe.lastIndex = 0;
    while ((a = attrRe.exec(t[0]))) attrs[a[1].toLowerCase()] = a[2] !== undefined ? a[2] : a[3];
    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key && attrs.content !== undefined && !(key in metas)) metas[key] = decodeEntities(attrs.content);
  }
  const tm = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const pageTitle = tm ? decodeEntities(tm[1].trim().replace(/\s+/g, ' ')) : '';

  const abs = (u) => {
    if (!u) return '';
    try { return new URL(u, baseUrl).toString(); } catch { return u; }
  };

  return {
    pageTitle,
    description: metas['description'] || '',
    ogTitle: metas['og:title'] || '',
    ogDescription: metas['og:description'] || '',
    ogImage: abs(metas['og:image'] || metas['og:image:url'] || ''),
    ogSiteName: metas['og:site_name'] || '',
    ogUrl: abs(metas['og:url'] || ''),
    ogType: metas['og:type'] || '',
    twitterCard: metas['twitter:card'] || '',
    twitterTitle: metas['twitter:title'] || '',
    twitterDescription: metas['twitter:description'] || '',
    twitterImage: abs(metas['twitter:image'] || metas['twitter:image:src'] || ''),
  };
}

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(obj),
});

export const handler = async (event) => {
  const raw = (event.queryStringParameters && event.queryStringParameters.url || '').trim();
  if (!raw) return json(400, { error: 'Enter a URL to scan.' });
  const start = /^https?:\/\//i.test(raw) ? raw : 'https://' + raw;

  let u;
  try { u = new URL(start); } catch { return json(400, { error: 'That does not look like a valid URL.' }); }
  if (!/^https?:$/.test(u.protocol)) return json(400, { error: 'Only http and https URLs can be scanned.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let current = u.toString();
  let resp = null;

  try {
    for (let i = 0; i < MAX_HOPS; i++) {
      const host = (() => { try { return new URL(current).hostname; } catch { return ''; } })();
      if (isBlockedHost(host)) { clearTimeout(timer); return json(400, { error: 'For safety, local and private addresses cannot be scanned.' }); }
      let r;
      try {
        r = await fetch(current, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'user-agent': 'Mozilla/5.0 (compatible; lilOG/1.0; +https://lilog.netlify.app)',
            accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          },
        });
      } catch (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') return json(504, { error: 'The page took too long to respond.' });
        return json(502, { error: 'Could not reach that URL. Check the link and try again.' });
      }
      const loc = r.headers.get('location');
      if (r.status >= 300 && r.status < 400 && loc) {
        try { current = new URL(loc, current).toString(); } catch { current = loc; }
        continue;
      }
      resp = r;
      break;
    }
  } finally {
    clearTimeout(timer);
  }

  if (!resp) return json(502, { error: 'Too many redirects while loading that page.' });
  if (resp.status >= 400) return json(502, { error: `The page responded with HTTP ${resp.status}.` });

  const ctype = (resp.headers.get('content-type') || '').toLowerCase();
  if (ctype && !ctype.includes('html')) {
    return json(422, { error: `That URL returned ${ctype.split(';')[0]}, not an HTML page.` });
  }

  let html = '';
  try { html = (await resp.text()).slice(0, MAX_BYTES); }
  catch { return json(502, { error: 'Could not read the page contents.' }); }

  return json(200, { url: current, ...parseMeta(html, current) });
};
