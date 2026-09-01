import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY } from './supabase-config.js';

const supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

const AVATARS = ['🐼','🦊','🐨','🐯','🐸','🐧','🦁','🐰','🐢','🦉','🐳','🐝','🦄','🐺'];

let SESSION = null;
let PROFILE = null;
let ENTRIES = [];
let ACTIVE_TAB = 'log';
let AUTH_MODE = 'signin';
let pendingAvatar = AVATARS[0];

const root = document.getElementById('root');
const toastEl = document.getElementById('toast');

function showToast(msg){
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  setTimeout(()=>toastEl.classList.remove('show'), 2400);
}

function fmtDate(d){
  const dt = new Date(d + 'T00:00:00');
  return `${dt.getMonth()+1}月${dt.getDate()}日`;
}

function todayStr(){
  const d = new Date();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function changeClass(pct){
  if(pct === null || pct === undefined) return 'change-flat';
  if(pct < 0) return 'change-down';
  if(pct > 0) return 'change-up';
  return 'change-flat';
}
function changeLabel(pct){
  if(pct === null || pct === undefined) return '首次记录';
  const abs = Math.abs(pct).toFixed(2);
  if(pct < 0) return `${abs}% ↓`;
  if(pct > 0) return `${abs}% ↑`;
  return '持平';
}

function friendlyAuthError(err){
  const msg = (err && err.message) || '';
  if(msg.includes('Invalid login credentials')) return '邮箱或密码不对，再试一次。';
  if(msg.includes('User already registered')) return '这个邮箱已经注册过了，试试直接登录。';
  if(msg.includes('Password should be')) return '密码至少需要 6 位。';
  if(msg.includes('valid email')) return '邮箱格式不对。';
  return msg || '出了点问题，请重试。';
}

// ---------------- boot ----------------
async function boot(){
  const { data } = await supabase.auth.getSession();
  SESSION = data.session;
  supabase.auth.onAuthStateChange((_event, session)=>{
    SESSION = session;
  });
  if(SESSION){
    await afterLogin();
  } else {
    renderAuth();
  }
}

async function afterLogin(){
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', SESSION.user.id)
    .single();
  if(error || !data){
    // profile row is created by a database trigger on sign-up; if it's not
    // there yet (race on a brand-new account) fall back to a default.
    PROFILE = { id: SESSION.user.id, name: '新队友', avatar: AVATARS[0] };
  } else {
    PROFILE = data;
  }
  await loadEntries();
  renderApp();
}

async function loadEntries(){
  const { data, error } = await supabase
    .from('weight_entries')
    .select('entry_date, weight, change_percent')
    .eq('user_id', SESSION.user.id)
    .order('entry_date', { ascending: true });
  ENTRIES = error ? [] : data.map(r => ({
    date: r.entry_date, weight: Number(r.weight), changePercent: r.change_percent === null ? null : Number(r.change_percent)
  }));
}

// ---------------- auth screen ----------------
function renderAuth(){
  root.innerHTML = `
    <div class="hero">
      <div class="hero-text">
        <div class="hero-label">轻程</div>
        <h1>一起走的减重记录</h1>
        <p>每天称重，只有你自己看得到数字。你的努力会以增减率的方式，同步到团队墙上。</p>
      </div>
    </div>
    <div class="auth-card">
      <div class="auth-switch">
        <button id="switch-signin" class="${AUTH_MODE==='signin'?'active':''}">登录</button>
        <button id="switch-signup" class="${AUTH_MODE==='signup'?'active':''}">加入团队</button>
      </div>
      <div id="auth-body"></div>
    </div>
  `;
  document.getElementById('switch-signin').onclick = ()=>{ AUTH_MODE='signin'; renderAuth(); };
  document.getElementById('switch-signup').onclick = ()=>{ AUTH_MODE='signup'; renderAuth(); };
  if(AUTH_MODE === 'signin') renderSignIn(); else renderSignUp();
}

function renderSignIn(){
  const body = document.getElementById('auth-body');
  body.innerHTML = `
    <p class="sub">用你的邮箱和密码登录。</p>
    <div class="field">
      <label class="field-label" for="si-email">邮箱</label>
      <input id="si-email" type="email" autocomplete="email" />
    </div>
    <div class="field">
      <label class="field-label" for="si-password">密码</label>
      <input id="si-password" type="password" autocomplete="current-password" />
    </div>
    <div id="si-error"></div>
    <button class="btn btn-primary" id="si-submit">登录</button>
  `;
  document.getElementById('si-submit').onclick = async ()=>{
    const email = document.getElementById('si-email').value.trim();
    const password = document.getElementById('si-password').value;
    const btn = document.getElementById('si-submit');
    const errBox = document.getElementById('si-error');
    errBox.innerHTML = '';
    if(!email || !password){
      errBox.innerHTML = `<div class="form-error">请填写邮箱和密码。</div>`;
      return;
    }
    btn.disabled = true; btn.textContent = '登录中…';
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if(error){
      errBox.innerHTML = `<div class="form-error">${escapeHtml(friendlyAuthError(error))}</div>`;
      btn.disabled = false; btn.textContent = '登录';
      return;
    }
    const { data } = await supabase.auth.getSession();
    SESSION = data.session;
    await afterLogin();
  };
}

function renderSignUp(){
  pendingAvatar = AVATARS[0];
  const body = document.getElementById('auth-body');
  body.innerHTML = `
    <p class="sub">给自己起个名字，选一个头像。这些是团队墙上唯一会显示的信息——你的具体体重永远只有你自己能看到。</p>
    <div class="field">
      <label class="field-label" for="su-name">昵称</label>
      <input id="su-name" type="text" maxlength="20" placeholder="例如 阿May" />
    </div>
    <div class="field">
      <label class="field-label">头像</label>
      <div class="avatar-grid" id="su-avatars"></div>
    </div>
    <div class="field">
      <label class="field-label" for="su-email">邮箱</label>
      <input id="su-email" type="email" autocomplete="email" />
    </div>
    <div class="field">
      <label class="field-label" for="su-password">密码</label>
      <input id="su-password" type="password" autocomplete="new-password" />
    </div>
    <div id="su-error"></div>
    <button class="btn btn-primary" id="su-submit">加入团队</button>
  `;
  const grid = document.getElementById('su-avatars');
  AVATARS.forEach((a,i)=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-opt' + (i===0 ? ' selected' : '');
    b.textContent = a;
    b.onclick = ()=>{
      pendingAvatar = a;
      [...grid.children].forEach(c=>c.classList.remove('selected'));
      b.classList.add('selected');
    };
    grid.appendChild(b);
  });
  document.getElementById('su-submit').onclick = async ()=>{
    const name = document.getElementById('su-name').value.trim();
    const email = document.getElementById('su-email').value.trim();
    const password = document.getElementById('su-password').value;
    const btn = document.getElementById('su-submit');
    const errBox = document.getElementById('su-error');
    errBox.innerHTML = '';
    if(!name || !email || !password){
      errBox.innerHTML = `<div class="form-error">昵称、邮箱和密码都要填。</div>`;
      return;
    }
    btn.disabled = true; btn.textContent = '加入中…';
    const { data, error } = await supabase.auth.signUp({
      email, password,
      options: { data: { name, avatar: pendingAvatar } }
    });
    if(error){
      errBox.innerHTML = `<div class="form-error">${escapeHtml(friendlyAuthError(error))}</div>`;
      btn.disabled = false; btn.textContent = '加入团队';
      return;
    }
    if(data.session){
      SESSION = data.session;
      await afterLogin();
    } else {
      errBox.innerHTML = `<div class="form-note">已发送确认邮件到 ${escapeHtml(email)}，点击邮件里的链接后就能登录了。</div>`;
      btn.disabled = false; btn.textContent = '加入团队';
    }
  };
}

// ---------------- main app shell ----------------
function renderApp(){
  root.innerHTML = `
    <div class="hero">
      <div class="hero-text">
        <div class="hero-label">轻程</div>
        <h1>一起走的减重记录</h1>
        <p>每天称重，只有你自己看得到数字。你的努力会以增减率的方式，同步到团队墙上。</p>
      </div>
      <button class="signout-link" id="signout-btn">退出登录</button>
    </div>
    <div class="tabs">
      <button class="tab" id="tab-log">我的记录</button>
      <button class="tab" id="tab-wall">团队墙</button>
    </div>
    <div class="panel" id="panel-log"></div>
    <div class="panel" id="panel-wall"></div>
  `;
  document.getElementById('signout-btn').onclick = async ()=>{
    await supabase.auth.signOut();
    SESSION = null; PROFILE = null; ENTRIES = [];
    AUTH_MODE = 'signin';
    renderAuth();
  };
  document.getElementById('tab-log').onclick = ()=>switchTab('log');
  document.getElementById('tab-wall').onclick = ()=>switchTab('wall');
  switchTab(ACTIVE_TAB);
}

function switchTab(tab){
  ACTIVE_TAB = tab;
  document.getElementById('tab-log').classList.toggle('active', tab==='log');
  document.getElementById('tab-wall').classList.toggle('active', tab==='wall');
  document.getElementById('panel-log').classList.toggle('active', tab==='log');
  document.getElementById('panel-wall').classList.toggle('active', tab==='wall');
  if(tab==='log') renderLogPanel();
  if(tab==='wall') renderWallPanel();
}

// ---------------- my log panel ----------------
function renderLogPanel(){
  const panel = document.getElementById('panel-log');
  const sorted = [...ENTRIES].sort((a,b)=> b.date.localeCompare(a.date));
  panel.innerHTML = `
    <div class="whoami">
      <div class="av">${PROFILE.avatar}</div>
      <div class="name">${escapeHtml(PROFILE.name)}</div>
      <button class="edit-link" id="edit-profile-btn">编辑资料</button>
    </div>
    <div class="privacy-note">🔒 这里的体重数字只有你自己能看到（数据库权限规则强制限定）。同步到团队墙的，只有当天的增减百分比。</div>
    <div class="entry-form">
      <div class="row">
        <div>
          <label class="field-label" for="log-date">日期</label>
          <input type="date" id="log-date" value="${todayStr()}" />
        </div>
        <div>
          <label class="field-label" for="log-weight">体重 (kg)</label>
          <input type="number" id="log-weight" step="0.1" placeholder="例如 65.4" />
        </div>
      </div>
      <button class="btn btn-primary" id="log-submit">保存记录</button>
    </div>
    <div class="section-title">历史记录</div>
    <div class="entry-list" id="entry-list"></div>
  `;
  const list = document.getElementById('entry-list');
  if(sorted.length === 0){
    list.innerHTML = `<div class="empty">还没有记录，今天开始第一条吧。</div>`;
  } else {
    sorted.forEach(e=>{
      const row = document.createElement('div');
      row.className = 'entry-row';
      row.innerHTML = `
        <div class="entry-date">${fmtDate(e.date)}</div>
        <div class="entry-weight">${e.weight} kg</div>
        <div class="entry-change ${changeClass(e.changePercent)}">${changeLabel(e.changePercent)}</div>
        <button class="entry-del" data-date="${e.date}">删除</button>
      `;
      list.appendChild(row);
    });
    list.querySelectorAll('.entry-del').forEach(btn=>{
      btn.onclick = ()=>deleteEntry(btn.dataset.date);
    });
  }
  document.getElementById('log-submit').onclick = submitEntry;
  document.getElementById('edit-profile-btn').onclick = openEditProfile;
}

function recomputeChanges(sortedAsc){
  const out = [];
  for(let i=0;i<sortedAsc.length;i++){
    const cur = sortedAsc[i];
    if(i===0){
      out.push({ date: cur.date, weight: cur.weight, changePercent: null });
    } else {
      const prev = sortedAsc[i-1];
      const pct = ((cur.weight - prev.weight) / prev.weight) * 100;
      out.push({ date: cur.date, weight: cur.weight, changePercent: Math.round(pct*100)/100 });
    }
  }
  return out;
}

async function submitEntry(){
  const dateInput = document.getElementById('log-date');
  const weightInput = document.getElementById('log-weight');
  const btn = document.getElementById('log-submit');
  const date = dateInput.value;
  const weight = parseFloat(weightInput.value);
  if(!date || isNaN(weight) || weight <= 0){
    showToast('请填写日期和有效的体重');
    return;
  }
  btn.disabled = true; btn.textContent = '保存中…';

  const rest = ENTRIES.filter(e => e.date !== date);
  rest.push({ date, weight });
  rest.sort((a,b)=> a.date.localeCompare(b.date));
  const recomputed = recomputeChanges(rest);

  const rows = recomputed.map(e => ({
    user_id: SESSION.user.id,
    entry_date: e.date,
    weight: e.weight,
    change_percent: e.changePercent
  }));
  const { error } = await supabase.from('weight_entries').upsert(rows, { onConflict: 'user_id,entry_date' });
  if(error){
    showToast('保存失败，请重试');
    btn.disabled = false; btn.textContent = '保存记录';
    return;
  }
  ENTRIES = recomputed;
  weightInput.value = '';
  renderLogPanel();
  showToast('已保存');
}

async function deleteEntry(date){
  const { error: delErr } = await supabase
    .from('weight_entries')
    .delete()
    .eq('user_id', SESSION.user.id)
    .eq('entry_date', date);
  if(delErr){ showToast('删除失败，请重试'); return; }

  const rest = ENTRIES.filter(e => e.date !== date).sort((a,b)=> a.date.localeCompare(b.date));
  const recomputed = recomputeChanges(rest);
  if(recomputed.length){
    const rows = recomputed.map(e => ({
      user_id: SESSION.user.id,
      entry_date: e.date,
      weight: e.weight,
      change_percent: e.changePercent
    }));
    const { error } = await supabase.from('weight_entries').upsert(rows, { onConflict: 'user_id,entry_date' });
    if(error){ showToast('重新计算失败，请刷新重试'); return; }
  }
  ENTRIES = recomputed;
  renderLogPanel();
}

// ---------------- edit profile modal ----------------
function openEditProfile(){
  pendingAvatar = PROFILE.avatar;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>编辑资料</h3>
      <label class="field-label" for="edit-name">昵称</label>
      <input id="edit-name" type="text" value="${escapeHtml(PROFILE.name)}" maxlength="20" style="margin-bottom:16px" />
      <label class="field-label">头像</label>
      <div class="avatar-grid" id="edit-avatars"></div>
      <div class="modal-actions">
        <button class="btn btn-ghost" id="edit-cancel">取消</button>
        <button class="btn btn-primary" id="edit-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  const grid = document.getElementById('edit-avatars');
  AVATARS.forEach(a=>{
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'avatar-opt' + (a===PROFILE.avatar ? ' selected' : '');
    b.textContent = a;
    b.onclick = ()=>{
      pendingAvatar = a;
      [...grid.children].forEach(c=>c.classList.remove('selected'));
      b.classList.add('selected');
    };
    grid.appendChild(b);
  });
  document.getElementById('edit-cancel').onclick = ()=> backdrop.remove();
  document.getElementById('edit-save').onclick = async ()=>{
    const newName = document.getElementById('edit-name').value.trim();
    if(!newName){ showToast('昵称不能为空'); return; }
    const { error } = await supabase
      .from('profiles')
      .update({ name: newName, avatar: pendingAvatar })
      .eq('id', SESSION.user.id);
    if(error){ showToast('更新失败，请重试'); return; }
    PROFILE = { ...PROFILE, name: newName, avatar: pendingAvatar };
    backdrop.remove();
    renderLogPanel();
    showToast('资料已更新');
  };
}

// ---------------- team wall panel ----------------
async function renderWallPanel(){
  const panel = document.getElementById('panel-wall');
  panel.innerHTML = `<div class="loading">正在加载团队墙…</div>`;

  const { data, error } = await supabase
    .from('team_wall')
    .select('user_id, name, avatar, entry_date, change_percent')
    .order('entry_date', { ascending: false });

  if(error){
    panel.innerHTML = `<div class="empty">团队墙加载失败，请稍后重试。</div>`;
    return;
  }

  const latestByUser = new Map();
  for(const row of data){
    if(!latestByUser.has(row.user_id)) latestByUser.set(row.user_id, row);
  }
  const rows = [...latestByUser.values()].sort((a,b)=> b.entry_date.localeCompare(a.entry_date));
  const totalDown = rows.filter(r => Number(r.change_percent) < 0).length;

  panel.innerHTML = `
    <div class="wall-head">
      <div class="big-stat">${totalDown}</div>
      <div class="big-stat-label">位队友最新一次记录比上次更轻</div>
    </div>
    <div class="privacy-note">👀 团队墙只显示增减百分比，不会显示任何人的具体体重。</div>
    <div id="wall-list"></div>
  `;
  const list = document.getElementById('wall-list');
  if(rows.length === 0){
    list.innerHTML = `<div class="empty">还没有队友同步记录，记完第一条就会出现在这里。</div>`;
    return;
  }
  rows.forEach(m=>{
    const pct = Number(m.change_percent);
    const row = document.createElement('div');
    row.className = 'wall-row';
    row.innerHTML = `
      <div class="wall-av">${m.avatar}</div>
      <div class="wall-info">
        <div class="wall-name">${escapeHtml(m.name)}</div>
        <div class="wall-date">${fmtDate(m.entry_date)}</div>
      </div>
      <div class="wall-change ${changeClass(pct)}">${changeLabel(pct)}</div>
    `;
    list.appendChild(row);
  });
}

boot();
