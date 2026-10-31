// layla-mcp-search v2 — MCP server: web search, news, page reading, GitHub read/write (safe branch)
// Works with Layla (Streamable HTTP on POST /sse) and Google AI Edge Gallery.
import express from 'express';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

const VERSION = '2.4.0';

// ============================ CONFIG ============================
const app = express();
app.disable('x-powered-by');
const port = process.env.PORT || 3000;

const BRAVE_API_KEY = process.env.BRAVE_API_KEY;
const MCP_API_KEY = process.env.MCP_API_KEY; // نفس القيمة اللي في خانة Bearer في Layla
const GITHUB_TOKEN = process.env.GITHUB_TOKEN; // اختياري: بدونه أدوات GitHub مش بتظهر

const csv = (v, d = '') => String(v ?? d).split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
const GITHUB_ALLOWED_OWNERS = csv(process.env.GITHUB_ALLOWED_OWNERS, 'newmyacc13-rgb'); // مين مسموح يتقري منه
const GITHUB_WRITE_REPOS = csv(process.env.GITHUB_WRITE_REPOS); // owner/name — الكتابة معطلة لو فاضي
const WRITE_BRANCH = 'layla-edits'; // الكتابة دايماً هنا، مش main
const RESULT_REMINDER = String(process.env.RESULT_REMINDER || '').trim().slice(0, 600); // تذكير قصير بيتضاف آخر كل نتيجة بحث/قراءة
const JINA_API_KEY = process.env.JINA_API_KEY; // اختياري: يرفع حد الطلبات على Jina Reader
const JINA_FALLBACK = String(process.env.JINA_FALLBACK || 'on').toLowerCase() !== 'off'; // off = مفيش خدمة خارجية

if (!MCP_API_KEY) {
  console.error('MCP_API_KEY is missing - refusing to start without authentication.');
  process.exit(1);
}
if (!BRAVE_API_KEY) console.warn('⚠️ BRAVE_API_KEY missing: search tools will return errors.');
process.on('unhandledRejection', (e) => console.error('Unhandled rejection:', e));
process.on('SIGTERM', () => process.exit(0));

// ============================ HELPERS START ============================
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

// ---------- مواقع موثوقة (بتتقدّم في ترتيب النتايج، من غير ما تستبعد الباقي) ----------
const TRUSTED_DEV = [
  'developer.mozilla.org', 'nodejs.org', 'github.com', 'raw.githubusercontent.com',
  'stackoverflow.com', 'stackexchange.com', 'docs.python.org', 'pypi.org', 'npmjs.com',
  'expressjs.com', 'react.dev', 'nextjs.org', 'vuejs.org', 'angular.dev', 'typescriptlang.org',
  'tailwindcss.com', 'developer.android.com', 'kotlinlang.org', 'learn.microsoft.com',
  'go.dev', 'pkg.go.dev', 'doc.rust-lang.org', 'docs.rs', 'cppreference.com',
  'docs.docker.com', 'kubernetes.io', 'postgresql.org', 'sqlite.org', 'redis.io',
  'fastapi.tiangolo.com', 'flask.palletsprojects.com', 'djangoproject.com',
  'modelcontextprotocol.io', 'huggingface.co', 'pytorch.org', 'numpy.org', 'pandas.pydata.org',
  'web.dev', 'readthedocs.io', 'docs.oracle.com', 'openjdk.org', 'spring.io'
];
const TRUSTED_GENERAL = [
  'wikipedia.org', 'britannica.com', 'reuters.com', 'apnews.com', 'bbc.com', 'bbc.co.uk',
  'aljazeera.com', 'aljazeera.net', 'npr.org', 'theguardian.com', 'dw.com', 'france24.com',
  'bloomberg.com', 'ft.com', 'nytimes.com', 'wsj.com', 'economist.com',
  'nature.com', 'science.org', 'arxiv.org', 'who.int', 'un.org', 'worldbank.org', 'imf.org',
  'europa.eu', 'nasa.gov', 'nih.gov', 'cdc.gov'
];
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } };
const matchesList = (u, list) => { const h = hostOf(u); return list.some(d => h === d || h.endsWith('.' + d)); };
const isTrustedDev = (u) => matchesList(u, TRUSTED_DEV);
const isTrustedGeneral = (u) => matchesList(u, TRUSTED_GENERAL) || /\.(gov|edu)(\.[a-z]{2})?$/.test(hostOf(u));

// ---------- تنظيف النصوص ----------
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)); } catch { return ''; } })
    .replace(/&amp;/g, '&');
}
const stripTags = (s) => decodeEntities(String(s || '').replace(/<[^>]+>/g, ''));

function htmlToText(html) {
  const title = (/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1];
  const body = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|head|nav|header|footer|aside)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => '\n' + '#'.repeat(Number(n)) + ' ')
    .replace(/<\/(p|div|li|h[1-6]|pre|tr|br|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  return (title ? `Title: ${decodeEntities(title).trim()}\n\n` : '') + text;
}

function extractLinks(html, baseUrl, max = 30) {
  const seen = new Set(); const out = [];
  const re = /<a\s[^>]*href=["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    let href;
    try { href = new URL(decodeEntities(m[1]), baseUrl); } catch { continue; }
    if (!/^https?:$/.test(href.protocol)) continue;
    href.hash = '';
    const link = href.toString();
    if (seen.has(link)) continue;
    seen.add(link);
    const label = stripTags(m[2]).replace(/\s+/g, ' ').trim().slice(0, 70) || '(no text)';
    out.push(`- ${label}: ${link}`);
  }
  return out;
}

// ---------- حماية SSRF: أي موقع عام مسموح، والشبكات الداخلية ممنوعة ----------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const m4 = x.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (m4) return isPrivateIp(m4[1]);
    const mh = x.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mh) { const hi = parseInt(mh[1], 16), lo = parseInt(mh[2], 16); return isPrivateIp(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`); }
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;
}

async function assertPublicHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error('This host is not allowed');
  }
  if (net.isIP(h)) {
    if (isPrivateIp(h)) throw new Error('This host is not allowed');
    return;
  }
  let addrs;
  try { addrs = await dns.lookup(h, { all: true }); } catch { throw new Error('Could not resolve host'); }
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('This host is not allowed');
}

async function readCapped(res, type, maxBytes) {
  const cs = /charset=([\w-]+)/i.exec(type || '');
  let decoder;
  try { decoder = new TextDecoder(cs ? cs[1] : 'utf-8'); } catch { decoder = new TextDecoder('utf-8'); }
  const reader = res.body.getReader();
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value)); total += value.length;
    if (total >= maxBytes) { await reader.cancel().catch(() => {}); break; }
  }
  return decoder.decode(Buffer.concat(chunks));
}

const TEXT_TYPE = /^(text\/|application\/(json|ld\+json|xml|xhtml\+xml|javascript|x-javascript))/;
async function safeFetch(url, maxBytes = 1_500_000) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const u = new URL(current);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http(s) URLs are allowed');
    await assertPublicHost(u.hostname);
    const res = await fetch(u, {
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; LaylaMCP/2.0; +https://github.com)',
        Accept: 'text/html,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5',
        'Accept-Language': 'en,ar;q=0.8'
      },
      signal: AbortSignal.timeout(15000)
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) { current = new URL(loc, u).toString(); continue; }
    if (!res.ok) {
      const e = new Error(`Page error: ${res.status}`);
      e.fallback = [403, 429, 451, 503].includes(res.status); // الموقع بيحجب البوتات: جرّب القارئ الخارجي
      throw e;
    }
    const type = (res.headers.get('content-type') || '').toLowerCase();
    if (type && !TEXT_TYPE.test(type)) {
      const e = new Error(`Unsupported content type: ${type.split(';')[0]} (PDF and images need the reader fallback)`);
      e.fallback = true;
      e.isImage = type.startsWith('image/');
      throw e;
    }
    return { finalUrl: u.toString(), type, raw: await readCapped(res, type, maxBytes) };
  }
  throw new Error('Too many redirects');
}

const PAGE_CHUNK = 6000;

// قص عند نهاية سطر بدل نص الكلمة
function sliceChunk(text, start) {
  let end = Math.min(text.length, start + PAGE_CHUNK);
  if (end < text.length) {
    const nl = text.lastIndexOf('\n', end);
    if (nl > start + PAGE_CHUNK * 0.6) end = nl + 1;
  }
  return { chunk: text.slice(start, end), next: end };
}

// فهرس العناوين (# ...) مع مكان كل عنوان، علشان الموديل يقفز للجزء المطلوب
function buildOutline(text, max = 25) {
  const out = []; let pos = 0;
  for (const line of text.split('\n')) {
    const m = /^(#{1,6})\s+(.+)/.exec(line);
    if (m && out.length < max) out.push(`${pos}: ${'  '.repeat(m[1].length - 1)}${m[2].trim().slice(0, 80)}`);
    pos += line.length + 1;
  }
  return out;
}

// بحث داخل الصفحة: يرجّع الفقرات اللي فيها الكلمات المطلوبة فقط
function findSnippets(text, query, { radius = 300, max = 5 } = {}) {
  const terms = [...new Set(String(query).toLowerCase().split(/\s+/).filter(t => t.length >= 2))];
  if (!terms.length) return [];
  const lower = text.toLowerCase();
  const hits = [];
  for (const t of terms) {
    let i = lower.indexOf(t), n = 0;
    while (i !== -1 && n < 10) { hits.push(i); i = lower.indexOf(t, i + t.length); n++; }
  }
  hits.sort((x, y) => x - y);
  const spans = [];
  for (const h of hits) {
    const st = Math.max(0, h - radius), en = Math.min(text.length, h + radius);
    const last = spans[spans.length - 1];
    if (last && st <= last.e) last.e = Math.max(last.e, en); else spans.push({ s: st, e: en });
  }
  return spans.slice(0, max).map(({ s: st, e: en }) => ({ offset: st, text: text.slice(st, en).trim() }));
}

// قارئ خارجي (Jina Reader): بيشغّل JavaScript ويقرا PDF ويوصف الصور. الرابط بيروح لجهة خارجية.
async function jinaRead(url, { images = false } = {}) {
  const headers = {};
  if (images) headers['X-With-Generated-Alt'] = 'true';
  if (JINA_API_KEY) headers.Authorization = `Bearer ${JINA_API_KEY}`;
  const res = await fetch(`https://r.jina.ai/${url}`, { headers, signal: AbortSignal.timeout(40000) });
  if (!res.ok) throw new Error(`Reader error: ${res.status}`);
  return readCapped(res, res.headers.get('content-type') || '', 1_500_000);
}

async function readPage(url, { offset = 0, links = false, find = '', render = 'auto', images = false } = {}) {
  if (!url) throw new Error('url is required');
  if (!['auto', 'direct', 'jina'].includes(render)) throw new Error('render must be auto, direct or jina');
  if ((render === 'jina' || images) && !JINA_FALLBACK) throw new Error('The reader fallback is disabled on this server');

  let text = '', finalUrl = url, source = 'direct', linkList = [], directError = null, wantImages = images;
  if (render !== 'jina' && !images) {
    try {
      const r = await safeFetch(url);
      finalUrl = r.finalUrl;
      const isHtml = /html|xml/.test(r.type) || /^\s*<(!doctype|html)/i.test(r.raw);
      text = isHtml ? htmlToText(r.raw) : r.raw;
      if (isHtml && links) linkList = extractLinks(r.raw, finalUrl);
    } catch (e) { directError = e; }
  }
  const tiny = text.replace(/\s/g, '').length < 200; // صفحة فاضية غالباً بتعتمد على JavaScript
  const useReader = render === 'jina' || images || (render === 'auto' && (directError ? directError.fallback : tiny));
  if (useReader && JINA_FALLBACK) {
    const u = new URL(url);
    if (u.protocol === 'https:' || u.protocol === 'http:') {
      await assertPublicHost(u.hostname); // نفس الحماية قبل ما الرابط يروح لأي جهة
      if (directError?.isImage) wantImages = true;
      try {
        text = await jinaRead(u.toString(), { images: wantImages });
        source = 'reader'; linkList = []; directError = null; finalUrl = u.toString();
      } catch (e) { if (directError) throw directError; /* وإلا نكمل بالنص الضعيف */ }
    }
  }
  if (directError) throw directError;

  const total = text.length;
  const head = `URL: ${finalUrl}${source === 'reader' ? ' (via reader: JavaScript rendered)' : ''}\n`;
  if (!text.trim()) return `${head}\n(No readable text: the page may need a login, block bots, or be empty.)`;

  if (find) {
    const snips = findSnippets(text, find);
    if (!snips.length) return `${head}\nNo match for "${find}" in this page (${total} chars). Try other words, or read from offset=0.`;
    return `${head}\nMatches for "${find}":\n\n${snips.map(x => `[offset ${x.offset}]\n${x.text}`).join('\n\n---\n\n')}`;
  }
  const start = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), total);
  const { chunk, next } = sliceChunk(text, start);
  let out = `${head}Total chars: ${total}\n\n${chunk}`;
  if (next < total) out += `\n\n[...${total - next} more chars. Continue with offset=${next}, or use find="keywords" to jump to a topic]`;
  if (start === 0 && total > PAGE_CHUNK) {
    const outline = buildOutline(text);
    if (outline.length) out += `\n\nOutline (offset: heading):\n${outline.join('\n')}`;
  }
  if (linkList.length) out += `\n\nLinks on this page:\n${linkList.join('\n')}`;
  return out;
}

// ---------- Brave Search ----------
const FRESHNESS = new Set(['pd', 'pw', 'pm', 'py']);
function normalizeDomain(site) {
  const h = (/^[a-z]+:\/\//i.test(site) ? hostOf(site) : site.toLowerCase().trim()).replace(/^www\./, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(h)) throw new Error('site must be a domain like example.com');
  return h;
}
async function braveFetch(url) {
  if (!BRAVE_API_KEY) throw new Error('BRAVE_API_KEY is not set on the server');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': BRAVE_API_KEY },
      signal: AbortSignal.timeout(12000)
    });
    if (res.status === 429 && attempt === 0) { await sleep(1200); continue; } // الخطة المجانية: طلب كل ثانية
    if (!res.ok) throw new Error(`Brave API error: ${res.status}${res.status === 429 ? ' (rate limited, retry in a few seconds)' : ''}`);
    return res.json();
  }
}
function formatResults(items) {
  return items.map(r => {
    const age = r.age || r.page_age;
    return `[${stripTags(r.title)}](${r.url})${age ? ` (${age})` : ''}\n${stripTags(r.description).slice(0, 300)}`;
  }).join('\n\n---\n\n');
}
async function webSearch(query, { count = 5, boost = null, freshness = '', site = '' } = {}) {
  let q = str(query).trim();
  if (!q) throw new Error('query is required');
  if (site) q += ` site:${normalizeDomain(str(site))}`;
  const params = new URLSearchParams({ q: q.slice(0, 400), count: String(boost ? 20 : count) });
  if (freshness) {
    if (!FRESHNESS.has(freshness)) throw new Error('freshness must be pd, pw, pm or py');
    params.set('freshness', freshness);
  }
  const data = await braveFetch(`https://api.search.brave.com/res/v1/web/search?${params}`);
  let items = data.web?.results || [];
  if (boost) items = [...items.filter(r => boost(r.url)), ...items.filter(r => !boost(r.url))];
  return formatResults(items.slice(0, count));
}
async function newsSearch(query, { count = 5, freshness = 'pw' } = {}) {
  const q = str(query).trim();
  if (!q) throw new Error('query is required');
  if (!FRESHNESS.has(freshness)) throw new Error('freshness must be pd, pw, pm or py');
  const params = new URLSearchParams({ q: q.slice(0, 400), count: String(count), freshness });
  const data = await braveFetch(`https://api.search.brave.com/res/v1/news/search?${params}`);
  return formatResults(data.results || []);
}
const withReminder = (out) => (RESULT_REMINDER ? `${out}\n\n---\nReminder: ${RESULT_REMINDER}` : out);
const withDate = (out) =>
  `Today's date: ${new Date().toISOString().slice(0, 10)}. These results are current; trust them over your memory.\n\n${out || 'No results found.'}`;

// ---------- GitHub ----------
function parseRepo(repo) {
  repo = str(repo).trim();
  if (/^[\w.-]+$/.test(repo)) repo = `${GITHUB_ALLOWED_OWNERS[0]}/${repo}`; // اسم الريبو لوحده كفاية
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error('repo must look like owner/name');
  const [owner, name] = repo.split('/');
  if (!GITHUB_ALLOWED_OWNERS.includes(owner.toLowerCase())) {
    throw new Error(`owner "${owner}" is not allowed. Allowed owner(s): ${GITHUB_ALLOWED_OWNERS.join(', ')}. Retry with the exact owner/name (github_list_repos shows them).`);
  }
  return { owner, name };
}
function cleanPath(path = '') {
  const p = str(path).replace(/^\/+/, '');
  if (p.split('/').some(seg => seg === '..')) throw new Error('invalid path');
  return p.split('/').map(encodeURIComponent).join('/');
}
const refQuery = (ref) => (ref ? `?ref=${encodeURIComponent(ref)}` : '');

async function ghFetch(url, accept = 'application/vnd.github+json', { method = 'GET', body } = {}) {
  if (!GITHUB_TOKEN) throw new Error('GITHUB_TOKEN is not set on the server');
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: accept,
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'layla-mcp/2.0'
  };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    const err = new Error(`GitHub API error: ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function githubListRepos() {
  const data = await (await ghFetch('https://api.github.com/user/repos?per_page=100&sort=updated')).json();
  const rows = data
    .filter(r => GITHUB_ALLOWED_OWNERS.includes(r.owner.login.toLowerCase()))
    .map(r => `${r.full_name}${r.private ? ' (private)' : ''} [default: ${r.default_branch}]${GITHUB_WRITE_REPOS.includes(r.full_name.toLowerCase()) ? ' [writable via ' + WRITE_BRANCH + ']' : ''}`);
  return rows.join('\n') || 'No repos visible to this token for the allowed owners.';
}
async function githubListFiles(repo, path = '', ref = '') {
  const { owner, name } = parseRepo(repo);
  const data = await (await ghFetch(`https://api.github.com/repos/${owner}/${name}/contents/${cleanPath(path)}${refQuery(ref)}`)).json();
  if (!Array.isArray(data)) return `${data.path} is a file (${data.size} bytes). Use github_read_file.`;
  return data.slice(0, 100).map(f => `${f.type === 'dir' ? '[dir] ' : ''}${f.path}${f.type === 'file' ? ` (${f.size} bytes)` : ''}`).join('\n');
}
async function githubReadFile(repo, path, ref = '', { offset = 0, maxChars = 6000 } = {}) {
  const { owner, name } = parseRepo(repo);
  if (!path) throw new Error('path is required');
  const res = await ghFetch(`https://api.github.com/repos/${owner}/${name}/contents/${cleanPath(path)}${refQuery(ref)}`, 'application/vnd.github.raw+json');
  const text = await res.text();
  const start = Math.min(Math.max(0, Math.floor(Number(offset)) || 0), text.length);
  const rest = text.length - (start + maxChars);
  return text.slice(start, start + maxChars) + (rest > 0 ? `\n\n[...${rest} more chars. Call again with offset=${start + maxChars}]` : '');
}
async function githubSearchCode(repo, query) {
  const { owner, name } = parseRepo(repo);
  if (!query) throw new Error('query is required');
  const q = encodeURIComponent(`${query} repo:${owner}/${name}`);
  const data = await (await ghFetch(`https://api.github.com/search/code?q=${q}&per_page=10`)).json();
  return (data.items || []).map(i => i.path).join('\n') || 'No matches.';
}
function assertWritable(owner, name) {
  if (!GITHUB_WRITE_REPOS.includes(`${owner}/${name}`.toLowerCase())) throw new Error('writing is not enabled for this repo');
}
async function githubWriteFile(repo, path, content, message) {
  const { owner, name } = parseRepo(repo);
  assertWritable(owner, name);
  if (!path) throw new Error('path is required');
  if (typeof content !== 'string') throw new Error('content must be a string');
  if (content.length > 100000) throw new Error('content too large (max 100KB)');
  if (/^\/*\.github\//i.test(str(path))) throw new Error('writing to .github is blocked');
  const p = cleanPath(path);
  const base = `https://api.github.com/repos/${owner}/${name}`;

  let branchExists = true; // 1) تأكد من فرع layla-edits، أو اعمله من الفرع الافتراضي
  try { await ghFetch(`${base}/git/ref/heads/${WRITE_BRANCH}`); }
  catch (e) { if (e.status === 404) branchExists = false; else throw e; }
  if (!branchExists) {
    const info = await (await ghFetch(base)).json();
    const def = str(info.default_branch).split('/').map(encodeURIComponent).join('/');
    const ref = await (await ghFetch(`${base}/git/ref/heads/${def}`)).json();
    await ghFetch(`${base}/git/refs`, undefined, { method: 'POST', body: { ref: `refs/heads/${WRITE_BRANCH}`, sha: ref.object.sha } });
  }
  let sha; // 2) لو الملف موجود على الفرع محتاجين sha بتاعه
  try {
    const cur = await (await ghFetch(`${base}/contents/${p}?ref=${WRITE_BRANCH}`)).json();
    if (!Array.isArray(cur)) sha = cur.sha;
  } catch (e) { if (e.status !== 404) throw e; }
  await ghFetch(`${base}/contents/${p}`, undefined, { // 3) احفظ
    method: 'PUT',
    body: {
      message: str(message || `Update ${path}`).slice(0, 200),
      content: Buffer.from(content, 'utf8').toString('base64'),
      branch: WRITE_BRANCH,
      ...(sha ? { sha } : {})
    }
  });
  return `Saved ${path} to branch "${WRITE_BRANCH}" of ${owner}/${name} (not main). Next: call github_open_pr, or the user merges it on GitHub.`;
}
async function githubOpenPr(repo, title, body = '') {
  const { owner, name } = parseRepo(repo);
  assertWritable(owner, name);
  const base = `https://api.github.com/repos/${owner}/${name}`;
  const info = await (await ghFetch(base)).json();
  try {
    const pr = await (await ghFetch(`${base}/pulls`, undefined, {
      method: 'POST',
      body: { title: str(title || 'Layla edits').slice(0, 200), head: WRITE_BRANCH, base: info.default_branch, body: str(body).slice(0, 2000) }
    })).json();
    return `Pull request opened: ${pr.html_url}. The user must review and merge it on GitHub.`;
  } catch (e) {
    if (e.status === 422) return `No PR created: one is already open for ${WRITE_BRANCH}, or there are no changes yet.`;
    throw e;
  }
}
// ============================ HELPERS END ============================

// ============================ TOOLS ============================
const obj = (properties, required = []) => ({ type: 'object', properties, required });
const FRESH_DESC = 'Optional recency filter: pd (day), pw (week), pm (month), py (year)';

const BASE_TOOLS = [
  { name: 'search_code', description: 'Programming help search. Ranks official docs, GitHub, MDN, Stack Overflow first. Use short English queries.',
    inputSchema: obj({ query: { type: 'string', description: 'Short query with library name and version' } }, ['query']) },
  { name: 'brave_web_search', description: 'Web search for facts and general questions (not for opening a URL: use read_page). Ranks reputable sources first.',
    inputSchema: obj({
      query: { type: 'string', description: 'The search query' },
      freshness: { type: 'string', description: FRESH_DESC },
      site: { type: 'string', description: 'Optional: limit results to one domain, e.g. nodejs.org' }
    }, ['query']) },
  { name: 'search_news', description: 'Recent news articles (default: past week).',
    inputSchema: obj({ query: { type: 'string', description: 'News topic' }, freshness: { type: 'string', description: FRESH_DESC } }, ['query']) },
  { name: 'read_page', description: 'Open any public web page and read its text. Long pages: use find="keywords" to jump to a topic, or offset to continue. JavaScript-only pages and PDFs fall back to a rendering reader. images=true adds image descriptions.',
    inputSchema: obj({
      page_url: { type: 'string', description: 'Full page address, e.g. https://example.com/a' },
      find: { type: 'string', description: 'Keywords: return only the matching passages' },
      offset: { type: 'number', description: 'Continue a long page from this position' },
      links: { type: 'boolean', description: 'List links found on the page' },
      images: { type: 'boolean', description: 'Describe images on the page (slower)' },
      render: { type: 'string', description: 'auto (default), direct, or jina' }
    }, ['page_url']) }
];
const REPO_PROP = { type: 'string', description: 'owner/name, or just the repo name' };
const REF_PROP = { type: 'string', description: 'Optional branch name' };
const GITHUB_TOOLS = [
  { name: 'github_list_repos', description: 'List the GitHub repos this server can access (exact owner/name).', inputSchema: obj({}) },
  { name: 'github_list_files', description: 'List files and folders in a repo path.',
    inputSchema: obj({ repo: REPO_PROP, path: { type: 'string', description: 'Folder path, empty for root' }, ref: REF_PROP }, ['repo']) },
  { name: 'github_read_file', description: 'Read one text file from a repo (long files: use offset).',
    inputSchema: obj({ repo: REPO_PROP, path: { type: 'string', description: 'File path' }, ref: REF_PROP, offset: { type: 'number', description: 'Start position' } }, ['repo', 'path']) },
  { name: 'github_search_code', description: 'Search code inside one repo; returns matching file paths.',
    inputSchema: obj({ repo: REPO_PROP, query: { type: 'string', description: 'Search term' } }, ['repo', 'query']) }
];
const GITHUB_WRITE_TOOLS = [
  { name: 'github_write_file', description: `Create or update ONE file. Saves to branch "${WRITE_BRANCH}", never main. Send the COMPLETE file content.`,
    inputSchema: obj({
      repo: REPO_PROP, path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'Complete file content' }, message: { type: 'string', description: 'Short commit message' }
    }, ['repo', 'path', 'content']) },
  { name: 'github_open_pr', description: `Open a pull request from "${WRITE_BRANCH}" to the default branch. Never merges.`,
    inputSchema: obj({ repo: REPO_PROP, title: { type: 'string', description: 'PR title' }, body: { type: 'string', description: 'Short description' } }, ['repo']) }
];
const listTools = () => [
  ...BASE_TOOLS,
  ...(GITHUB_TOKEN ? GITHUB_TOOLS : []),
  ...(GITHUB_TOKEN && GITHUB_WRITE_REPOS.length ? GITHUB_WRITE_TOOLS : [])
];

// لو الموديل بحث برابط بدل ما يقراه، افتح الصفحة مباشرة (البحث عن رابط مابيجيبش الصفحة نفسها)
const urlInQuery = (q) => (/https?:\/\/[^\s)"'<>]+/i.exec(str(q)) || [])[0] || null;

async function callTool(name, args) {
  const text = async (p) => ({ content: [{ type: 'text', text: await p }] });
  if ((name === 'search_code' || name === 'brave_web_search') && urlInQuery(args.query)) {
    const u = urlInQuery(args.query);
    return text(readPage(u, {}).then(o => withReminder(`(The query contained a URL, so the page was opened directly with read_page.)\n${o}`)));
  }
  switch (name) {
    case 'search_code': return text(webSearch(args.query, { boost: isTrustedDev }).then(withDate).then(withReminder));
    case 'brave_web_search': return text(webSearch(args.query, { boost: isTrustedGeneral, freshness: str(args.freshness), site: str(args.site) }).then(withDate).then(withReminder));
    case 'search_news': return text(newsSearch(args.query, { freshness: str(args.freshness) || 'pw' }).then(withDate).then(withReminder));
    case 'read_page': return text(readPage(str(args.page_url || args.link || args.url), { offset: args.offset, find: str(args.find), render: str(args.render) || 'auto', links: args.links === true || args.links === 'true', images: args.images === true || args.images === 'true' }).then(withReminder));
  }
  if (name.startsWith('github_')) {
    if (!GITHUB_TOKEN) throw new Error('GitHub tools are disabled (GITHUB_TOKEN not set)');
    switch (name) {
      case 'github_list_repos': return text(githubListRepos());
      case 'github_list_files': return text(githubListFiles(args.repo, str(args.path), str(args.ref)));
      case 'github_read_file': return text(githubReadFile(args.repo, str(args.path), str(args.ref), { offset: args.offset }));
      case 'github_search_code': return text(githubSearchCode(args.repo, str(args.query)));
      case 'github_write_file': return text(githubWriteFile(args.repo, str(args.path), args.content, str(args.message)));
      case 'github_open_pr': return text(githubOpenPr(args.repo, str(args.title), str(args.body)));
    }
  }
  throw new Error('Tool not found');
}

function createMcpServer() {
  const server = new Server({ name: 'layla-mcp-search', version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    console.log(`tool: ${name}`);
    try {
      return await callTool(name, args || {});
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: `Error: ${error.message}` }] };
    }
  });
  return server;
}

// ============================ HTTP ============================
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
  res.header('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function safeEqual(a, b) {
  const A = Buffer.from(a), B = Buffer.from(b);
  return A.length === B.length && timingSafeEqual(A, B);
}
function auth(req, res, next) {
  if (!safeEqual(req.headers.authorization || '', `Bearer ${MCP_API_KEY}`)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.get('/', (req, res) => res.send('MCP server is running'));
app.get('/status', auth, (req, res) => res.json({
  name: 'layla-mcp-search', version: VERSION,
  features: { search: !!BRAVE_API_KEY, github: !!GITHUB_TOKEN, githubWrite: !!GITHUB_TOKEN && GITHUB_WRITE_REPOS.length > 0 },
  tools: listTools().map(t => t.name)
}));

// ---------- 1) Streamable HTTP (Layla بتبعت POST على /sse وبتطلب Mcp-Session-Id) ----------
const httpSessions = new Map(); // sessionId -> transport

async function handleStreamable(req, res) {
  try {
    const sid = req.headers['mcp-session-id'];
    let transport = sid ? httpSessions.get(sid) : undefined;

    if (!transport) {
      if (sid || !isInitializeRequest(req.body)) {
        // جلسة غير معروفة (مثلاً السيرفر عمل restart) -> 404 عشان العميل يبدأ جلسة جديدة
        return res.status(sid ? 404 : 400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: sid ? 'Session not found' : 'Bad Request: no session' },
          id: null
        });
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => { httpSessions.set(id, transport); }
      });
      transport.onclose = () => {
        if (transport.sessionId) httpSessions.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
    }
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('Streamable error:', err);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
}

async function handleSessionRequest(req, res) {
  try {
    const transport = httpSessions.get(req.headers['mcp-session-id']);
    if (!transport) return res.status(404).send('Session not found');
    await transport.handleRequest(req, res);
  } catch (err) {
    console.error('Session request error:', err);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
}

app.post(['/sse', '/mcp'], auth, express.json(), handleStreamable);
app.get('/mcp', auth, handleSessionRequest);
app.delete(['/sse', '/mcp'], auth, handleSessionRequest);

// ---------- 2) SSE القديم (للتوافق) ----------
const sseTransports = new Map(); // sessionId -> transport

app.get('/sse', auth, async (req, res) => {
  if (req.headers['mcp-session-id']) return handleSessionRequest(req, res);
  try {
    const transport = new SSEServerTransport('/messages', res);
    sseTransports.set(transport.sessionId, transport);
    res.on('close', () => sseTransports.delete(transport.sessionId));
    await createMcpServer().connect(transport);
  } catch (err) {
    console.error('SSE error:', err);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

app.post('/messages', auth, async (req, res) => {
  try {
    const transport = sseTransports.get(req.query.sessionId);
    if (!transport) return res.status(400).send('No transport found for sessionId');
    await transport.handlePostMessage(req, res); // مهم: من غير express.json هنا
  } catch (err) {
    console.error('Messages error:', err);
    if (!res.headersSent) res.status(500).send('Internal server error');
  }
});

app.listen(port, () => console.log(`layla-mcp-search v${VERSION} running on port ${port}`));
