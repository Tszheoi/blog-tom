// 全站访问密码（Cloudflare Pages Functions 中间件）
// 作用：未登录时，除 /tsz（后台自己那套密码）外，所有路径都先显示密码页；
//       通过后写一个签名 cookie，之后正常访问。
// 环境变量：
//   GATE_PASSWORD  进站密码（大小写不敏感）
//   ADMIN_SECRET   用于给 cookie 签名（复用后台密钥）
//   SITE_NAME      可选，密码页上显示的站名

const COOKIE = 'site_gate';
const DAYS = 30;
const EXCLUDE = [/^\/tsz(\/|$)/, /^\/favicon/i, /^\/apple-touch-icon/i];

const enc = new TextEncoder();

function b64url(buf) {
  const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(str) {
  const s = str.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  return b64url(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

function cfg(env) {
  const password = env.GATE_PASSWORD || env.ADMIN_PASSWORD || '';
  return {
    password,
    secret: env.ADMIN_SECRET || password + '::gate',
    siteName: env.SITE_NAME || 'ToM',
  };
}

async function makeCookie(c, ms) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + ms })));
  const sig = await hmac(c.secret, payload);
  return `${COOKIE}=${payload}.${sig}; Path=/; Max-Age=${Math.floor(ms / 1000)}; HttpOnly; Secure; SameSite=Lax`;
}

async function loggedIn(request, c) {
  const raw = request.headers.get('Cookie') || '';
  const m = raw.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
  if (!m) return false;
  const [payload, sig] = m[1].split('.');
  if (!payload || !sig) return false;
  if ((await hmac(c.secret, payload)) !== sig) return false;
  try {
    const data = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    return typeof data.exp === 'number' && data.exp > Date.now();
  } catch {
    return false;
  }
}

function loginPage(c, err, next) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(c.siteName)} · 需要密码</title>
<style>
  :root{--ink:#2d3142;--soft:#6b7280;--faint:#9aa3b2;--accent:#52d6a8;--accent-d:#35b98b;--line:#e8ecf1;--bg:#f7f9fc}
  *{box-sizing:border-box;margin:0;padding:0}
  body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;
    background:radial-gradient(900px 460px at 30% 0%,#eef6f2 0%,var(--bg) 60%,var(--bg) 100%);
    color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue","PingFang SC","Microsoft YaHei",sans-serif;
    -webkit-font-smoothing:antialiased}
  .card{width:100%;max-width:360px;background:#fff;border:1px solid var(--line);border-radius:18px;
    padding:34px 30px 28px;box-shadow:0 30px 60px -40px rgba(27,32,48,.45)}
  .dot{width:10px;height:10px;border-radius:50%;background:var(--accent);box-shadow:0 0 0 5px rgba(82,214,168,.18);margin-bottom:18px}
  h1{font-size:20px;font-weight:800;letter-spacing:-.01em}
  p.tip{margin-top:8px;color:var(--faint);font-size:13px}
  input{width:100%;margin-top:22px;padding:12px 14px;border:1px solid var(--line);border-radius:10px;
    font-size:15px;font-family:inherit;outline:none;color:var(--ink);background:#fff}
  input:focus{border-color:var(--accent);box-shadow:0 0 0 3px rgba(82,214,168,.16)}
  button{width:100%;margin-top:14px;padding:12px 0;border:0;border-radius:10px;cursor:pointer;
    background:var(--accent);color:#10281f;font-size:15px;font-weight:800;font-family:inherit}
  button:hover{background:var(--accent-d);color:#fff}
  .err{margin-top:12px;color:#c0392b;font-size:13px}
  .foot{margin-top:22px;color:var(--faint);font-size:11.5px;text-align:center}
</style></head>
<body>
  <form class="card" method="post" action="/__gate">
    <div class="dot"></div>
    <h1>${esc(c.siteName)}</h1>
    <p class="tip">这个站点需要密码才能访问</p>
    <input type="password" name="pw" placeholder="请输入密码" autofocus autocomplete="current-password">
    <input type="hidden" name="next" value="${esc(next || '/')}">
    <button type="submit">进入</button>
    ${err ? `<div class="err">${esc(err)}</div>` : ''}
    <div class="foot">验证通过后 30 天内免输</div>
  </form>
</body></html>`;
}

function htmlResp(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow' },
  });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const path = url.pathname;
  const c = cfg(env);

  // 后台 /tsz 走它自己的密码，不被站点密码拦
  if (EXCLUDE.some((re) => re.test(path))) return next();

  // 登录提交
  if (request.method === 'POST' && path === '/__gate') {
    const form = await request.formData().catch(() => null);
    const pw = form ? String(form.get('pw') || '') : '';
    const want = String(form ? form.get('next') || '/' : '/');
    const target = want.startsWith('/') && !want.startsWith('//') ? want : '/';
    if (c.password && pw.trim().toLowerCase() === c.password.trim().toLowerCase()) {
      return new Response(null, {
        status: 303,
        headers: { Location: target, 'Set-Cookie': await makeCookie(c, DAYS * 86400 * 1000) },
      });
    }
    return htmlResp(loginPage(c, '密码不对', target), 401);
  }

  if (await loggedIn(request, c)) return next();

  // 未登录：把原路径带进登录页，登录后跳回
  const back = path === '/' ? '/' : path + url.search;
  return htmlResp(loginPage(c, '', back), 200);
}
