/**
 * 黄果短剧 -> JSTV / CatPawOpen adapter
 *
 * Reverse-engineered from:
 * https://github.com/Yswag/xptv-extensions/blob/main/js/huangguo.js
 *
 * This package exposes a minimal CatPawOpen-compatible local HTTP service:
 *   GET  /config
 *   GET  /check
 *   POST /spider/huangguo/3/init
 *   POST /spider/huangguo/3/home
 *   POST /spider/huangguo/3/category
 *   POST /spider/huangguo/3/detail
 *   POST /spider/huangguo/3/play
 *   POST /spider/huangguo/3/search
 *
 * It is self-contained and only uses Node built-ins, so there are no npm dependencies.
 */

'use strict';

const http = require('http');
const https = require('https');
const zlib = require('zlib');
const crypto = require('crypto');
const { URL } = require('url');

const SITE = 'https://huangguoai.com';
const PREFIX = '/spider/huangguo/3';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const HEADERS = {
  'User-Agent': UA,
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': SITE + '/',
};

const TABS = [
  { type_name: '首页', type_id: 'home' },
  { type_name: 'AI成人短剧', type_id: 'ai-duanju' },
  { type_name: 'AI成人漫剧', type_id: 'ai-manju' },
  { type_name: 'AI换脸', type_id: 'ai-huanlian' },
  { type_name: 'AI魔改', type_id: 'ai-mogai' },
  { type_name: '排行榜', type_id: 'ranks/hot' },
];

let server = null;

// ---------- HTTP helpers ----------

function fix(u) {
  if (!u) return '';
  u = String(u).replace(/&amp;/g, '&');
  if (u.startsWith('//')) return 'https:' + u;
  if (u.startsWith('/')) return SITE + u;
  return u;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBody(buf, headers) {
  const enc = String(headers['content-encoding'] || '').toLowerCase();
  try {
    if (enc.includes('br')) return zlib.brotliDecompressSync(buf);
    if (enc.includes('gzip')) return zlib.gunzipSync(buf);
    if (enc.includes('deflate')) return zlib.inflateSync(buf);
  } catch (_) {}
  return buf;
}

function requestBuffer(url, options = {}, redirects = 0) {
  return new Promise((resolve, reject) => {
    if (redirects > 5) return reject(new Error('too many redirects'));

    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({}, HEADERS, options.headers || {});

    const req = lib.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || undefined,
        path: u.pathname + u.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const status = res.statusCode || 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          const next = new URL(res.headers.location, u).toString();
          requestBuffer(next, options, redirects + 1).then(resolve, reject);
          return;
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(Buffer.from(c)));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          const body = decodeBody(raw, res.headers || {});
          if (status < 200 || status >= 300) {
            reject(new Error('HTTP ' + status + ' for ' + url));
            return;
          }
          resolve({
            body,
            headers: res.headers || {},
            status,
            finalUrl: url,
          });
        });
      }
    );

    req.setTimeout(20000, () => req.destroy(new Error('request timeout')));
    req.on('error', reject);
    req.end();
  });
}

async function fetchHtml(url, referer) {
  const headers = referer
    ? Object.assign({}, HEADERS, { Referer: referer })
    : HEADERS;
  const r = await requestBuffer(url, { headers });
  return r.body.toString('utf8');
}

// ---------- HTML parsing copied/adapted from the XPTV source ----------

function gridSlices(html, allGrids) {
  const re = /<div\s+class="[^"]*\bhg-card-grid\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(html)) !== null) starts.push(m.index + m[0].length);
  if (!starts.length) return [];

  const slices = [];
  const n = allGrids ? starts.length : Math.min(1, starts.length);
  for (let i = 0; i < n; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : html.length;
    slices.push(html.slice(starts[i], to));
  }
  return slices;
}

function cardBlocks(slice) {
  const re = /<div\s+class="[^"]*\bhg-drama-card\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(slice)) !== null) starts.push(m.index + m[0].length);

  const blocks = [];
  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : slice.length;
    blocks.push(slice.slice(starts[i], to));
  }
  return blocks;
}

function parseCardBlock(block) {
  const a = block.match(/href="[^"]*\/detail\/(\d+)\/[^"]*"/);
  if (!a) return null;

  const vid = a[1];
  const imgM =
    block.match(/data-src="([^"]+)"/) ||
    block.match(/src="([^"]+)"/);

  let title = '';
  const t = block.match(/hg-drama-card__title[^>]*>([\s\S]*?)<\/a>/);
  if (t) title = stripTags(t[1]);

  if (!title) {
    const tt = block.match(
      /<a[^>]+href="[^"]*\/detail\/\d+\/"[^>]*>([\s\S]*?)<\/a>/
    );
    if (tt) title = stripTags(tt[1]);
  }
  if (!title) return null;

  const ep = block.match(/hg-drama-card__episode[^>]*>([\s\S]*?)<\/span>/);
  const score = block.match(/hg-drama-card__score[^>]*>([\s\S]*?)<\/span>/);
  const rem = ep ? stripTags(ep[1]) : '';
  const sc = score ? stripTags(score[1]) : '';
  const remarks = rem && sc ? rem + ' · ' + sc : rem || sc;

  return {
    vod_id: vid,
    vod_name: title,
    vod_pic: imgM ? proxyImage(fix(imgM[1])) : '',
    vod_remarks: remarks,
  };
}

function parseGridCards(html, allGrids) {
  if (!html) return [];
  const list = [];
  const seen = new Set();

  for (const slice of gridSlices(html, allGrids)) {
    for (const block of cardBlocks(slice)) {
      try {
        const item = parseCardBlock(block);
        if (!item || seen.has(item.vod_id)) continue;
        seen.add(item.vod_id);
        list.push(item);
      } catch (_) {}
    }
  }
  return list;
}

function parseRanks(html) {
  if (!html) return [];

  const listM = html.match(
    /<div\s+class="[^"]*\bhg-rank-list\b[^"]*"[^>]*>/
  );
  const from = listM ? listM.index + listM[0].length : 0;
  const slice = html.slice(from);

  const re = /<div\s+class="[^"]*\bhg-rank-item\b[^"]*"[^>]*>/g;
  const starts = [];
  let m;
  while ((m = re.exec(slice)) !== null) starts.push(m.index + m[0].length);

  const list = [];
  const seen = new Set();

  for (let i = 0; i < starts.length; i++) {
    const to = i + 1 < starts.length ? starts[i + 1] : slice.length;
    const block = slice.slice(starts[i], to);

    try {
      const a = block.match(/href="[^"]*\/detail\/(\d+)\/[^"]*"/);
      if (!a || seen.has(a[1])) continue;
      seen.add(a[1]);

      const imgM =
        block.match(/data-src="([^"]+)"/) ||
        block.match(/src="([^"]+)"/);

      let title = '';
      const t = block.match(/hg-rank-item__title[^>]*>([\s\S]*?)<\/h2>/);
      if (t) title = stripTags(t[1]);

      if (!title) {
        const tt = block.match(
          /<a[^>]+href="[^"]*\/detail\/\d+\/"[^>]*>([\s\S]*?)<\/a>/
        );
        if (tt) title = stripTags(tt[1]);
      }
      if (!title) continue;

      const tags = block.match(/hg-rank-item__tags[^>]*>([\s\S]*?)<\/div>/);

      list.push({
        vod_id: a[1],
        vod_name: title,
        vod_pic: imgM ? proxyImage(fix(imgM[1])) : '',
        vod_remarks: tags ? stripTags(tags[1]) : '',
      });
    } catch (_) {}
  }
  return list;
}

function parseEpisodes(html) {
  const tracks = [];
  const gridM = html.match(
    /<div\s+class="[^"]*\bhg-web-detail__ep-grid\b[^"]*"[^>]*>([\s\S]*?)<\/div>/
  );

  if (gridM) {
    const are = /<a\b[^>]*>[\s\S]*?<\/a>/g;
    let m;
    while ((m = are.exec(gridM[1])) !== null) {
      const tag = m[0];
      const hrefM = tag.match(/href="([^"]+)"/);
      if (!hrefM) continue;

      const eidM = tag.match(/data-ep-id="([^"]*)"/);
      const eid =
        (eidM && eidM[1]) ||
        (tag.match(/\/play\/[^/]+\/(\d+)\/?/) || [])[1] ||
        String(tracks.length + 1);

      const text = stripTags(tag);
      tracks.push({
        name: text || '第' + eid + '集',
        url: fix(hrefM[1]),
        ep: String(eid),
      });
    }
  }

  if (!tracks.length) {
    const pm = html.match(
      /<a[^>]*class="[^"]*\bhg-web-detail__play\b[^"]*"[^>]*href="([^"]+)"/
    );
    if (pm) tracks.push({ name: '第1集', url: fix(pm[1]), ep: '1' });
  }

  return tracks;
}

function parseDetailTitle(html) {
  let m = html.match(
    /<h1\b[^>]*class="[^"]*\bhg-web-detail__title\b[^"]*"[^>]*>([\s\S]*?)<\/h1>/i
  );
  if (!m) m = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!m) m = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? stripTags(m[1]).replace(/\s*[-|_].*$/, '').trim() : '';
}

function parseDetailPic(html) {
  const near = html.match(
    /hg-web-detail__[^"]*(?:cover|poster)[^"]*"[\s\S]{0,1500}?(?:data-src|src)="([^"]+)"/i
  );
  if (near) return proxyImage(fix(near[1]));

  const og = html.match(
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i
  );
  if (og) return proxyImage(fix(og[1]));
  return '';
}

function parseDetailDesc(html) {
  let m = html.match(
    /<div\b[^>]*class="[^"]*\bhg-web-detail__desc\b[^"]*"[^>]*>([\s\S]*?)<\/div>/i
  );
  if (m) return stripTags(m[1]);

  m = html.match(
    /<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i
  );
  return m ? stripTags(m[1]) : '';
}

// ---------- Play-id encoding ----------

function b64urlEncode(s) {
  return Buffer.from(String(s), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}

function makePlayId(url, ep) {
  return b64urlEncode(JSON.stringify({ url, ep: String(ep || '') }));
}

function readPlayId(id) {
  try {
    const x = JSON.parse(b64urlDecode(id));
    return { url: String(x.url || ''), ep: String(x.ep || '') };
  } catch (_) {
    return { url: String(id || ''), ep: '' };
  }
}

// ---------- Image proxy / AES decrypt ----------

const IMG_KEY = Buffer.from('f5d965df75336270', 'utf8');
const IMG_IV = Buffer.from('97b60394abc2fbe1', 'utf8');

function imageType(buf) {
  if (!buf || buf.length < 4) return '';
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf.slice(1, 4).toString('ascii') === 'PNG'
  ) return 'image/png';
  if (
    buf.length >= 12 &&
    buf.slice(0, 4).toString('ascii') === 'RIFF' &&
    buf.slice(8, 12).toString('ascii') === 'WEBP'
  ) return 'image/webp';
  if (buf.slice(0, 6).toString('ascii') === 'GIF87a' ||
      buf.slice(0, 6).toString('ascii') === 'GIF89a') return 'image/gif';
  return '';
}

function stripPkcs7(buf) {
  if (!buf || !buf.length) return buf;
  const pad = buf[buf.length - 1];
  if (pad < 1 || pad > 16 || pad > buf.length) return buf;
  for (let i = buf.length - pad; i < buf.length; i++) {
    if (buf[i] !== pad) return buf;
  }
  return buf.slice(0, buf.length - pad);
}

function trimImageEnd(buf) {
  const type = imageType(buf);
  if (type === 'image/jpeg') {
    for (let i = buf.length - 2; i >= 0; i--) {
      if (buf[i] === 0xff && buf[i + 1] === 0xd9) return buf.slice(0, i + 2);
    }
  } else if (type === 'image/png') {
    const marker = Buffer.from('49454e44ae426082', 'hex');
    const i = buf.lastIndexOf(marker);
    if (i >= 0) return buf.slice(0, i + marker.length);
  }
  return buf;
}

function decryptImageMaybe(raw) {
  if (!raw || !raw.length || raw.length % 16 !== 0) return raw;

  let pt;
  try {
    const decipher = crypto.createDecipheriv('aes-128-cbc', IMG_KEY, IMG_IV);
    decipher.setAutoPadding(false);
    pt = Buffer.concat([decipher.update(raw), decipher.final()]);
  } catch (_) {
    return raw;
  }

  if (!imageType(pt)) return raw;
  pt = stripPkcs7(pt);
  return trimImageEnd(pt);
}

function proxyImage(url) {
  if (!url || !/^https?:\/\//i.test(url)) return url || '';
  return 'js2p://_WEB_' + PREFIX + '/proxy/image/' + b64urlEncode(url);
}

// ---------- CatPaw endpoints ----------

function configResult() {
  return {
    video: {
      sites: [
        {
          key: 'nodejs_huangguo',
          name: '黄果短剧',
          type: 3,
          api: PREFIX,
          searchable: 1,
          quickSearch: 1,
          filterable: 0,
        },
      ],
    },
    read: { sites: [] },
    comic: { sites: [] },
    music: { sites: [] },
    pan: { sites: [] },
    color: [],
  };
}

async function apiInit(_) {
  return {};
}

async function apiHome(_) {
  return { class: TABS };
}

async function apiCategory(body) {
  const id = String(body.id || 'home').replace(/^\/+|\/+$/g, '');
  const page = Math.max(1, parseInt(body.page, 10) || 1);

  if (id === 'home' && page > 1) {
    return { page, pagecount: 1, limit: 0, total: 0, list: [] };
  }

  let html;
  let list;

  if (id === 'home') {
    html = await fetchHtml(SITE + '/');
    list = parseGridCards(html, true);
    return {
      page: 1,
      pagecount: 1,
      limit: list.length,
      total: list.length,
      list,
    };
  }

  const url = SITE + '/' + id + '/' + (page > 1 ? page + '/' : '');
  html = await fetchHtml(url);

  if (id.includes('rank')) list = parseRanks(html);
  else list = parseGridCards(html, false);

  return {
    page,
    pagecount: list.length ? page + 1 : page,
    limit: list.length,
    total: list.length,
    list,
  };
}

async function apiDetail(body) {
  const ids = Array.isArray(body.id) ? body.id : [body.id];
  const list = [];

  for (const rawId of ids) {
    const id = String(rawId || '').trim();
    if (!id) continue;

    const html = await fetchHtml(SITE + '/detail/' + encodeURIComponent(id) + '/');
    const tracks = parseEpisodes(html);

    const playUrl = tracks
      .map((t) => t.name + '$' + makePlayId(t.url, t.ep))
      .join('#');

    list.push({
      vod_id: id,
      vod_name: parseDetailTitle(html) || '黄果短剧',
      vod_pic: parseDetailPic(html),
      vod_content: parseDetailDesc(html),
      vod_play_from: '黄果短剧',
      vod_play_url: playUrl,
    });
  }

  return { list };
}

async function apiPlay(body) {
  const p = readPlayId(body.id);
  if (!p.url) throw new Error('empty play url');

  const html = await fetchHtml(p.url, SITE + '/');
  const m = html.match(
    /<script\b[^>]*id=["']videoInitialData["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m) throw new Error('videoInitialData not found');

  let data;
  try {
    data = JSON.parse(m[1].trim());
  } catch (e) {
    throw new Error('videoInitialData JSON parse failed');
  }

  let play = '';
  if (p.ep && data && data.epPlaySrcs) {
    play = data.epPlaySrcs[p.ep] || data.epPlaySrcs[String(p.ep)] || '';
  }
  play = play || (data && data.videoSrc) || '';

  if (play && typeof play === 'object') {
    play = play.url || play.src || '';
  }

  play = String(play || '')
    .replace(/\\u0026/g, '&')
    .replace(/&amp;/g, '&');

  if (!/^https?:\/\//i.test(play)) {
    const um = play.match(/https?:\/\/[^\s"'<>]+/i);
    play = um ? um[0] : '';
  }
  if (!play) throw new Error('play url not found');

  return {
    parse: 0,
    url: play,
    header: {
      'User-Agent': UA,
      'Referer': SITE + '/',
    },
  };
}

async function apiSearch(body) {
  const wd = String(body.wd || body.text || '').trim();
  const page = Math.max(1, parseInt(body.page, 10) || 1);

  if (!wd) {
    return { page, pagecount: 1, limit: 0, total: 0, list: [] };
  }

  // The original XPTV extension uses this exact search route.
  const url = SITE + '/search/video/' + encodeURIComponent(wd) + '/';
  const html = await fetchHtml(url);
  const list = parseGridCards(html, true);

  return {
    page,
    pagecount: 1,
    limit: list.length,
    total: list.length,
    list,
  };
}

// ---------- Local server ----------

function sendJson(res, status, obj) {
  const data = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': data.length,
    'Cache-Control': 'no-store',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;

    req.on('data', (c) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(Buffer.from(c));
    });

    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (_) {
        resolve({});
      }
    });

    req.on('error', reject);
  });
}

async function handleProxyImage(req, res, pathname) {
  const token = pathname.slice((PREFIX + '/proxy/image/').length);
  if (!token) {
    res.writeHead(404);
    res.end();
    return;
  }

  let imageUrl;
  try {
    imageUrl = b64urlDecode(token);
  } catch (_) {
    res.writeHead(400);
    res.end();
    return;
  }

  if (!/^https?:\/\//i.test(imageUrl)) {
    res.writeHead(400);
    res.end();
    return;
  }

  const r = await requestBuffer(imageUrl, {
    headers: Object.assign({}, HEADERS, {
      'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
      'Referer': SITE + '/',
    }),
  });

  const out = decryptImageMaybe(r.body);
  const type =
    imageType(out) ||
    String(r.headers['content-type'] || 'application/octet-stream').split(';')[0];

  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': out.length,
    'Cache-Control': 'public, max-age=3600',
  });
  res.end(out);
}

async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://127.0.0.1');
    const path = u.pathname;

    if (req.method === 'GET' && path === '/check') {
      sendJson(res, 200, { run: true });
      return;
    }

    if (req.method === 'GET' && path === '/config') {
      sendJson(res, 200, configResult());
      return;
    }

    if (req.method === 'GET' && path.startsWith(PREFIX + '/proxy/image/')) {
      await handleProxyImage(req, res, path);
      return;
    }

    if (req.method !== 'POST' || !path.startsWith(PREFIX + '/')) {
      sendJson(res, 404, { error: 'not found' });
      return;
    }

    const body = await readJson(req);
    const action = path.slice((PREFIX + '/').length);

    let result;
    switch (action) {
      case 'init':
        result = await apiInit(body);
        break;
      case 'home':
        result = await apiHome(body);
        break;
      case 'category':
        result = await apiCategory(body);
        break;
      case 'detail':
        result = await apiDetail(body);
        break;
      case 'play':
        result = await apiPlay(body);
        break;
      case 'search':
        result = await apiSearch(body);
        break;
      default:
        sendJson(res, 404, { error: 'unknown action: ' + action });
        return;
    }

    sendJson(res, 200, result);
  } catch (e) {
    console.error('[huangguo]', e && e.stack ? e.stack : e);
    sendJson(res, 500, {
      error: e && e.message ? e.message : String(e),
    });
  }
}

async function start(config) {
  if (server) {
    try {
      server.close();
    } catch (_) {}
    server = null;
  }

  if (typeof globalThis.catServerFactory !== 'function') {
    throw new Error('catServerFactory is unavailable: this file must run inside CatPaw/JSTV runtime');
  }

  server = globalThis.catServerFactory(handler);
  server.listen({ port: 0, host: '127.0.0.1' });
}

async function stop() {
  if (server) {
    try {
      server.close();
    } catch (_) {}
  }
  server = null;
}

exports.start = start;
exports.stop = stop;
