// Cloudflare Pages Function —— 博客后台
// 路由: /tsz
//
// 环境变量（在 Cloudflare Pages 项目设置里配置）：
//   ADMIN_PASSWORD   后台密码（默认 6966@Blog）
//   ADMIN_SECRET     会话签名密钥（任意长随机串）
//   GITHUB_TOKEN     GitHub Personal Access Token
//   GITHUB_REPO      仓库，如 pelakai/blog
//   GITHUB_BRANCH    分支，默认 main
//
// 安全：GitHub Token 只存在于服务端环境变量，绝不下发到浏览器。

const COOKIE = 'blog_admin';
const SESSION_DAYS = 7;
const POSTS_DIR = 'content/posts';

// ---------------- 工具 ----------------

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: Object.assign({
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    }, extraHeaders),
  });
}

function html(body, status = 200, extraHeaders = {}) {
  return new Response(body, {
    status,
    headers: Object.assign({
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    }, extraHeaders),
  });
}

function b64encodeUtf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function b64decodeUtf8(b64) {
  const bin = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  const bytes = new Uint8Array(sig);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function makeSession(secret) {
  const exp = Date.now() + SESSION_DAYS * 86400 * 1000;
  const sig = await hmac(secret, String(exp));
  return exp + '.' + sig;
}

async function verifySession(secret, token) {
  if (typeof token !== 'string') return false;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return false;
  const exp = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = await hmac(secret, exp);
  if (sig.length !== expect.length) return false;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expect.charCodeAt(i);
  if (diff !== 0) return false;
  return Number(exp) > Date.now();
}

function env(ctx) {
  const e = ctx.env || {};
  return {
    password: e.ADMIN_PASSWORD || '6966@Blog',
    secret: e.ADMIN_SECRET || (e.ADMIN_PASSWORD || '6966@Blog') + '::dsh-blog-secret',
    token: e.GITHUB_TOKEN || '',
    repo: e.GITHUB_REPO || 'pelakai/blog',
    branch: e.GITHUB_BRANCH || 'main',
    deployHook: e.DEPLOY_HOOK || '',
  };
}

// 触发 Cloudflare Pages 重新构建（部署钩子）
async function triggerDeploy(cfg) {
  if (!cfg.deployHook) return false;
  try {
    const r = await fetch(cfg.deployHook, { method: 'POST' });
    return r.ok;
  } catch (e) {
    return false;
  }
}

// ---------------- GitHub API ----------------

function ghHeaders(token) {
  return {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'User-Agent': 'dsh-blog-admin',
    'Content-Type': 'application/json',
  };
}

async function ghGet(cfg, path) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}?ref=${cfg.branch}`;
  const r = await fetch(url, { headers: ghHeaders(cfg.token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('GitHub 读取失败: ' + r.status);
  return await r.json();
}

async function ghPut(cfg, path, contentText, message, sha) {
  const body = {
    message,
    content: b64encodeUtf8(contentText),
    branch: cfg.branch,
  };
  if (sha) body.sha = sha;
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const r = await fetch(url, { method: 'PUT', headers: ghHeaders(cfg.token), body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('GitHub 保存失败: ' + r.status + ' ' + (j.message || ''));
  return j;
}

async function ghDelete(cfg, path, message, sha) {
  const url = `https://api.github.com/repos/${cfg.repo}/contents/${encodeURIComponent(path).replace(/%2F/g, '/')}`;
  const r = await fetch(url, {
    method: 'DELETE', headers: ghHeaders(cfg.token),
    body: JSON.stringify({ message, sha, branch: cfg.branch }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error('GitHub 删除失败: ' + r.status + ' ' + (j.message || ''));
  return j;
}

// ---------------- 文章解析 ----------------

function parseFrontMatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const mm = line.match(/^([A-Za-z0-9_]+)\s*:\s*(.*)$/);
    if (!mm) continue;
    let v = mm[2].trim();
    v = v.replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1');
    meta[mm[1]] = v;
  }
  return { meta, body: m[2] };
}

function yamlString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function buildPostFile({ title, date, tags, categories, draft, summary, body }) {
  const lines = ['---'];
  lines.push('title: ' + yamlString(title));
  lines.push('date: ' + date);
  lines.push('draft: ' + (draft ? 'true' : 'false'));
  if (tags && tags.length) lines.push('tags: [' + tags.map(t => yamlString(t)).join(', ') + ']');
  if (categories && categories.length) lines.push('categories: [' + categories.map(t => yamlString(t)).join(', ') + ']');
  if (summary) lines.push('summary: ' + yamlString(summary));
  lines.push('---');
  lines.push('');
  lines.push(body || '');
  return lines.join('\n') + '\n';
}

function slugify(s) {
  const base = String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9\u4e00-\u9fa5\-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return base || 'post-' + Date.now();
}

function sanitizeDir(raw) {
  const segs = String(raw || '').split('/');
  const out = [];
  for (let s of segs) {
    s = s.trim().replace(/[\\:*?"<>|]/g, '').replace(/^\.+/, '').replace(/\s+/g, '-');
    if (s) out.push(s);
  }
  return out.join('/');
}

async function ensureIndexes(cfg, dir) {
  if (!dir) return;
  const segs = dir.split('/');
  for (let i = 1; i <= segs.length; i++) {
    const p = POSTS_DIR + '/' + segs.slice(0, i).join('/') + '/_index.md';
    try {
      const got = await ghGet(cfg, p);
      if (!got) {
        const title = segs[i - 1].replace(/-/g, ' ');
        await ghPut(cfg, p, '---\ntitle: "' + title + '"\n---\n', 'mkdir: ' + title);
      }
    } catch (e) { /* 忽略 */ }
  }
}

function nowIso() {
  // 用北京时间
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.toISOString().replace(/\.\d+Z$/, '+08:00');
}

// ---------------- 页面 ----------------

const STYLE = `
*{box-sizing:border-box}
body{margin:0;background:#0f1218;color:#e6e8ee;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:15px;line-height:1.6}
a{color:#7dd3fc;text-decoration:none}
input,textarea,button,select{font-family:inherit;font-size:14px}
.wrap{max-width:1100px;margin:0 auto;padding:20px}
.login{max-width:340px;margin:16vh auto;padding:0 20px}
.login h1{font-size:20px;margin:0 0 6px}
.login p{color:#8b93a7;font-size:13px;margin:0 0 22px}
.inp{width:100%;background:#151a23;border:1px solid #252c3a;color:#e6e8ee;border-radius:10px;padding:12px 14px;outline:none}
.inp:focus{border-color:#3b82f6}
.btn{background:#2563eb;color:#fff;border:0;border-radius:10px;padding:11px 20px;font-weight:600;cursor:pointer}
.btn:active{opacity:.85}
.btn.ghost{background:#1c232f;color:#c3cad8}
.btn.danger{background:#7f1d1d;color:#fecaca}
.btn.sm{padding:6px 12px;font-size:13px}
.row{display:flex;gap:10px;align-items:center}
.top{display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;padding-bottom:14px;border-bottom:1px solid #1e2531}
.top h1{font-size:18px;margin:0}
.grid{display:grid;grid-template-columns:280px 1fr;gap:16px}
@media(max-width:760px){.grid{grid-template-columns:1fr}}
.panel{background:#141922;border:1px solid #1e2531;border-radius:12px;padding:14px}
.panel h3{font-size:13px;color:#8b93a7;margin:0 0 10px;font-weight:600;letter-spacing:.03em}
.item{padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13.5px;border:1px solid transparent;margin-bottom:4px}
.folder{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:9px 12px;margin:6px 0 4px;border-radius:8px;background:#101722;border:1px solid #1e2531;color:#c3cad8;font-size:13px;cursor:pointer;font-weight:600}
.folder:hover{background:#161e2b}
.folder.on{border-color:#2563eb;color:#fff}
.item:hover{background:#1a2029}
.item.on{background:#1e2b3f;border-color:#2f4a6e}
.item .t{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.item .m{font-size:11.5px;color:#6b7488;margin-top:2px}
.field{margin-bottom:12px}
.field label{display:block;font-size:12.5px;color:#8b93a7;margin-bottom:5px}
input[type=text],input[type=date],textarea{width:100%;background:#151a23;border:1px solid #252c3a;color:#e6e8ee;border-radius:9px;padding:10px 12px;outline:none}
textarea{resize:vertical;min-height:340px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;line-height:1.65;font-size:13.5px}
input[type=text]:focus,input[type=date]:focus,textarea:focus{border-color:#3b82f6}
.chk{display:flex;align-items:center;gap:7px;font-size:13.5px;color:#c3cad8}
.hint{font-size:12px;color:#6b7488;margin-top:6px}
.toast{position:fixed;left:50%;bottom:26px;transform:translateX(-50%);background:#1e293b;border:1px solid #334155;color:#e6e8ee;padding:10px 18px;border-radius:10px;font-size:13.5px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:99}
.toast.on{opacity:1}
.err{color:#fca5a5;font-size:13px;margin-top:8px}
.hidden{display:none!important}
.split{display:flex;gap:8px;flex-wrap:wrap}

.mask{position:fixed;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:99}
.dlg{background:#151a23;border:1px solid #252c3a;border-radius:14px;padding:18px;width:min(440px,90vw)}
.dlg h3{margin:0 0 12px;font-size:16px;color:#e6e8ee}
.dlg .row{justify-content:flex-end;margin-top:14px}
`;

const LOGIN_HTML = (err) => `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客后台</title><style>${STYLE}</style></head>
<body><div class="login">
  <h1>博客后台</h1>
  <p>请输入密码</p>
  <form method="POST" action="/tsz">
    <input type="hidden" name="action" value="login">
    <input class="inp" type="password" name="pw" placeholder="密码" autofocus autocomplete="current-password">
    <div style="margin-top:12px"><button class="btn" type="submit" style="width:100%">进入</button></div>
    ${err ? `<div class="err">${err}</div>` : ''}
  </form>
</div></body></html>`;

const ADMIN_HTML = `<!DOCTYPE html><html lang="zh-CN"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>博客后台</title><style>${STYLE}</style></head>
<body>
<div class="wrap">
  <div class="top">
    <h1>博客后台</h1>
    <div class="row">
      <a class="btn ghost sm" href="/" target="_blank">看站点</a>
      <button class="btn ghost sm" onclick="logout()">退出</button>
    </div>
  </div>

  <div class="grid">
    <div class="panel">
      <div class="row" style="justify-content:space-between;margin-bottom:10px">
        <h3 style="margin:0">文章（<span id="cnt">0</span>）</h3>
        <div class="row" style="gap:6px">
          <button class="btn sm" onclick="newPost()">+ 文章</button>
          <button class="btn ghost sm" onclick="newFolder()">+ 文件夹</button>
        </div>
      </div>
      <div id="list"></div>
    </div>

    <div class="panel">
      <div id="editor" class="hidden">
        <div class="field">
          <label>标题</label>
          <input type="text" id="f-title" placeholder="文章标题">
        </div>
        <div class="split">
          <div class="field" style="flex:1;min-width:150px">
            <label>路径（slug）</label>
            <input type="text" id="f-slug" placeholder="hello-world">
          </div>
          <div class="field" style="flex:0 0 180px">
            <label>日期</label>
            <input type="date" id="f-date">
          </div>
        </div>
        <div class="split">
          <div class="field" style="flex:1;min-width:150px">
            <label>标签（逗号分隔）</label>
            <input type="text" id="f-tags" placeholder="随笔, 技术">
          </div>
          <div class="field" style="flex:1;min-width:150px">
            <label>分类（逗号分隔）</label>
            <input type="text" id="f-cats" placeholder="随笔">
          </div>
        </div>
        <div class="field">
          <label>文件夹（留空 = 根目录，用 / 分层）</label>
          <input type="text" id="f-dir" placeholder="如 技术/网络" list="dirlist">
          <datalist id="dirlist"></datalist>
          <div class="hint">改了文件夹 = 文章移动到新位置（旧链接会失效）</div>
        </div>
        <div class="field">
          <label class="chk"><input type="checkbox" id="f-draft"> 草稿（不发布）</label>
        </div>
        <div class="field">
          <label>正文（Markdown）</label>
          <textarea id="f-body" placeholder="# 标题&#10;&#10;正文内容…"></textarea>
          <div class="hint">支持 Markdown。保存后约 30 秒自动上线。</div>
        </div>
        <div class="split">
          <button class="btn" onclick="save()">保存并发布</button>
          <button class="btn ghost" onclick="insertImage()">插入图片</button>
          <button class="btn danger" onclick="del()">删除</button>
          <span id="msg" class="hint" style="align-self:center"></span>
        </div>
      </div>
      <div id="empty" style="color:#6b7488;padding:40px 10px;text-align:center">
        左边选一篇文章，或点「+ 新建」
      </div>
    </div>
  </div>
</div>
<div class="toast" id="toast"></div>

<script>
var posts = [];
var current = null;   // 当前编辑的 path

function toast(m){var t=document.getElementById('toast');t.textContent=m;t.className='toast on';setTimeout(function(){t.className='toast'},1900);}
function api(q){return fetch('/tsz?api='+q,{headers:{'accept':'application/json'}}).then(function(r){return r.json();});}
function post(data){return fetch('/tsz',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}).then(function(r){return r.json();});}

function esc(s){return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');}

function ask(title, placeholder, value){
  return new Promise(function(resolve){
    var mask=document.createElement('div'); mask.className='mask';
    var box=document.createElement('div'); box.className='dlg';
    var h=document.createElement('h3'); h.textContent=title||'输入';
    var inp=document.createElement('input'); inp.className='inp'; inp.placeholder=placeholder||''; inp.value=value||'';
    var row=document.createElement('div'); row.className='row';
    var no=document.createElement('button'); no.className='btn ghost'; no.textContent='取消';
    var ok=document.createElement('button'); ok.className='btn'; ok.textContent='确定';
    function close(v){ if(mask.parentNode) mask.parentNode.removeChild(mask); resolve(v); }
    ok.onclick=function(){ close(inp.value); };
    no.onclick=function(){ close(null); };
    inp.onkeydown=function(e){ if(e.key==='Enter'){ close(inp.value); } if(e.key==='Escape'){ close(null); } };
    row.appendChild(no); row.appendChild(ok);
    box.appendChild(h); box.appendChild(inp); box.appendChild(row);
    mask.appendChild(box); document.body.appendChild(mask);
    setTimeout(function(){ inp.focus(); }, 30);
  });
}

function askConfirm(title){
  return new Promise(function(resolve){
    var mask=document.createElement('div'); mask.className='mask';
    var box=document.createElement('div'); box.className='dlg';
    var h=document.createElement('h3'); h.textContent=title||'确定？';
    var row=document.createElement('div'); row.className='row';
    var no=document.createElement('button'); no.className='btn ghost'; no.textContent='取消';
    var ok=document.createElement('button'); ok.className='btn danger'; ok.textContent='确定';
    function close(v){ if(mask.parentNode) mask.parentNode.removeChild(mask); resolve(v); }
    ok.onclick=function(){ close(true); };
    no.onclick=function(){ close(false); };
    row.appendChild(no); row.appendChild(ok);
    box.appendChild(h); box.appendChild(row);
    mask.appendChild(box); document.body.appendChild(mask);
  });
}

var folders = [];
var currentDir = '';

function load(){
  api('list').then(function(j){
    posts = j.posts || [];
    folders = j.folders || [];
    document.getElementById('cnt').textContent = posts.length;

    var dl = document.getElementById('dirlist');
    if (dl) { dl.innerHTML = folders.map(function(f){ return '<option value="'+esc(f.path)+'">'; }).join(''); }

    var groups = {};
    // 先放入所有已有文件夹（含空文件夹），再挂上文章
    folders.forEach(function(f){ if (f && f.path) groups[f.path] = groups[f.path] || []; });
    posts.forEach(function(p){ var d = p.dir || ''; (groups[d] = groups[d] || []).push(p); });
    var keys = Object.keys(groups).sort(function(a,b){
      if (a === '') return -1;
      if (b === '') return 1;
      return a.localeCompare(b);
    });

    var h='';
    keys.forEach(function(d){
      if (d) {
        h += '<div class="folder'+(currentDir===d?' on':'')+'" data-d="'+esc(d)+'">'+
             '<span>📁 '+esc(d)+'</span><span class="m">'+groups[d].length+' 篇</span></div>';
      }
      groups[d].forEach(function(p){
        h += '<div class="item'+(current===p.path?' on':'')+'" data-p="'+esc(p.path)+'">'+
             '<span class="t">'+esc(p.title)+(p.draft?' · 草稿':'')+'</span>'+
             '<span class="m">'+esc(p.date)+'</span></div>';
      });
    });
    if(!posts.length){h='<div style="color:#6b7488;font-size:13px;padding:10px">还没有文章</div>';}
    var el=document.getElementById('list');
    el.innerHTML=h;
    Array.prototype.forEach.call(el.querySelectorAll('.item'),function(node){
      node.addEventListener('click',function(){openPost(node.getAttribute('data-p'));});
    });
    Array.prototype.forEach.call(el.querySelectorAll('.folder'),function(node){
      node.addEventListener('click',function(){
        currentDir = node.getAttribute('data-d');
        toast('新建文章将放在：' + currentDir);
        load();
      });
    });
  }).catch(function(e){toast('加载失败');});
}

function newFolder(){
  ask('新建文件夹','用 / 分层，如 技术/网络','').then(function(d){
    if (d === null) return;
    d = String(d).trim();
    if (!d) { toast('名称不能为空'); return; }
    post({action:'mkdir',dir:d}).then(function(j){
      if (j.ok) { toast('已创建，约 30 秒后生效'); currentDir = j.dir || d; load(); }
      else toast(j.error || '创建失败');
    });
  });
}

function openPost(path){
  api('get&path='+encodeURIComponent(path)).then(function(j){
    if(!j.ok){toast(j.error||'读取失败');return;}
    current = path;
    var m = j.meta || {};
    document.getElementById('f-title').value = m.title || '';
    var parts = path.split('/');
    var file = parts[parts.length-1].replace(/\\.md$/,'');
    document.getElementById('f-slug').value = file;
    var dirPart = parts.slice(0, parts.length - 1).join('/').replace(/^content\\/posts\\/?/, '');
    var dirEl = document.getElementById('f-dir');
    if (dirEl) dirEl.value = dirPart;
    var d = (m.date||'').slice(0,10);
    document.getElementById('f-date').value = d || new Date().toISOString().slice(0,10);
    document.getElementById('f-tags').value = (m.tags||'').replace(/^\\[|\\]$/g,'');
    document.getElementById('f-cats').value = (m.categories||'').replace(/^\\[|\\]$/g,'');
    document.getElementById('f-draft').checked = String(m.draft)==='true';
    document.getElementById('f-body').value = j.body || '';
    document.getElementById('editor').classList.remove('hidden');
    document.getElementById('empty').classList.add('hidden');
    refreshListSelection();
  });
}

function refreshListSelection(){
  Array.prototype.forEach.call(document.querySelectorAll('.item'),function(n){
    n.classList.toggle('on', n.getAttribute('data-p')===current);
  });
}

function newPost(){
  current = null;
  document.getElementById('f-title').value='';
  document.getElementById('f-slug').value='';
  document.getElementById('f-date').value=new Date().toISOString().slice(0,10);
  document.getElementById('f-tags').value='';
  document.getElementById('f-cats').value='';
  document.getElementById('f-draft').checked=false;
  document.getElementById('f-body').value='';
  var dirEl = document.getElementById('f-dir');
  if (dirEl) dirEl.value = currentDir || '';
  document.getElementById('editor').classList.remove('hidden');
  document.getElementById('empty').classList.add('hidden');
  refreshListSelection();
  document.getElementById('f-title').focus();
}

function save(){
  var title = document.getElementById('f-title').value.trim();
  var slug = document.getElementById('f-slug').value.trim();
  var date = document.getElementById('f-date').value;
  var tags = document.getElementById('f-tags').value;
  var cats = document.getElementById('f-cats').value;
  var draft = document.getElementById('f-draft').checked;
  var body = document.getElementById('f-body').value;
  var dirEl = document.getElementById('f-dir');
  var dir = dirEl ? dirEl.value : '';
  if(!title){toast('标题不能为空');return;}
  if(!slug){toast('路径不能为空');return;}
  document.getElementById('msg').textContent='保存中…';
  post({action:'save',title:title,slug:slug,date:date,tags:tags,categories:cats,draft:draft,body:body,path:current,dir:dir})
    .then(function(j){
      document.getElementById('msg').textContent='';
      if(j.ok){toast('已保存，约 30 秒后上线');current=j.path;load();}
      else toast(j.error||'保存失败');
    }).catch(function(){document.getElementById('msg').textContent='';toast('保存失败');});
}

function del(){
  if(!current){toast('先选一篇文章');return;}
  askConfirm('确定删除这篇？').then(function(yes){
    if(!yes) return;
    post({action:'delete',path:current}).then(function(j){
    if(j.ok){toast('已删除');current=null;
      document.getElementById('editor').classList.add('hidden');
      document.getElementById('empty').classList.remove('hidden');
      load();}
    else toast(j.error||'删除失败');
    });
  });
}

function logout(){
  post({action:'logout'}).then(function(){location.href='/tsz';});
}

function insertImage(){
  var ta = document.getElementById('f-body');
  var input = document.createElement('input');
  input.type='file'; input.accept='image/*';
  input.onchange = function(){
    var f = input.files[0]; if(!f) return;
    if(f.size > 4*1024*1024){toast('图片太大（上限 4MB）');return;}
    var fr = new FileReader();
    fr.onload = function(){
      var b64 = String(fr.result).split(',')[1];
      toast('上传中…');
      post({action:'upload',name:f.name,data:b64,type:f.type}).then(function(j){
        if(j.ok){
          var md = '![' + (f.name.replace(/\\.[^.]+$/,'')) + '](' + j.url + ')';
          var s = ta.selectionStart, e = ta.selectionEnd;
          ta.value = ta.value.slice(0,s) + md + ta.value.slice(e);
          toast('已插入');
        } else toast(j.error||'上传失败');
      });
    };
    fr.readAsDataURL(f);
  };
  input.click();
}

load();
</script>
</body></html>`;

// ---------------- 主处理 ----------------

export async function onRequest(ctx) {
  const cfg = env(ctx);
  const { request } = ctx;
  const url = new URL(request.url);
  const cookies = parseCookies(request.headers.get('cookie'));
  const loggedIn = await verifySession(cfg.secret, cookies[COOKIE]).catch(() => false);

  // ---------- GET ----------
  if (request.method === 'GET') {
    const apiName = url.searchParams.get('api');

    if (apiName) {
      if (!loggedIn) return json({ ok: false, error: '未登录' }, 401);

      if (apiName === 'list') {
        try {
          // 递归列出 content/posts 下所有文件
          const treeUrl = 'https://api.github.com/repos/' + cfg.repo + '/git/trees/' + cfg.branch + '?recursive=1';
          const tr = await fetch(treeUrl, { headers: ghHeaders(cfg.token) });
          if (!tr.ok) throw new Error('读取文件树失败 ' + tr.status);
          const tj = await tr.json();
          const blobs = (tj.tree || []).filter(x => x.type === 'blob');

          const prefix = POSTS_DIR + '/';
          const mdFiles = blobs.filter(x => x.path.startsWith(prefix) && x.path.endsWith('.md') && !x.path.endsWith('/_index.md'));
          const idxFiles = blobs.filter(x => x.path.startsWith(prefix) && x.path.endsWith('/_index.md'));

          // 目录标题（来自 _index.md）
          const folderTitles = {};
          for (const f of idxFiles.slice(0, 60)) {
            const d = f.path.slice(prefix.length, f.path.length - '/_index.md'.length);
            folderTitles[d] = d;
            try {
              const rec = await ghGet(cfg, f.path);
              const { meta } = parseFrontMatter(rec ? b64decodeUtf8(rec.content) : '');
              if (meta.title) folderTitles[d] = String(meta.title);
            } catch (e) { /* 忽略 */ }
          }

          const posts = [];
          for (const f of mdFiles.slice(0, 300)) {
            try {
              const rec = await ghGet(cfg, f.path);
              const text = rec ? b64decodeUtf8(rec.content) : '';
              const { meta } = parseFrontMatter(text);
              const rel = f.path.slice(prefix.length);
              const cut = rel.lastIndexOf('/');
              const dir = cut >= 0 ? rel.slice(0, cut) : '';
              posts.push({
                path: f.path,
                dir: dir,
                title: meta.title || f.path.split('/').pop(),
                date: (meta.date || '').slice(0, 10),
                draft: String(meta.draft) === 'true',
              });
            } catch (e) { /* 跳过坏文件 */ }
          }
          posts.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

          // 目录集合
          const dirSet = {};
          Object.keys(folderTitles).forEach(d => { dirSet[d] = folderTitles[d]; });
          posts.forEach(p => { if (p.dir) dirSet[p.dir] = folderTitles[p.dir] || p.dir; });
          const folders = Object.keys(dirSet).sort().map(d => ({ path: d, title: dirSet[d] }));

          return json({ ok: true, posts, folders });
        } catch (e) {
          return json({ ok: false, error: String(e.message || e) }, 500);
        }
      }

      if (apiName === 'get') {
        const path = url.searchParams.get('path') || '';
        if (!path.startsWith(POSTS_DIR)) return json({ ok: false, error: '路径非法' }, 400);
        try {
          const rec = await ghGet(cfg, path);
          if (!rec) return json({ ok: false, error: '文件不存在' }, 404);
          const text = b64decodeUtf8(rec.content);
          const { meta, body } = parseFrontMatter(text);
          return json({ ok: true, meta, body });
        } catch (e) {
          return json({ ok: false, error: String(e.message || e) }, 500);
        }
      }

      return json({ ok: false, error: '未知接口' }, 400);
    }

    if (!loggedIn) return html(LOGIN_HTML(''));
    return html(ADMIN_HTML);
  }

  // ---------- POST ----------
  if (request.method === 'POST') {
    let data = {};
    const ct = request.headers.get('content-type') || '';
    try {
      if (ct.includes('application/json')) {
        data = await request.json();
      } else {
        const fd = await request.formData();
        fd.forEach((v, k) => { data[k] = v; });
      }
    } catch (e) {
      return json({ ok: false, error: '请求格式错误' }, 400);
    }

    const action = data.action;

    if (action === 'login') {
      const pw = String(data.pw || '');
      if (pw !== cfg.password) {
        return html(LOGIN_HTML('密码不对'), 401);
      }
      const token = await makeSession(cfg.secret);
      const cookie = `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${SESSION_DAYS * 86400}`;
      // 表单提交则跳转，JSON 则返回 ok
      if (ct.includes('application/json')) {
        return json({ ok: true }, 200, { 'set-cookie': cookie });
      }
      return new Response(null, { status: 303, headers: { location: '/tsz', 'set-cookie': cookie, 'cache-control': 'no-store' } });
    }

    if (!loggedIn) return json({ ok: false, error: '未登录' }, 401);

    if (action === 'logout') {
      return json({ ok: true }, 200, {
        'set-cookie': `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
      });
    }

    try {
      if (action === 'save') {
        const title = String(data.title || '').trim();
        const slug = slugify(data.slug || title);
        const dateStr = String(data.date || '').trim();
        if (!title) return json({ ok: false, error: '标题不能为空' }, 400);
        if (!cfg.token) return json({ ok: false, error: '服务端未配置 GITHUB_TOKEN' }, 500);

        const tags = String(data.tags || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const categories = String(data.categories || '').split(/[,，]/).map(s => s.trim()).filter(Boolean);
        const draft = data.draft === true;
        const body = String(data.body || '');

        let date = dateStr;
        const dir = sanitizeDir(data.dir);
        if (dir) await ensureIndexes(cfg, dir);
        const newPath = POSTS_DIR + '/' + (dir ? dir + '/' : '') + slug + '.md';

        // 如果改了路径，删掉旧文件
        const oldPath = String(data.path || '');
        const existing = await ghGet(cfg, newPath);

        const fileContent = buildPostFile({
          title,
          date: date || nowIso(),
          tags, categories, draft, summary: '', body,
        });

        await ghPut(cfg, newPath, fileContent, `post: ${title}`, existing ? existing.sha : undefined);

        if (oldPath && oldPath.startsWith(POSTS_DIR) && oldPath !== newPath) {
          const old = await ghGet(cfg, oldPath);
          if (old) await ghDelete(cfg, oldPath, `rename: ${title}`, old.sha);
        }

        const deployed = await triggerDeploy(cfg);
        return json({ ok: true, path: newPath, deploy: deployed });
      }

      if (action === 'mkdir') {
        const dir = sanitizeDir(data.dir);
        if (!dir) return json({ ok: false, error: '目录名不能为空' }, 400);
        await ensureIndexes(cfg, dir);
        const deployed = await triggerDeploy(cfg);
        return json({ ok: true, dir: dir, deploy: deployed });
      }

      if (action === 'delete') {
        const path = String(data.path || '');
        if (!path.startsWith(POSTS_DIR)) return json({ ok: false, error: '路径非法' }, 400);
        const rec = await ghGet(cfg, path);
        if (!rec) return json({ ok: false, error: '文件不存在' }, 404);
        await ghDelete(cfg, path, 'delete post', rec.sha);
        const deployed = await triggerDeploy(cfg);
        return json({ ok: true, deploy: deployed });
      }

      if (action === 'upload') {
        const name = String(data.name || 'image.png');
        const b64 = String(data.data || '');
        if (!b64) return json({ ok: false, error: '没有图片数据' }, 400);
        const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/\.[^.]+$/, '');
        const ext = (name.match(/\.[^.]+$/) || ['.png'])[0].toLowerCase();
        const fname = `${Date.now()}-${safe}${ext}`;
        const path = `static/images/${fname}`;
        const existing = await ghGet(cfg, path);
        // 直接提交 base64
        const url = `https://api.github.com/repos/${cfg.repo}/contents/${path}`;
        const resp = await fetch(url, {
          method: 'PUT', headers: ghHeaders(cfg.token),
          body: JSON.stringify({
            message: 'upload: ' + fname,
            content: b64,
            branch: cfg.branch,
            sha: existing ? existing.sha : undefined,
          }),
        });
        if (!resp.ok) {
          const j = await resp.json().catch(() => ({}));
          return json({ ok: false, error: '上传失败: ' + (j.message || resp.status) }, 500);
        }
        return json({ ok: true, url: '/images/' + fname });
      }

      return json({ ok: false, error: '未知操作' }, 400);
    } catch (e) {
      return json({ ok: false, error: String((e && e.message) || e) }, 500);
    }
  }

  return json({ ok: false, error: 'Method Not Allowed' }, 405);
}
