import { load } from 'cheerio';

/* ============================================================
 * CONFIG
 * ============================================================ */
const BASE_URL = 'https://generator.email';
const DEVELOPER = 'api.haidarxd.my.id';
const VERSION = '3.0.0';
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const TIMEOUT = 15000;
const CACHE_TTL = 300000;
const FALLBACK_DOMAINS = ['fboxmail.com', 'cunan.store', 'sds-awe.top', 'mengundang.live', 'kintil.buzz', 'ketua.id'];

// cache level isolate (best-effort, bisa reset kapan saja)
const tokenCache = { value: null, at: 0 };
const domainCache = { value: [], at: 0 };

/* ============================================================
 * HELPERS
 * ============================================================ */
const respond = (status, data, message = null, errorCode = null) => {
  const r = { status, developer: DEVELOPER, version: VERSION, timestamp: new Date().toISOString(), data };
  if (message) r.message = message;
  if (errorCode) r.error_code = errorCode;
  return r;
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const json = (body, code = 200) =>
  new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function http(url, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9,id;q=0.8',
        ...headers,
      },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

// Cookie sesi inbox (dibuat per-request karena Worker stateless)
function inboxCookie(email, ctxSuffix = '', surlSuffix = '') {
  const [username, domain] = email.split('@');
  const parts = {
    inbox_ctx: encodeURIComponent(`${domain}/${username}/${ctxSuffix}`),
    surl: `${domain}/${username}${surlSuffix ? '/' + surlSuffix : ''}`,
    embx: encodeURIComponent(JSON.stringify([email])),
  };
  return Object.entries(parts).map(([k, v]) => `${k}=${v}`).join('; ');
}

/* ============================================================
 * PARSER
 * ============================================================ */
const EmailParser = {
  extractCleanBody($) {
    const selectors = ['div.mess_bodiyy', 'div[class*="mess_bod"]', 'div.user_mess_content', '#email_content', '#mail-summary-body'];
    for (const sel of selectors) {
      const container = $(sel);
      if (container.length > 0) {
        const clone = container.first().clone();
        clone.find('script, style, ins, button, iframe, .adsbygoogle, .mesg-row, .mailsrc-panel, .tooltip-container').remove();
        const bodyText = clone.text().replace(/\n\s*\n/g, '\n').trim();
        const rawHtml = clone.html() || '';
        return { bodyText, rawHtml };
      }
    }
    return { bodyText: '', rawHtml: '' };
  },

  extractOtp(text, html = null) {
    const combined = (text || '').trim();
    if (!combined && !html) return null;

    const mHyphen = combined.match(/\b([0-9]{3})[- ]([0-9]{3})\b/);
    if (mHyphen) return mHyphen[1] + mHyphen[2];

    const mKeyword = combined.match(
      /(?:kode\s*verifikasi|verification\s*code|security\s*code|confirmation\s*code|kode\s*keamanan|auth\s*code|passcode|kode\s*otp|otp|pin|code|kode)(?:(?:\s+[a-zA-Z]+){0,4})?\s*(?:adalah|is|:|:=|-|\s)\s*\b([0-9]{4,8})\b/i
    );
    if (mKeyword) {
      const val = mKeyword[1];
      if (!(val.length === 4 && (val.startsWith('19') || val.startsWith('20')) && !/code|kode|otp|pin/i.test(combined))) {
        return val;
      }
    }

    const mAction = combined.match(
      /(?:use\s*code|masukkan\s*kode|gunakan\s*kode|enter\s*(?:verification\s*)?code)\s*(?:adalah|is|:|:=|-|\s)?\s*\b([0-9]{4,8})\b/i
    );
    if (mAction) return mAction[1];

    const mAlpha = combined.match(
      /(?:otp|code|kode|token|password)(?:(?:\s+[a-zA-Z]+){0,3})?\s*(?:adalah|is|:|:=|-|\s)\s*\b([A-Z0-9]*[0-9][A-Z0-9]*)\b/i
    );
    if (mAlpha) {
      const val = mAlpha[1].trim();
      if (val.length >= 4 && val.length <= 8 && /[0-9]/.test(val) && /[a-zA-Z]/i.test(val)) {
        return val.toUpperCase();
      }
    }

    if (html) {
      const $ = load(html);
      let found = null;
      $('b, strong, h1, h2, h3, td, span, font').each((_, el) => {
        const t = $(el).text().trim();
        if (/^[0-9]{4,8}$/.test(t) && !/^(19\d\d|20[2-3]\d)$/.test(t)) {
          found = t;
          return false;
        }
        if (/^[0-9]{3}[- ][0-9]{3}$/.test(t)) {
          found = t.replace(/[- ]/, '');
          return false;
        }
      });
      if (found) return found;
    }

    const mSix = combined.match(/\b([0-9]{6})\b/);
    return mSix ? mSix[1] : null;
  },

  extractVerificationLinks(htmlContent) {
    if (!htmlContent) return { primary_link: null, all_links: [] };
    const $ = load(htmlContent);
    const links = [];
    let primary = null;
    let best = -1;

    const action = [
      'verify', 'verifikasi', 'confirm', 'konfirmasi', 'activate', 'aktifkan', 'click here', 'klik di sini',
      'log in', 'masuk', 'login', 'reset password', 'complete registration', 'get started', 'join', 'accept', 'approve',
    ];
    const ignore = [
      'unsubscribe', 'berhenti langganan', 'privacy policy', 'kebijakan privasi', 'terms', 'syarat dan ketentuan',
      'facebook', 'twitter', 'instagram', 'linkedin', 'youtube', 'help center', 'pusat bantuan', 'contact us',
      'hubungi kami', 'support', 'preferences', 'settings', 'android', 'ios',
    ];

    $('a[href]').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!/^https?:\/\//i.test(href)) return;
      const text = $(el).text().trim().toLowerCase();
      const hl = href.toLowerCase();
      if (ignore.some((j) => text.includes(j) || hl.includes(j))) return;

      let score = 0;
      for (const kw of action) {
        if (text.includes(kw)) score += 15;
        if (hl.includes(kw)) score += 5;
      }
      if (/token=|code=|key=|verify|activate|confirmation|auth\/links|auth_action/i.test(hl)) score += 10;

      if (!links.some((l) => l.url === href)) links.push({ text: $(el).text().trim(), url: href, score });
      if (score > best) {
        best = score;
        primary = href;
      }
    });

    // URL teks biasa (bukan <a>), mis. email yang isinya hanya "https://contoh.com"
    const plain = $.root().text().match(/https?:\/\/[^\s<>"')\]]+/gi) || [];
    for (const raw of plain) {
      const href = raw.replace(/[.,;:!?]+$/, '');
      const hl = href.toLowerCase();
      if (links.some((l) => l.url === href) || ignore.some((j) => hl.includes(j))) continue;
      let score = 0;
      if (/token=|code=|key=|verify|activate|confirmation|auth\/links|auth_action/i.test(hl)) score += 10;
      links.push({ text: href, url: href, score });
      if (score > best) {
        best = score;
        primary = href;
      }
    }

    links.sort((a, b) => b.score - a.score);
    if (!primary && links.length > 0) primary = links[0].url;
    return { primary_link: primary, all_links: links.map((l) => ({ text: l.text, url: l.url })) };
  },
};

/* ============================================================
 * GENERATOR.EMAIL CLIENT
 * ============================================================ */
async function getApiToken(force = false) {
  const now = Date.now();
  if (tokenCache.value && !force && now - tokenCache.at < CACHE_TTL) return tokenCache.value;
  try {
    const res = await http(`${BASE_URL}/`);
    if (res.status === 200) {
      const $ = load(await res.text());
      const token = $('meta[name="api-token"]').attr('content');
      if (token) {
        tokenCache.value = token.trim();
        tokenCache.at = now;
        return tokenCache.value;
      }
    }
  } catch (err) {
    if (tokenCache.value) return tokenCache.value;
    throw new Error(`Failed to retrieve API Token: ${err.message}`);
  }
  if (tokenCache.value) return tokenCache.value;
  throw new Error('Failed to find meta tag api-token in document');
}

async function getActiveDomains(force = false) {
  const now = Date.now();
  if (domainCache.value.length > 0 && !force && now - domainCache.at < CACHE_TTL) return domainCache.value;

  try {
    let token = await getApiToken(force);
    const call = (t) =>
      http(`${BASE_URL}/api/domains.php`, {
        'X-API-Token': t,
        'X-Requested-With': 'XMLHttpRequest',
        Referer: `${BASE_URL}/`,
        Accept: 'application/json, */*',
      });

    let res = await call(token);
    if (res.status === 403) {
      token = await getApiToken(true);
      res = await call(token);
    }

    if (res.status === 200) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const domains = data
          .map((d) => (d && typeof d === 'object' ? d.ascii || d.display : null))
          .filter(Boolean)
          .map((v) => v.trim().toLowerCase());
        if (domains.length > 0) {
          domainCache.value = domains;
          domainCache.at = now;
          return domains;
        }
      }
    }
  } catch (_) {
    /* fallback di bawah */
  }

  if (domainCache.value.length === 0) domainCache.value = FALLBACK_DOMAINS;
  return domainCache.value;
}

function sanitizeUsername(username) {
  const fallback = `user_${Math.floor(Date.now() / 1000)}`;
  if (!username) return fallback;
  return username.trim().toLowerCase().replace(/[^a-zA-Z0-9_.-]/g, '') || fallback;
}

async function generateEmail(username = null, domain = null) {
  const domains = await getActiveDomains();
  let selected = domain ? domain.trim().toLowerCase().replace(/^@/, '') : null;
  if (!selected || !domains.includes(selected)) {
    selected = selected || domains[Math.floor(Math.random() * domains.length)] || 'fboxmail.com';
  }
  const userPart = username ? sanitizeUsername(username) : `user_${Math.random().toString(36).substring(2, 12)}`;
  return `${userPart}@${selected}`.toLowerCase();
}

async function checkInbox(email) {
  const e = (email || '').trim().toLowerCase();
  if (!e.includes('@')) return respond('error', null, `Invalid email format: ${e}`, 'INVALID_EMAIL');

  try {
    const res = await http(`${BASE_URL}/inbox1/`, { Cookie: inboxCookie(e), Referer: `${BASE_URL}/` });
    if (res.status !== 200) return respond('error', null, `Inbox check failed (HTTP ${res.status})`, 'HTTP_ERROR');

    const $ = load(await res.text());
    let scriptCount = 0;
    $('script').each((_, el) => {
      const text = $(el).text() || '';
      if (text.includes('window.SITE_DATA=')) {
        const m = text.match(/num_mess:\s*(\d+)/);
        if (m) scriptCount = parseInt(m[1], 10);
      }
    });

    const messages = [];
    $('#email-table .list-group-item').each((_, el) => {
      const item = $(el);
      const onclick = item.attr('onclick') || '';
      const lm = onclick.match(/loadInboxClientSide\(['"](.*?)['"]\)/);
      messages.push({
        from: item.find('[class*="from_div"]').text().trim(),
        subject: item.find('[class*="subj_div"]').text().trim(),
        date: item.find('[class*="time_div"]').text().trim(),
        link: lm ? lm[1] : '',
      });
    });

    const { bodyText, rawHtml } = EmailParser.extractCleanBody($);
    const otp = bodyText ? EmailParser.extractOtp(bodyText, rawHtml) : null;
    const li = rawHtml ? EmailParser.extractVerificationLinks(rawHtml) : { primary_link: null };

    return respond('success', {
      email: e,
      total_messages: Math.max(messages.length, scriptCount),
      messages,
      otp,
      verification_link: li.primary_link,
      body: rawHtml || null,
    });
  } catch (err) {
    return respond('error', null, `Network connection failed: ${err.message}`, 'NETWORK_ERROR');
  }
}

async function readMessage(email, linkOrMsgId) {
  const e = (email || '').trim().toLowerCase();
  if (!e.includes('@')) return respond('error', null, `Invalid email format: ${e}`, 'INVALID_EMAIL');

  const [username, domain] = e.split('@');
  const link = (linkOrMsgId || '').replace(/^\//, '');
  const url = link.startsWith(domain) ? `${BASE_URL}/${link}` : `${BASE_URL}/${domain}/${username}/${link}`;

  try {
    const msgId = link.split('/').filter(Boolean).pop() || '';
    const fetchPage = async (target, surlSuffix = '') => {
      const res = await http(target, { Cookie: inboxCookie(e, linkOrMsgId, surlSuffix), Referer: `${BASE_URL}/inbox1/` });
      return res.status === 200 ? { $: load(await res.text()), status: 200 } : { $: null, status: res.status };
    };
    const hasBody = (p) => p.$ && EmailParser.extractCleanBody(p.$).rawHtml;

    // 1) halaman pesan langsung, 2) cadangan: inbox1 dengan cookie ID pesan terpilih
    let page = await fetchPage(url);
    if (!hasBody(page) && msgId) {
      const alt = await fetchPage(`${BASE_URL}/inbox1/`, msgId);
      if (hasBody(alt)) page = alt;
    }
    if (!page.$) return respond('error', null, `Failed to load message (HTTP ${page.status})`, 'HTTP_ERROR');

    const $ = page.$;
    let sender = '', subject = '', dateStr = '';
    const headText = $('#mail-summary-head').text() || '';
    for (const line of headText.split('\n')) {
      const lower = line.toLowerCase();
      if (lower.includes('from:') || lower.includes('dari:')) sender = line.replace(/^\s*(from|dari):\s*/i, '').trim();
      else if (lower.includes('subject:') || lower.includes('subjek:')) subject = line.replace(/^\s*(subject|subjek):\s*/i, '').trim();
      else if (lower.includes('date:') || lower.includes('tanggal:') || lower.includes('received:'))
        dateStr = line.replace(/^\s*(date|tanggal|received):\s*/i, '').trim();
    }

    const { bodyText, rawHtml } = EmailParser.extractCleanBody($);
    const otp = EmailParser.extractOtp(bodyText, rawHtml);
    const li = EmailParser.extractVerificationLinks(rawHtml);

    return respond('success', {
      email: e,
      from: sender,
      subject,
      date: dateStr,
      otp,
      verification_link: li.primary_link,
      body: rawHtml,
    });
  } catch (err) {
    return respond('error', null, `Network error reading message: ${err.message}`, 'NETWORK_ERROR');
  }
}

// Diagnostik: tampilkan struktur halaman pesan supaya selector bisa disesuaikan
async function debugMessage(email, linkOrMsgId) {
  const e = (email || '').trim().toLowerCase();
  const [username, domain] = e.split('@');
  const link = (linkOrMsgId || '').replace(/^\//, '');
  const msgId = link.split('/').filter(Boolean).pop() || '';
  const direct = link.startsWith(domain) ? `${BASE_URL}/${link}` : `${BASE_URL}/${domain}/${username}/${link}`;
  const variants = [
    { name: 'direct', url: direct, surl: '' },
    { name: 'inbox1+id', url: `${BASE_URL}/inbox1/`, surl: msgId },
  ];
  const out = [];
  for (const v of variants) {
    try {
      const res = await http(v.url, { Cookie: inboxCookie(e, linkOrMsgId, v.surl), Referer: `${BASE_URL}/inbox1/` });
      const html = await res.text();
      const $ = load(html);
      const names = new Set();
      $('[id],[class]').each((_, el) => {
        const tag = el.tagName;
        const id = $(el).attr('id');
        const cls = ($(el).attr('class') || '').split(/\s+/).filter(Boolean);
        if (id && /mess|mail|body|email|inbox/i.test(id)) names.add(`${tag}#${id}`);
        cls.filter((c) => /mess|mail|body|email|inbox/i.test(c)).forEach((c) => names.add(`${tag}.${c}`));
      });
      const body = EmailParser.extractCleanBody($);
      out.push({
        variant: v.name,
        url: v.url,
        http: res.status,
        html_length: html.length,
        body_length: body.rawHtml.length,
        body_preview: body.bodyText.slice(0, 200),
        candidates: [...names].slice(0, 40),
        head_text: ($('#mail-summary-head').text() || '').replace(/\s+/g, ' ').slice(0, 200),
      });
    } catch (err) {
      out.push({ variant: v.name, error: err.message });
    }
  }
  return respond('success', { email: e, link: linkOrMsgId, results: out });
}

// Worker tidak cocok jadi relay WebSocket -> pakai polling inbox sampai ada pesan masuk
async function waitForMessage(email, timeoutSec = 30) {
  const deadline = Date.now() + Math.min(timeoutSec, 60) * 1000;
  while (Date.now() < deadline) {
    const inbox = await checkInbox(email);
    if (inbox.status === 'error') return inbox;
    const first = inbox.data.messages[0];
    if (first && first.link) {
      const detail = await readMessage(email, first.link);
      if (detail.status === 'success') {
        return respond('success', { ...detail.data, from: first.from || detail.data.from, subject: first.subject || detail.data.subject }, 'New email received');
      }
    } else if (inbox.data.total_messages > 0 && inbox.data.body) {
      return respond('success', { email, subject: '', from: '', date: '', otp: inbox.data.otp, verification_link: inbox.data.verification_link, body: inbox.data.body });
    }
    await sleep(3000);
  }
  return respond('timeout', null, `Waiting timed out after ${timeoutSec} seconds.`, 'TIMEOUT');
}

/* ============================================================
 * ROUTER
 * ============================================================ */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const p = url.pathname.replace(/\/+$/, '') || '/';
    const q = url.searchParams;

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!p.startsWith('/api/')) return env.ASSETS.fetch(request);

    const missing = (msg, code = 'MISSING_PARAM') => json(respond('error', null, msg, code), 400);
    const timeout = parseInt(q.get('timeout'), 10) || 30;

    try {
      switch (p) {
        case '/api/status':
          return json({
            status: 'online',
            service: 'HaidarApis REST API (Cloudflare Workers)',
            developer: DEVELOPER,
            version: VERSION,
            endpoints: {
              status: '/api/status',
              domains: '/api/domains?refresh=true',
              generate: '/api/generate?username=...&domain=...',
              inbox: '/api/inbox?email=...',
              message: '/api/message?email=...&link=...',
              listen: '/api/listen?email=...&timeout=...',
              otp: '/api/otp?email=...&timeout=...',
              link: '/api/link?email=...&timeout=...',
            },
          });

        case '/api/domains': {
          const domains = await getActiveDomains(q.get('refresh') === 'true');
          return json(respond('success', { total_domains: domains.length, domains }));
        }

        case '/api/generate': {
          const email = await generateEmail(q.get('username'), q.get('domain'));
          const [u, d] = email.split('@');
          return json(respond('success', { email, username: u, domain: d, inbox_url: `${BASE_URL}/${email}` }));
        }

        case '/api/inbox': {
          if (!q.get('email')) return missing('Email parameter is required');
          return json(await checkInbox(q.get('email')));
        }

        case '/api/message': {
          if (!q.get('email') || !q.get('link')) return missing('Email and message link parameters are required', 'MISSING_PARAMS');
          return json(await readMessage(q.get('email'), q.get('link')));
        }

        case '/api/debug': {
          if (!q.get('email') || !q.get('link')) return missing('Email and message link parameters are required', 'MISSING_PARAMS');
          return json(await debugMessage(q.get('email'), q.get('link')));
        }

        case '/api/listen': {
          if (!q.get('email')) return missing('Email is required');
          return json(await waitForMessage(q.get('email'), timeout));
        }

        case '/api/otp': {
          if (!q.get('email')) return missing('Email is required');
          const r = await waitForMessage(q.get('email'), timeout);
          if (r.status !== 'success') return json(r);
          const { email, otp, subject, from, date } = r.data;
          return json(respond('success', { email, otp, subject, from, date }));
        }

        case '/api/link': {
          if (!q.get('email')) return missing('Email is required');
          const r = await waitForMessage(q.get('email'), timeout);
          if (r.status !== 'success') return json(r);
          const { email, verification_link, subject, from, date } = r.data;
          return json(respond('success', { email, verification_link, subject, from, date }));
        }

        default:
          return json(respond('error', null, 'Endpoint not found', 'NOT_FOUND'), 404);
      }
    } catch (err) {
      return json(respond('error', null, err.message, 'INTERNAL_ERROR'), 500);
    }
  },
};
