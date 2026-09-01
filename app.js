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

function daysBetween(dateA, dateB){
  const a = new Date(dateA + 'T00:00:00');
  const b = new Date(dateB + 'T00:00:00');
  return Math.round((b - a) / 86400000);
}

// current consecutive-day streak ending at the last date in a chronologically
// sorted (ascending) list of date strings. "active" means the streak still
// reaches into today or yesterday, rather than having gone cold.
function computeStreak(datesAsc){
  if(datesAsc.length === 0) return { count: 0, active: false };
  let count = 1;
  for(let i = datesAsc.length - 1; i > 0; i--){
    if(daysBetween(datesAsc[i-1], datesAsc[i]) === 1){
      count++;
    } else {
      break;
    }
  }
  const active = daysBetween(datesAsc[datesAsc.length - 1], todayStr()) <= 1;
  return { count, active };
}

// Derives the % weight change between two points in time using only their
// change_from_baseline_percent values (both relative to the same baseline
// weight) — the actual weight cancels out of the math, so this never needs
// to touch a real weight number.
function pctBetweenBaselinePoints(baselinePctAtRef, baselinePctAtLatest){
  const denom = 1 + (baselinePctAtRef / 100);
  if(denom <= 0) return null;
  return Math.round(((baselinePctAtLatest - baselinePctAtRef) / denom) * 10000) / 100;
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
  await backfillBaselineIfNeeded();
  renderApp();
}

async function loadEntries(){
  const { data, error } = await supabase
    .from('weight_entries')
    .select('entry_date, weight, change_percent, change_from_baseline_percent')
    .eq('user_id', SESSION.user.id)
    .order('entry_date', { ascending: true });
  ENTRIES = error ? [] : data.map(r => ({
    date: r.entry_date,
    weight: Number(r.weight),
    changePercent: r.change_percent === null ? null : Number(r.change_percent),
    baselinePercent: r.change_from_baseline_percent === null ? null : Number(r.change_from_baseline_percent)
  }));
}

// entries saved before the "vs. starting weight" feature existed have
// change_from_baseline_percent = NULL in the database (adding a column
// doesn't retroactively fill old rows). Recompute and resync those quietly
// on load so the person never has to think about it.
async function backfillBaselineIfNeeded(){
  if(ENTRIES.length === 0) return;
  const needsBackfill = ENTRIES.some(e => e.baselinePercent === null);
  if(!needsBackfill) return;
  const sortedAsc = [...ENTRIES].sort((a,b)=> a.date.localeCompare(b.date));
  const recomputed = recomputeChanges(sortedAsc);
  const rows = recomputed.map(e => ({
    user_id: SESSION.user.id,
    entry_date: e.date,
    weight: e.weight,
    change_percent: e.changePercent,
    change_from_baseline_percent: e.baselinePercent
  }));
  const { error } = await supabase.from('weight_entries').upsert(rows, { onConflict: 'user_id,entry_date' });
  if(!error){
    ENTRIES = recomputed;
  }
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
  const streak = computeStreak(ENTRIES.map(e => e.date).sort());
  const streakLine = (streak.active && streak.count > 1) ? `<div class="streak-line">🔥 连续打卡 ${streak.count} 天</div>` : '';
  const hiddenLine = (PROFILE.visible_on_wall === false) ? `<div class="hidden-line">🙈 已从团队墙隐藏</div>` : '';
  panel.innerHTML = `
    <div class="whoami">
      <div class="av">${PROFILE.avatar}</div>
      <div class="name">${escapeHtml(PROFILE.name)}${streakLine}${hiddenLine}</div>
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
        <div class="entry-changes">
          <div class="entry-change ${changeClass(e.changePercent)}">${changeLabel(e.changePercent)}</div>
          <div class="entry-baseline">较起始 ${changeLabel(e.baselinePercent)}</div>
        </div>
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
  const baselineWeight = sortedAsc.length ? sortedAsc[0].weight : null;
  for(let i=0;i<sortedAsc.length;i++){
    const cur = sortedAsc[i];
    let changePercent = null;
    if(i > 0){
      const prev = sortedAsc[i-1];
      changePercent = Math.round(((cur.weight - prev.weight) / prev.weight) * 10000) / 100;
    }
    const baselinePercent = Math.round(((cur.weight - baselineWeight) / baselineWeight) * 10000) / 100;
    out.push({ date: cur.date, weight: cur.weight, changePercent, baselinePercent });
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
    change_percent: e.changePercent,
    change_from_baseline_percent: e.baselinePercent
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
      change_percent: e.changePercent,
      change_from_baseline_percent: e.baselinePercent
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
  let pendingVisible = PROFILE.visible_on_wall !== false;
  const backdrop = document.createElement('div');
  backdrop.className = 'modal-backdrop';
  backdrop.innerHTML = `
    <div class="modal">
      <h3>编辑资料</h3>
      <label class="field-label" for="edit-name">昵称</label>
      <input id="edit-name" type="text" value="${escapeHtml(PROFILE.name)}" maxlength="20" style="margin-bottom:16px" />
      <label class="field-label">头像</label>
      <div class="avatar-grid" id="edit-avatars"></div>
      <div class="visibility-toggle-row">
        <div>
          <div class="visibility-toggle-title">在团队墙上展示</div>
          <div class="visibility-toggle-sub">关掉之后，你会从团队墙上消失。你自己的记录不受影响，随时可以再打开。</div>
        </div>
        <button type="button" class="toggle-switch" id="visibility-toggle" role="switch"></button>
      </div>
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
  const toggleBtn = document.getElementById('visibility-toggle');
  const syncToggleUI = ()=> toggleBtn.classList.toggle('on', pendingVisible);
  syncToggleUI();
  toggleBtn.onclick = ()=>{ pendingVisible = !pendingVisible; syncToggleUI(); };

  document.getElementById('edit-cancel').onclick = ()=> backdrop.remove();
  document.getElementById('edit-save').onclick = async ()=>{
    const newName = document.getElementById('edit-name').value.trim();
    if(!newName){ showToast('昵称不能为空'); return; }
    const { error } = await supabase
      .from('profiles')
      .update({ name: newName, avatar: pendingAvatar, visible_on_wall: pendingVisible })
      .eq('id', SESSION.user.id);
    if(error){ showToast('更新失败，请重试'); return; }
    PROFILE = { ...PROFILE, name: newName, avatar: pendingAvatar, visible_on_wall: pendingVisible };
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
    .select('user_id, name, avatar, entry_date, change_percent, change_from_baseline_percent')
    .order('entry_date', { ascending: false });

  if(error){
    panel.innerHTML = `<div class="empty">团队墙加载失败，请稍后重试。</div>`;
    return;
  }

  const byUser = new Map();
  for(const row of data){
    if(!byUser.has(row.user_id)) byUser.set(row.user_id, []);
    byUser.get(row.user_id).push(row);
  }
  for(const arr of byUser.values()) arr.sort((a,b)=> a.entry_date.localeCompare(b.entry_date));

  const members = [...byUser.values()].map(arr => {
    const latest = arr[arr.length - 1];
    const streak = computeStreak(arr.map(r => r.entry_date));

    // weekly change: compare the latest baseline-% to whichever entry sits
    // at least 7 days before it (falling back to their very first entry if
    // they haven't been in the team a week yet).
    let weeklyChangePercent = null;
    const hasLatestBaseline = latest.change_from_baseline_percent !== null && latest.change_from_baseline_percent !== undefined;
    if(hasLatestBaseline){
      let ref = null;
      for(let i = arr.length - 1; i >= 0; i--){
        if(daysBetween(arr[i].entry_date, latest.entry_date) >= 7){ ref = arr[i]; break; }
      }
      if(!ref) ref = arr[0];
      const hasRefBaseline = ref.change_from_baseline_percent !== null && ref.change_from_baseline_percent !== undefined;
      if(hasRefBaseline && ref.entry_date !== latest.entry_date){
        weeklyChangePercent = pctBetweenBaselinePoints(Number(ref.change_from_baseline_percent), Number(latest.change_from_baseline_percent));
      }
    }

    return { ...latest, streak, weeklyChangePercent };
  });

  const rows = members.sort((a,b)=> b.entry_date.localeCompare(a.entry_date));
  const totalDown = rows.filter(r => r.change_from_baseline_percent !== null && Number(r.change_from_baseline_percent) < 0).length;

  // today's champion: whoever logged today with the biggest day-over-day drop
  const today = todayStr();
  const todaysDrops = rows.filter(r => r.entry_date === today && r.change_percent !== null && Number(r.change_percent) < 0);
  const champion = todaysDrops.length
    ? todaysDrops.reduce((best, r) => Number(r.change_percent) < Number(best.change_percent) ? r : best)
    : null;

  // weekly star: biggest actual weekly loss, if anyone has one
  const weeklyCandidates = rows.filter(r => r.weeklyChangePercent !== null && r.weeklyChangePercent < 0);
  const weeklyStar = weeklyCandidates.length
    ? weeklyCandidates.reduce((best, r) => r.weeklyChangePercent < best.weeklyChangePercent ? r : best)
    : null;

  panel.innerHTML = `
    <div class="wall-head">
      <div class="big-stat">${totalDown}</div>
      <div class="big-stat-label">位队友已经比自己的起始体重更轻</div>
    </div>
    <div class="privacy-note">👀 团队墙只显示增减百分比，不会显示任何人的具体体重。</div>
    ${weeklyStar ? `
    <div class="weekly-star-card">
      <div class="weekly-star-label">🏅 本周之星</div>
      <div class="weekly-star-body">
        <div class="wall-av weekly-star-av">${weeklyStar.avatar}</div>
        <div class="weekly-star-info">
          <div class="weekly-star-name">${escapeHtml(weeklyStar.name)}</div>
          <div class="weekly-star-sub">过去 7 天进步最大</div>
        </div>
        <div class="weekly-star-pct">${changeLabel(weeklyStar.weeklyChangePercent)}</div>
      </div>
    </div>` : ''}
    <div id="wall-list"></div>
  `;
  const list = document.getElementById('wall-list');
  if(rows.length === 0){
    list.innerHTML = `<div class="empty">还没有队友同步记录，记完第一条就会出现在这里。</div>`;
    return;
  }
  rows.forEach(m=>{
    // change_from_baseline_percent can briefly be NULL for rows saved before
    // this feature existed, until the owner's client backfills it — never
    // treat that as a real 0% change.
    const hasBaseline = m.change_from_baseline_percent !== null && m.change_from_baseline_percent !== undefined;
    const baselinePct = hasBaseline ? Number(m.change_from_baseline_percent) : null;
    const latestPct = m.change_percent === null ? null : Number(m.change_percent);
    const isChampion = champion && m.user_id === champion.user_id;
    const streakBadge = (m.streak.active && m.streak.count > 1) ? ` · 🔥 连续${m.streak.count}天` : '';
    const row = document.createElement('div');
    row.className = 'wall-row' + (isChampion ? ' wall-row-champion' : '');
    row.innerHTML = `
      <div class="wall-av">${m.avatar}</div>
      <div class="wall-info">
        <div class="wall-name">${escapeHtml(m.name)}${isChampion ? ' <span class="champion-badge">👑 今日之星</span>' : ''}</div>
        <div class="wall-date">${fmtDate(m.entry_date)} 更新${streakBadge}</div>
      </div>
      <div class="wall-changes">
        <div class="wall-change ${hasBaseline ? changeClass(baselinePct) : 'change-flat'}">${hasBaseline ? changeLabel(baselinePct) : '待同步'}</div>
        <div class="wall-change-sub">较起始体重${latestPct===null ? '' : ` · 最新 ${changeLabel(latestPct)}`}</div>
      </div>
    `;
    list.appendChild(row);
  });
}

boot();
