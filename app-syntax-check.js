
/* =========================================================================
   SECURITY: HTML ESCAPING
   Every piece of user-supplied text that gets inserted via innerHTML MUST
   pass through esc() first. This is what closes the stored-XSS hole that
   existed when user input (income/expense/goal names) was interpolated
   directly into innerHTML and into onclick="...JSON.stringify(x)..." strings.
========================================================================= */
function esc(str){
  if(str === null || str === undefined) return '';
  return String(str).replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

/* Wraps `new Chart(...)` so a CDN hiccup that leaves Chart.js undefined
   degrades to "no chart shown" instead of an uncaught ReferenceError that
   aborts the rest of the page render (dashboard/reports have several
   charts in sequence — one missing library shouldn't blank the whole page). */
function safeChart(ctx, config){
  if(typeof Chart === 'undefined'){
    console.error('Chart.js غير محمّل — تعذر رسم هذا المخطط، لكن باقي الصفحة تعمل بشكل طبيعي.');
    return null;
  }
  return new Chart(ctx, config);
}

/* =========================================================================
   SUPABASE CLIENT (real backend: Postgres + Auth with password hashing + JWT)
   Fill in SUPABASE_URL / SUPABASE_ANON_KEY in config.js (see config.example.js
   and schema.sql in the project root for full setup instructions).
========================================================================= */
const sb = (window.SUPABASE_URL && window.SUPABASE_ANON_KEY)
  ? window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY)
  : null;

if(!sb){
  console.error('لم يتم ضبط Supabase بعد. أنشئ ملف config.js من config.example.js وضع فيه بيانات مشروعك.');
}

/* =========================================================================
   DB LAYER — thin mapping between our camelCase JS objects and Supabase's
   snake_case Postgres columns, plus small CRUD wrappers. Every table has
   Row Level Security enabled (see schema.sql) so these queries only ever
   see/touch the signed-in user's own rows — enforced server-side, not by
   client code.
========================================================================= */
const db = {
  tableName(table){ return table === 'income' ? 'income_sources' : table; },
  income: {
    fromDb: r => ({id:r.id, name:r.name, amount:Number(r.amount), recurrence:r.recurrence, months:r.months, day:r.due_day, createdMonthIdx:r.created_month_idx, revisions:r.revisions||[]}),
    toDb: i => ({name:i.name, amount:i.amount, recurrence:i.recurrence, months:i.months, due_day:i.day, created_month_idx:i.createdMonthIdx, revisions:i.revisions||[]}),
  },
  expenses: {
    fromDb: r => ({id:r.id, name:r.name, amount:Number(r.amount), category:r.category, type:r.type, duration:r.duration, startMonthIdx:r.start_month_idx, revisions:r.revisions||[]}),
    toDb: e => ({name:e.name, amount:e.amount, category:e.category, type:e.type, duration:e.duration, start_month_idx:e.startMonthIdx, revisions:e.revisions||[]}),
  },
  goals: {
    fromDb: (r, deposits=[], installments=[]) => ({id:r.id, name:r.name, target:Number(r.target), current:Number(r.initial_amount)+deposits.reduce((sum,d)=>sum+Number(d.amount),0), months:r.months, startMonthIdx:r.start_month_idx, deposits:deposits.map(d=>({amount:Number(d.amount),monthIdx:d.month_idx})), installments}),
    toDb: g => ({name:g.name, target:g.target, initial_amount:g.current, months:g.months, start_month_idx:g.startMonthIdx}),
  },
  async loadAll(){
    const queries = await Promise.all([
      sb.from('profiles').select('*').maybeSingle(),
      sb.from('income_sources').select('*').order('id'),
      sb.from('expenses').select('*').order('id'),
      sb.from('goals').select('*').order('id'),
      sb.from('goal_deposits').select('goal_id,amount,month_idx').order('id'),
      sb.from('goal_installments').select('id,goal_id,month_idx,planned_amount,paid_amount,paid_at,deposit_id').order('month_idx'),
    ]);
    const failed = queries.find(r=>r.error);
    if(failed) throw failed.error;
    const [profile, income, expenses, goals, deposits, installments] = queries.map(x=>x.data);
    if(!profile) throw new Error('Missing profile for the logged-in account');
    state.user = {id:profile.id, name:profile.name, email:state.session.user.email, currency:profile.currency};
    state.onboarded = !!profile.onboarded;
    state.income = (income||[]).map(this.income.fromDb);
    state.expenses = (expenses||[]).map(this.expenses.fromDb);
    const byGoal = new Map();
    (deposits||[]).forEach(d=>byGoal.set(String(d.goal_id), [...(byGoal.get(String(d.goal_id))||[]),d]));
    const byGoalInstallments = new Map();
    (installments||[]).forEach(x=>byGoalInstallments.set(String(x.goal_id), [...(byGoalInstallments.get(String(x.goal_id))||[]),x]));
    state.goals = (goals||[]).map(g=>this.goals.fromDb(g,byGoal.get(String(g.id))||[],byGoalInstallments.get(String(g.id))||[]));
  },
  async insert(table,obj){
    if(!state.session?.user?.id) throw new Error('Sign in first');
    const payload = {...this[table].toDb(obj), user_id:state.session.user.id};
    const {data,error} = await sb.from(this.tableName(table)).insert(payload).select().single();
    if(error) throw error;
    return this[table].fromDb(data);
  },
  async update(table,id,obj){
    const patch = table === 'goals'
      ? {name:obj.name,target:obj.target,months:obj.months,start_month_idx:obj.startMonthIdx}
      : this[table].toDb(obj);
    const {data,error} = await sb.from(this.tableName(table))
      .update(patch).eq('id',id).eq('user_id',state.session.user.id).select('id');
    if(error) throw error;
    if(!data?.length) throw new Error('No record was updated');
  },
  async addGoalDeposit(goalId,amount){
    const {error} = await sb.rpc('fn_add_deposit',{p_goal_id:Number(goalId),p_amount:amount});
    if(error) throw error;
    // Read back the authoritative total; retrying an ambiguous network failure
    // still needs idempotency, which is scheduled for the next backend migration.
    const {data:g,error:goalError} = await sb.from('goals').select('initial_amount').eq('id',goalId).single();
    if(goalError) throw goalError;
    const {data:ds,error:depError} = await sb.from('goal_deposits').select('amount').eq('goal_id',goalId);
    if(depError) throw depError;
    return Number(g.initial_amount)+(ds||[]).reduce((a,d)=>a+Number(d.amount),0);
  },
  async payGoalInstallment(goalId,monthIdx,amount){
    const {data,error}=await sb.rpc('fn_pay_goal_installment',{p_goal_id:Number(goalId),p_month_idx:Number(monthIdx),p_amount:amount});
    if(error) throw error; return Number(data);
  },
  async unpayGoalInstallment(goalId,monthIdx){
    const {data,error}=await sb.rpc('fn_unpay_goal_installment',{p_goal_id:Number(goalId),p_month_idx:Number(monthIdx)});
    if(error) throw error; return Number(data);
  },
  async loadGoalInstallments(goalId){
    const {data,error}=await sb.from('goal_installments').select('id,goal_id,month_idx,planned_amount,paid_amount,paid_at,deposit_id').eq('goal_id',goalId).order('month_idx');
    if(error) throw error; return data||[];
  },
  async remove(table,id){
    const {data,error} = await sb.from(this.tableName(table)).delete()
      .eq('id',id).eq('user_id',state.session.user.id).select('id');
    if(error) throw error;
    if(!data?.length) throw new Error('No record was deleted');
  },
};
function dbErrorToast(err){
  console.error(err);
  toast('حدث خطأ أثناء الاتصال بقاعدة البيانات، حاول مرة أخرى', true);
}

/* =========================================================================
   DATA MODEL
========================================================================= */
const CATEGORY_META = {
  'سكن':      {color:'#D9A441', icon:'🏠'},
  'فواتير':   {color:'#3FA796', icon:'💡'},
  'تسوق':     {color:'#E2604F', icon:'🛍️'},
  'ترفيه':    {color:'#8D93BC', icon:'🎬'},
  'التزامات': {color:'#6BC7B8', icon:'📑'},
  'أخرى':     {color:'#5B6190', icon:'📦'},
};

let state = {
  session: null,          // Supabase auth session (JWT) — null until signed in
  demoMode: false,        // true only for the local-only "تجربة توضيحية" preview, never persisted
  user: null,             // {id,name,email,currency} — from `profiles` table, no password ever stored client-side
  onboarded: false,
  income: [],             // {id,name,amount,recurrence,months,day,createdMonthIdx,revisions:[{effectiveMonthIdx,...}]}
  expenses: [],           // {id,name,amount,category,type,duration,startMonthIdx,revisions:[{effectiveMonthIdx,...}]}
  goals: [],              // {id,name,target,current,months,startMonthIdx,deposits,installments}
  goalPlanEdit: {},
};

const now = new Date();
const CUR_MONTH_IDX = now.getFullYear()*12 + now.getMonth();
const MONTH_NAMES = ['يناير','فبراير','مارس','أبريل','مايو','يونيو','يوليو','أغسطس','سبتمبر','أكتوبر','نوفمبر','ديسمبر'];

function monthIdxToLabel(idx){
  const y = Math.floor(idx/12), m = idx%12;
  return MONTH_NAMES[m] + ' ' + y;
}
function fmt(n){
  n = Math.round(n);
  return n.toLocaleString('en-US');
}
function monthInputValue(idx){const y=Math.floor(idx/12),m=(idx%12)+1;return `${y}-${String(m).padStart(2,'0')}`;}
function monthInputToIdx(value){if(!value)return CUR_MONTH_IDX;const [y,m]=value.split('-').map(Number);return y*12+(m-1);}
function goalInstallmentRows(g){const paid=new Map((g.installments||[]).filter(x=>x.paid_at).map(x=>[Number(x.month_idx),x]));const rows=[];for(let i=0;i<Number(g.months);i++){const monthIdx=Number(g.startMonthIdx)+i;rows.push({monthIdx,paid:paid.get(monthIdx)||null});}return rows;}
function goalPlanAmount(g){const rows=goalInstallmentRows(g);const remaining=Math.max(0,Number(g.target)-Number(g.current));const open=rows.filter(x=>!x.paid);return open.length?remaining/open.length:0;}
function currency(){ return (state.user && state.user.currency) || 'ر.س'; }

/* =========================================================================
   REVISION RESOLUTION
   Fixes "تعديل المصاريف بدون كتابة فوق التاريخ المالي": editing an income
   or expense item no longer mutates its amount/name/category in place.
   Instead it appends a {effectiveMonthIdx, ...changedFields} revision.
   Any month calculation looks up the value that was EFFECTIVE during that
   specific month, so past months keep showing what was actually true then,
   while the current/future months reflect the edit.
========================================================================= */
function valuesAtMonth(item, monthIdx, fields){
  const out = {};
  fields.forEach(f => out[f] = item[f]);
  (item.revisions || [])
    .filter(r => r.effectiveMonthIdx <= monthIdx)
    .sort((a,b) => a.effectiveMonthIdx - b.effectiveMonthIdx)
    .forEach(r => fields.forEach(f => { if(r[f] !== undefined) out[f] = r[f]; }));
  return out;
}
const INCOME_REVISION_FIELDS = ['name','amount'];
const EXPENSE_REVISION_FIELDS = ['name','amount','category'];
// What the item looks like RIGHT NOW (for lists/edit-forms) — as opposed to
// valuesAtMonth(item, someMonthIdx, ...) which is what it looked like THEN.
function currentView(item, fields){ return {...item, ...valuesAtMonth(item, CUR_MONTH_IDX, fields)}; }

/* Called by the edit forms: instead of Object.assign-ing over the item,
   decide whether a real "past" exists yet. If we're still in the item's
   very first active month, there's no history to protect, so we can just
   write the base fields directly. Otherwise we record a dated revision. */
function applyEditWithHistory(item, changes, fields, startMonthIdx){
  const hasHistory = CUR_MONTH_IDX > startMonthIdx;
  if(!hasHistory){
    Object.assign(item, changes);
    return;
  }
  const changedFields = {};
  let changed = false;
  fields.forEach(f => {
    if(changes[f] !== undefined && changes[f] !== item[f]){ changedFields[f] = changes[f]; changed = true; }
  });
  // non-history fields (recurrence/months/day for income; type/duration/startMonthIdx for expenses)
  // are structural, not "amounts spent in the past" — safe to update directly.
  Object.keys(changes).forEach(f => { if(!fields.includes(f)) item[f] = changes[f]; });
  if(changed){
    item.revisions = item.revisions || [];
    item.revisions.push({ effectiveMonthIdx: CUR_MONTH_IDX, ...changedFields });
  }
}

/* =========================================================================
   CALCULATION ENGINE
========================================================================= */
const engine = {
  monthlyIncome(monthIdx){
    return state.income.reduce((sum, inc0) => {
      const inc = valuesAtMonth(inc0, monthIdx, INCOME_REVISION_FIELDS);
      if(inc0.recurrence === 'monthly' && monthIdx >= inc0.createdMonthIdx) return sum + inc.amount;
      if(inc0.recurrence === 'limited'){
        const end = inc0.createdMonthIdx + (inc0.months||1) - 1;
        if(monthIdx >= inc0.createdMonthIdx && monthIdx <= end) return sum + inc.amount;
        return sum;
      }
      // irregular: only counts in its creation month for projection purposes
      if(inc0.recurrence === 'irregular' && monthIdx === inc0.createdMonthIdx) return sum + inc.amount;
      return sum;
    }, 0);
  },
  monthlyExpenses(monthIdx, list){
    list = list || state.expenses;
    return list.reduce((sum, ex0) => {
      const end = ex0.startMonthIdx + (ex0.duration||1) - 1;
      if(monthIdx >= ex0.startMonthIdx && monthIdx <= end){
        const ex = valuesAtMonth(ex0, monthIdx, EXPENSE_REVISION_FIELDS);
        return sum + ex.amount;
      }
      return sum;
    }, 0);
  },
  expensesByCategory(monthIdx){
    const map = {};
    state.expenses.forEach(ex0 => {
      const end = ex0.startMonthIdx + (ex0.duration||1) - 1;
      if(monthIdx >= ex0.startMonthIdx && monthIdx <= end){
        const ex = valuesAtMonth(ex0, monthIdx, EXPENSE_REVISION_FIELDS);
        map[ex.category] = (map[ex.category]||0) + ex.amount;
      }
    });
    return map;
  },
  surplus(monthIdx){
    return this.monthlyIncome(monthIdx) - this.monthlyExpenses(monthIdx);
  },
  goalRequiredMonthly(goal){
    const remaining = Math.max(goal.target - goal.current, 0);
    const monthsLeft = Math.max(goal.months - Math.max(0,CUR_MONTH_IDX - goal.startMonthIdx), 1);
    return remaining / monthsLeft;
  },
  goalStatus(goal){
    const req = this.goalRequiredMonthly(goal);
    const surplus = this.surplus(CUR_MONTH_IDX);
    const totalNeeded = state.goals.reduce((s,g)=>s+this.goalRequiredMonthly(g),0);
    if(surplus >= totalNeeded) return {ok:true, deficit:0, req};
    return {ok:false, deficit:Math.max(totalNeeded - surplus,0), req};
  },
  projection(months){
    // cumulative savings projection starting from goals' current totals baseline 0
    const out = [];
    let cumulative = 0;
    for(let i=0;i<months;i++){
      const idx = CUR_MONTH_IDX + i;
      const s = this.surplus(idx);
      cumulative += s;
      out.push({idx, label: MONTH_NAMES[idx%12].slice(0,3), surplus:s, cumulative});
    }
    return out;
  }
};

/* =========================================================================
   ROUTER
========================================================================= */
/* =========================================================================
   ROUTER — real hash-based routing.
   The URL (#/dashboard, #/income, ...) is the single source of truth for
   which screen is shown. go() just changes location.hash; a 'hashchange'
   listener (registered at the bottom, in INIT) does the actual rendering.
   This gives working back/forward buttons and shareable/deep-linkable URLs,
   instead of the old version which only mutated in-memory state.
========================================================================= */
const VALID_ROUTES = ['landing','signup','login','reset','onboarding','dashboard','income','expenses','goals','reports','profile'];
const APP_PAGES = ['dashboard','income','expenses','goals','reports','profile'];

const router = {
  current: 'landing',
  go(name){
    if(!VALID_ROUTES.includes(name)) name = 'landing';
    const target = '#/' + name;
    if(location.hash === target){
      this.render(name); // same hash won't fire hashchange — render directly
    } else {
      location.hash = target;
    }
  },
  parseHash(){
    const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0];
    return VALID_ROUTES.includes(raw) ? raw : 'landing';
  },
  render(name){
    // auth/onboarding guards — redirect (via hash, so URL stays consistent)
    if(APP_PAGES.includes(name) && !(state.user && state.onboarded)){
      const fallback = state.user ? 'onboarding' : 'login';
      if(fallback !== name){ location.replace('#/' + fallback); return; }
      name = fallback;
    }
    if(name === 'onboarding' && !state.user){ location.replace('#/signup'); return; }

    ['landing','signup','login','reset','onboarding'].forEach(v=>{
      document.getElementById('view-'+v).classList.toggle('hidden', v!==name);
    });
    const appView = document.getElementById('view-app');
    if(APP_PAGES.includes(name)){
      appView.classList.add('show');
      document.querySelectorAll('.page').forEach(p=>p.classList.add('hidden'));
      document.getElementById('page-'+name).classList.remove('hidden');
      document.querySelectorAll('.side-link').forEach(l=>l.classList.toggle('active', l.dataset.route===name));
      app.renderPage(name);
    } else {
      appView.classList.remove('show');
    }
    this.current = name;
    window.scrollTo({top:0, behavior:'instant'});
  }
};
window.addEventListener('hashchange', () => router.render(router.parseHash()));

/* =========================================================================
   TOAST
========================================================================= */
function toast(msg, warn){
  const stack = document.getElementById('toastStack');
  const el = document.createElement('div');
  el.className = 'toast' + (warn ? ' warn' : '');
  el.textContent = msg;
  stack.appendChild(el);
  setTimeout(()=>{ el.style.opacity='0'; el.style.transition='opacity .3s'; setTimeout(()=>el.remove(),300); }, 3200);
}

/* =========================================================================
   SVG GOAL PATH (signature element)
========================================================================= */
function renderGoalPath(container, pct, months){
  pct = Math.max(0, Math.min(100, pct));
  const w = 520, h = 90;
  const segCount = Math.max(Math.min(months,18),4);
  let path = `M20,${h-20}`;
  const pts = [];
  for(let i=0;i<=segCount;i++){
    const x = 20 + (w-40) * (i/segCount);
    const y = h-20 - Math.sin(i*0.9)*14;
    pts.push([x,y]);
  }
  path = 'M ' + pts.map(p=>p.join(',')).join(' L ');
  const coinPos = (w-40) * (pct/100) + 20;
  // approximate y on the sine path near coin position
  const coinT = (pct/100) * segCount;
  const coinY = h-20 - Math.sin(coinT*0.9)*14;
  let dashesSvg = '';
  pts.forEach((p,i)=>{
    if(i%2===0) dashesSvg += `<circle cx="${p[0]}" cy="${p[1]}" r="2" fill="var(--ink-faint)" opacity="0.5"/>`;
  });
  container.innerHTML = `
  <svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">
    <path d="${path}" fill="none" stroke="var(--navy-600)" stroke-width="3" stroke-linecap="round"/>
    <path d="${path}" fill="none" stroke="url(#gpGrad)" stroke-width="3" stroke-linecap="round"
      stroke-dasharray="1000" stroke-dashoffset="${1000 - (pct/100)*1000}"/>
    <defs>
      <linearGradient id="gpGrad" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#3FA796"/>
        <stop offset="100%" stop-color="#D9A441"/>
      </linearGradient>
    </defs>
    ${dashesSvg}
    <circle cx="${w-20}" cy="${h-20-Math.sin(segCount*0.9)*14}" r="7" fill="var(--navy-800)" stroke="var(--gold-500)" stroke-width="2"/>
    <circle cx="${coinPos}" cy="${coinY}" r="9" fill="#D9A441" stroke="#0F1429" stroke-width="2"/>
    <text x="${coinPos}" y="${coinY-16}" text-anchor="middle" fill="#E8C077" font-size="12" font-family="IBM Plex Mono" font-weight="600">${Math.round(pct)}%</text>
  </svg>`;
}

/* =========================================================================
   APP LOGIC
========================================================================= */
const app = {
  charts: {},
  activeExpenseFilter: 'all',

  /* ---------- AUTH ----------
     Real auth now lives in Supabase: passwords are hashed server-side
     (Supabase uses bcrypt) and never touch this client as anything but
     a one-time submission over HTTPS; a JWT session is what's kept
     locally (in sb's own storage), not a password. See db.js. */
  async demoLogin(){
    // Local-only preview: NOT a real backend session, nothing is persisted.
    // Useful for trying the UI on GitHub Pages without creating a Supabase
    // account. Clearly marked in the sidebar so nobody mistakes it for a
    // saved account.
    state.demoMode = true;
    state.user = {id:null, name:'سارة العتيبي (تجريبي)', email:'demo@example.com', currency:'ر.س'};
    state.onboarded = true;
    state.income = [
      {id:'d1', name:'راتب أساسي', amount:12500, recurrence:'monthly', months:null, day:27, createdMonthIdx: CUR_MONTH_IDX-3, revisions:[]},
      {id:'d2', name:'مشروع تصميم حر', amount:1800, recurrence:'limited', months:4, day:5, createdMonthIdx: CUR_MONTH_IDX-1, revisions:[]},
    ];
    state.expenses = [
      {id:'d3', name:'إيجار الشقة', amount:3800, category:'سكن', type:'fixed', duration:12, startMonthIdx: CUR_MONTH_IDX-2, revisions:[]},
      {id:'d4', name:'فاتورة كهرباء وماء', amount:420, category:'فواتير', type:'variable', duration:12, startMonthIdx: CUR_MONTH_IDX-2, revisions:[]},
      {id:'d5', name:'اشتراك انترنت وجوال', amount:280, category:'فواتير', type:'fixed', duration:12, startMonthIdx: CUR_MONTH_IDX-2, revisions:[]},
      {id:'d6', name:'قسط سيارة', amount:1450, category:'التزامات', type:'fixed', duration:24, startMonthIdx: CUR_MONTH_IDX-6, revisions:[]},
      {id:'d7', name:'تسوق ومستلزمات', amount:900, category:'تسوق', type:'variable', duration:12, startMonthIdx: CUR_MONTH_IDX-1, revisions:[]},
      {id:'d8', name:'مطاعم وترفيه', amount:650, category:'ترفيه', type:'variable', duration:12, startMonthIdx: CUR_MONTH_IDX-1, revisions:[]},
      {id:'d9', name:'اشتراكات متنوعة', amount:150, category:'أخرى', type:'fixed', duration:12, startMonthIdx: CUR_MONTH_IDX-1, revisions:[]},
    ];
    state.goals = [
      {id:'g1', name:'دفعة أولى — شقة', target:60000, current:37200, months:14, startMonthIdx: CUR_MONTH_IDX-8, deposits:[]},
      {id:'g2', name:'صندوق الطوارئ', target:20000, current:9500, months:10, startMonthIdx: CUR_MONTH_IDX-4, deposits:[]},
      {id:'g3', name:'رحلة سفر عائلية', target:15000, current:2100, months:6, startMonthIdx: CUR_MONTH_IDX-1, deposits:[]},
    ];
    toast('وضع تجريبي محلي — بياناتك هنا لن تُحفظ ✨');
    router.go('dashboard');
    this.refreshSidebar();
  },

  async forgotPassword(){
    if(!sb){ toast('اتصال قاعدة البيانات غير مهيأ', true); return; }
    const email = document.getElementById('li-email').value.trim();
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { toast('اكتب بريد حسابك في خانة البريد أولًا',true); return; }
    try {
      const redirectTo = location.origin + location.pathname + '#/reset';
      const {error} = await sb.auth.resetPasswordForEmail(email, {redirectTo});
      if(error) throw error;
      toast('إذا كان البريد مسجلاً، ستصلك رسالة استعادة كلمة المرور');
    } catch(err){console.error(err);toast('تعذّر إرسال رابط الاستعادة، حاول لاحقاً',true);}
  },

  async logout(){
    if(sb && state.session) { try { await sb.auth.signOut(); } catch(err){ console.error(err); } }
    state.session = null; state.demoMode = false;
    state.user = null; state.onboarded = false;
    state.income = []; state.expenses = []; state.goals = [];
    router.go('landing');
  },

  /* ---------- SIDEBAR ---------- */
  refreshSidebar(){
    if(!state.user) return;
    document.getElementById('sideName').textContent = state.user.name;
    document.getElementById('sideEmail').textContent = state.user.email;
    document.getElementById('sideAvatar').textContent = state.user.name.trim().charAt(0);
  },

  /* ---------- PAGE RENDER DISPATCH ---------- */
  renderPage(name){
    this.refreshSidebar();
    if(name==='dashboard') this.renderDashboard();
    if(name==='income') this.renderIncome();
    if(name==='expenses') this.renderExpenses();
    if(name==='goals') this.renderGoals();
    if(name==='reports') this.renderReports();
    if(name==='profile') this.renderProfile();
  },

  destroyChart(key){ if(this.charts[key]){ this.charts[key].destroy(); delete this.charts[key]; } },

  chartDefaults(){
    if(typeof Chart === 'undefined') return;
    Chart.defaults.font.family = "'IBM Plex Sans Arabic','IBM Plex Mono',sans-serif";
    Chart.defaults.color = '#8D93BC';
    Chart.defaults.borderColor = 'rgba(244,242,234,0.08)';
  },

  /* ---------- DASHBOARD ---------- */
  renderDashboard(){
    this.chartDefaults();
    document.getElementById('dashUserName').textContent = state.user.name.split(' ')[0];
    document.getElementById('curMonthLabel').textContent = monthIdxToLabel(CUR_MONTH_IDX);

    const inc = engine.monthlyIncome(CUR_MONTH_IDX);
    const exp = engine.monthlyExpenses(CUR_MONTH_IDX);
    const sur = inc - exp;
    document.getElementById('kpiIncome').textContent = fmt(inc) + ' ' + currency();
    document.getElementById('kpiExpense').textContent = fmt(exp) + ' ' + currency();
    document.getElementById('kpiSurplus').textContent = fmt(sur) + ' ' + currency();
    document.getElementById('kpiIncomeNote').textContent = state.income.length + ' مصدر دخل نشط';
    document.getElementById('kpiExpenseNote').textContent = state.expenses.length + ' مصروف مسجّل';
    const surCard = document.getElementById('kpiSurplusCard');
    surCard.classList.toggle('deficit', sur < 0);
    document.getElementById('kpiSurplusNote').textContent = sur >= 0 ? 'وضع صحي — قابل للإدخار' : 'تنبيه: مصاريفك تتجاوز دخلك';

    // Expense pie
    const byCat = engine.expensesByCategory(CUR_MONTH_IDX);
    const cats = Object.keys(byCat);
    this.destroyChart('pie');
    const ctxPie = document.getElementById('chartExpensePie').getContext('2d');
    this.charts.pie = safeChart(ctxPie, {
      type:'doughnut',
      data:{ labels:cats, datasets:[{data:cats.map(c=>byCat[c]), backgroundColor:cats.map(c=>CATEGORY_META[c].color), borderColor:'#151B38', borderWidth:3}]},
      options:{ cutout:'68%', plugins:{legend:{display:false}}, responsive:true, maintainAspectRatio:false }
    });
    const legend = document.getElementById('expenseLegend');
    const total = cats.reduce((s,c)=>s+byCat[c],0) || 1;
    legend.innerHTML = cats.length ? cats.map(c=>`
      <div class="legend-item"><span class="dot" style="background:${CATEGORY_META[c].color}"></span>
      <span class="li-name">${c}</span><span class="li-val num">${Math.round(byCat[c]/total*100)}%</span></div>`).join('') :
      '<div class="empty-state" style="padding:20px 0;"><p>لا توجد مصاريف مسجلة بعد</p></div>';

    // Bar next 6 months
    const barMonths = [];
    for(let i=0;i<6;i++){ const idx=CUR_MONTH_IDX+i; barMonths.push({label:MONTH_NAMES[idx%12].slice(0,3), val:engine.monthlyExpenses(idx)}); }
    this.destroyChart('bar');
    this.charts.bar = safeChart(document.getElementById('chartExpenseBar').getContext('2d'), {
      type:'bar',
      data:{labels:barMonths.map(m=>m.label), datasets:[{data:barMonths.map(m=>m.val), backgroundColor:'#E2604F', borderRadius:6, maxBarThickness:34}]},
      options:{plugins:{legend:{display:false}}, responsive:true, maintainAspectRatio:false, scales:{y:{grid:{color:'rgba(244,242,234,0.06)'}}, x:{grid:{display:false}}}}
    });

    // Projection line
    const proj = engine.projection(8);
    this.destroyChart('proj');
    this.charts.proj = safeChart(document.getElementById('chartProjection').getContext('2d'), {
      type:'line',
      data:{labels:proj.map(p=>p.label), datasets:[{label:'إجمالي المدخرات المتوقع', data:proj.map(p=>p.cumulative), borderColor:'#D9A441', backgroundColor:'rgba(217,164,65,0.12)', fill:true, tension:.4, pointRadius:3, pointBackgroundColor:'#D9A441'}]},
      options:{plugins:{legend:{display:false}}, responsive:true, maintainAspectRatio:false, scales:{y:{grid:{color:'rgba(244,242,234,0.06)'}}, x:{grid:{display:false}}}}
    });

    // Goals preview
    const wrap = document.getElementById('dashGoalsPreview');
    if(!state.goals.length){
      wrap.innerHTML = `<div class="empty-state"><div class="es-icon">🎯</div><h4>لا توجد أهداف بعد</h4><p>أنشئ أول هدف مالي لك وابدأ رحلتك</p><button class="btn btn-gold btn-sm" data-action="openGoalModal">+ هدف جديد</button></div>`;
    } else {
      wrap.innerHTML = '';
      state.goals.slice(0,2).forEach(g=>{
        const pct = Math.min(100, (g.current/g.target)*100);
        const st = engine.goalStatus(g);
        const row = document.createElement('div');
        row.style.marginBottom = '14px';
        row.innerHTML = `<div style="display:flex;justify-content:space-between;font-size:13.5px;margin-bottom:6px;">
          <strong>${esc(g.name)}</strong><span class="num" style="color:var(--ink-muted)">${fmt(g.current)} / ${fmt(g.target)} ${currency()}</span></div>
          <div class="progress-track"><div class="progress-fill ${st.ok?'':'deficit'}" style="width:${pct}%;"></div></div>`;
        wrap.appendChild(row);
      });
    }
  },

  /* ---------- INCOME ---------- */
  openIncomeModal(item){
    document.getElementById('incomeForm').reset();
    document.getElementById('income-months-field').classList.add('hidden');
    if(item){
      document.getElementById('incomeModalTitle').textContent = 'تعديل مصدر دخل';
      document.getElementById('income-id').value = item.id;
      document.getElementById('income-name').value = item.name;
      document.getElementById('income-amount').value = item.amount;
      document.getElementById('income-recurrence').value = item.recurrence;
      document.getElementById('income-months').value = item.months||'';
      document.getElementById('income-day').value = item.day||'';
      if(item.recurrence==='limited') document.getElementById('income-months-field').classList.remove('hidden');
    } else {
      document.getElementById('incomeModalTitle').textContent = 'إضافة مصدر دخل';
      document.getElementById('income-id').value = '';
    }
    document.getElementById('modalIncome').classList.remove('hidden');
  },
  closeModal(id){ document.getElementById(id).classList.add('hidden'); },
  editIncome(id){
    const item = state.income.find(i=>String(i.id)===String(id));
    if(item) this.openIncomeModal(currentView(item, INCOME_REVISION_FIELDS));
  },
  renderIncome(){
    document.getElementById('incomeTotalDisplay').textContent = fmt(engine.monthlyIncome(CUR_MONTH_IDX)) + ' ' + currency();
    const list = document.getElementById('incomeList');
    if(!state.income.length){
      list.innerHTML = `<div class="empty-state"><div class="es-icon">💰</div><h4>لا توجد مصادر دخل</h4><p>أضف مصدر دخلك الأول لتبدأ حساب فائضك الشهري</p><button class="btn btn-gold btn-sm" data-action="openIncomeModal">+ إضافة مصدر دخل</button></div>`;
      return;
    }
    const recLabel = {monthly:'شهري ثابت', limited:'محدد المدة', irregular:'غير منتظم'};
    list.innerHTML = state.income.map(inc0 => { const inc = currentView(inc0, INCOME_REVISION_FIELDS); return `
      <div class="item-row income">
        <div class="ir-icon">💵</div>
        <div class="ir-main">
          <div class="ir-title">${esc(inc.name)}</div>
          <div class="ir-meta"><span class="ir-tag">${esc(recLabel[inc.recurrence])}</span>${inc.recurrence==='limited'?`<span class="ir-tag">${esc(inc.months)} شهر</span>`:''}${inc.day?`<span class="ir-tag">يوم ${esc(inc.day)} من كل شهر</span>`:''}</div>
        </div>
        <div class="ir-amount">${fmt(inc.amount)} ${esc(currency())}</div>
        <div class="ir-actions">
          <button class="icon-btn" data-action="editIncome" data-id="${inc.id}" title="تعديل"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="icon-btn danger" data-action="deleteIncome" data-id="${inc.id}" title="حذف"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
        </div>
      </div>`; }).join('');
  },
  async deleteIncome(id){
    if(!state.demoMode && sb){
      try { await db.remove('income', id); } catch(err){ dbErrorToast(err); return; }
    }
    state.income = state.income.filter(i=>String(i.id)!==String(id));
    toast('تم حذف مصدر الدخل');
    this.renderIncome(); this.renderDashboard();
  },

  /* ---------- EXPENSES ---------- */
  selectChip(el, hiddenId){
    el.parentElement.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
    el.classList.add('active');
    document.getElementById(hiddenId).value = el.dataset.val;
  },
  openExpenseModal(item){
    document.getElementById('expenseForm').reset();
    const monthInput = document.getElementById('expense-start');
    const y = Math.floor(CUR_MONTH_IDX/12), m = (CUR_MONTH_IDX%12)+1;
    monthInput.value = `${y}-${String(m).padStart(2,'0')}`;
    document.querySelectorAll('#expenseForm .chip').forEach(c=>c.classList.remove('active'));
    document.querySelector('#expenseForm .chip[data-val="fixed"]').classList.add('active');
    document.getElementById('expense-type').value = 'fixed';
    if(item){
      document.getElementById('expenseModalTitle').textContent = 'تعديل مصروف';
      document.getElementById('expense-id').value = item.id;
      document.getElementById('expense-name').value = item.name;
      document.getElementById('expense-amount').value = item.amount;
      document.getElementById('expense-category').value = item.category;
      document.getElementById('expense-duration').value = item.duration;
      document.getElementById('expense-type').value = item.type;
      document.querySelectorAll('#expenseForm .chip').forEach(c=>c.classList.toggle('active', c.dataset.val===item.type));
      const sy = Math.floor(item.startMonthIdx/12), sm=(item.startMonthIdx%12)+1;
      monthInput.value = `${sy}-${String(sm).padStart(2,'0')}`;
    } else {
      document.getElementById('expenseModalTitle').textContent = 'إضافة مصروف';
      document.getElementById('expense-id').value = '';
    }
    document.getElementById('modalExpense').classList.remove('hidden');
  },
  editExpense(id){
    const item = state.expenses.find(e=>String(e.id)===String(id));
    if(item) this.openExpenseModal(currentView(item, EXPENSE_REVISION_FIELDS));
  },
  filterExpenses(el){
    document.querySelectorAll('#expenseFilterChips .chip').forEach(c=>c.classList.remove('active'));
    el.classList.add('active');
    this.activeExpenseFilter = el.dataset.cat;
    this.renderExpenses(true);
  },
  renderExpenses(skipChips){
    if(!skipChips){
      const chipWrap = document.getElementById('expenseFilterChips');
      chipWrap.innerHTML = '<div class="chip active" data-cat="all" data-action="filterExpenses">الكل</div>' +
        Object.keys(CATEGORY_META).map(c=>`<div class="chip" data-cat="${esc(c)}" data-action="filterExpenses">${esc(CATEGORY_META[c].icon)} ${esc(c)}</div>`).join('');
    }
    const filtered = this.activeExpenseFilter==='all' ? state.expenses : state.expenses.filter(e=>currentView(e, EXPENSE_REVISION_FIELDS).category===this.activeExpenseFilter);
    document.getElementById('expenseTotalDisplay').textContent = fmt(engine.monthlyExpenses(CUR_MONTH_IDX, filtered)) + ' ' + currency();
    const list = document.getElementById('expenseList');
    if(!filtered.length){
      list.innerHTML = `<div class="empty-state"><div class="es-icon">🧾</div><h4>لا توجد مصاريف في هذا التصنيف</h4><p>أضف مصروفاً جديداً أو غيّر الفلتر</p></div>`;
      return;
    }
    const typeLabel = {fixed:'ثابت', variable:'متغير'};
    list.innerHTML = filtered.map(ex0 => {
      const ex = currentView(ex0, EXPENSE_REVISION_FIELDS);
      const endIdx = ex.startMonthIdx + ex.duration - 1;
      const active = CUR_MONTH_IDX >= ex.startMonthIdx && CUR_MONTH_IDX <= endIdx;
      return `
      <div class="item-row expense">
        <div class="ir-icon">${esc(CATEGORY_META[ex.category].icon)}</div>
        <div class="ir-main">
          <div class="ir-title">${esc(ex.name)}</div>
          <div class="ir-meta">
            <span class="ir-tag">${esc(ex.category)}</span>
            <span class="ir-tag">${esc(typeLabel[ex.type])}</span>
            <span class="ir-tag">${esc(ex.duration)} شهر</span>
            <span class="ir-tag">${active ? 'نشط الآن' : (CUR_MONTH_IDX < ex.startMonthIdx ? 'يبدأ لاحقاً' : 'منتهٍ')}</span>
            ${ex.revisions && ex.revisions.length ? '<span class="ir-tag" title="تم تعديل هذا المصروف سابقاً">✎ معدّل</span>' : ''}
          </div>
        </div>
        <div class="ir-amount">${fmt(ex.amount)} ${esc(currency())}</div>
        <div class="ir-actions">
          <button class="icon-btn" data-action="editExpense" data-id="${ex.id}" title="تعديل"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg></button>
          <button class="icon-btn danger" data-action="deleteExpense" data-id="${ex.id}" title="حذف/إيقاف"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0-1 14a2 2 0 01-2 2H7a2 2 0 01-2-2L4 6"/></svg></button>
        </div>
      </div>`;
    }).join('');
  },
  async deleteExpense(id){
    if(!state.demoMode && sb){
      try { await db.remove('expenses', id); } catch(err){ dbErrorToast(err); return; }
    }
    state.expenses = state.expenses.filter(e=>String(e.id)!==String(id));
    toast('تم حذف/إيقاف المصروف');
    this.renderExpenses(); this.renderDashboard();
  },

  /* ---------- GOALS ---------- */
  openGoalModal(item){
    document.getElementById('goalForm').reset();
    if(item){
      document.getElementById('goalModalTitle').textContent = 'تعديل الهدف';
      document.getElementById('goal-id').value = item.id;
      document.getElementById('goal-name').value = item.name;
      document.getElementById('goal-target').value = item.target;
      document.getElementById('goal-current').value = item.current;
      document.getElementById('goal-current').disabled = true;
      document.getElementById('goal-months').value = item.months;
      document.getElementById('goal-start-month').value = monthInputValue(item.startMonthIdx);
    } else {
      document.getElementById('goalModalTitle').textContent = 'هدف مالي جديد';
      document.getElementById('goal-id').value = '';
      document.getElementById('goal-current').value = 0;
      document.getElementById('goal-current').disabled = false;
      document.getElementById('goal-start-month').value = monthInputValue(CUR_MONTH_IDX);
    }
    document.getElementById('modalGoal').classList.remove('hidden');
  },
  editGoal(id){
    const item = state.goals.find(g=>String(g.id)===String(id));
    if(item) this.openGoalModal(item);
  },
  openDepositModal(goalId){
    document.getElementById('depositForm').reset();
    document.getElementById('deposit-goal-id').value = goalId;
    document.getElementById('modalDeposit').classList.remove('hidden');
  },
  openGoalInstallment(goalId,monthIdx){
    const g=state.goals.find(x=>String(x.id)===String(goalId)); if(!g)return;
    const planned=goalPlanAmount(g);
    document.getElementById('installment-goal-id').value=goalId;
    document.getElementById('installment-month-idx').value=monthIdx;
    document.getElementById('installment-amount').value=planned.toFixed(2);
    document.getElementById('installment-planned-label').textContent=fmt(planned)+' '+currency();
    document.getElementById('goalInstallmentTitle').textContent='ادخار '+monthIdxToLabel(Number(monthIdx));
    document.getElementById('modalGoalInstallment').classList.remove('hidden');
  },
  toggleGoalPlanEdit(goalId){state.goalPlanEdit[String(goalId)]=!state.goalPlanEdit[String(goalId)];this.renderGoals();},
  async unpayGoalMonth(goalId,monthIdx){
    const g=state.goals.find(x=>String(x.id)===String(goalId));if(!g)return;
    if(!confirm('سيتم عكس إيداع هذا الشهر وخصمه من رصيد الهدف. هل تريد المتابعة؟'))return;
    try{
      if(state.demoMode){const row=(g.installments||[]).find(x=>Number(x.month_idx)===Number(monthIdx));if(row){g.current=Math.max(0,g.current-Number(row.paid_amount));row.paid_at=null;row.paid_amount=0;}}
      else {if(!sb)throw new Error('Supabase is not configured');g.current=await db.unpayGoalInstallment(g.id,monthIdx);}
      if(!state.demoMode){const {data,error}=await sb.from('goal_installments').select('id,goal_id,month_idx,planned_amount,paid_amount,paid_at,deposit_id').eq('goal_id',g.id);if(error)throw error;g.installments=data||[];}
      toast('تم إلغاء إنجاز الشهر وتحديث الخطة');this.renderGoals();this.renderDashboard();
    }catch(err){dbErrorToast(err);}
  },
  renderGoals(){
    const wrap = document.getElementById('goalsList');
    if(!state.goals.length){
      wrap.innerHTML = `<div class="empty-state"><div class="es-icon">🎯</div><h4>لا توجد أهداف مالية بعد</h4><p>حدد أول هدف ادخاري لك ودع مسار يحسب لك الخطة</p><button class="btn btn-gold btn-sm" data-action="openGoalModal">+ هدف جديد</button></div>`;
      return;
    }
    wrap.innerHTML = '';
    state.goals.forEach(g=>{
      const pct = Math.min(100, (g.current/g.target)*100);
      const st = engine.goalStatus(g);
      const card = document.createElement('div');
      card.className = 'goal-card';
      card.innerHTML = `
        <div class="gc-top">
          <div><h3>${esc(g.name)}</h3><div class="gc-tag">بدأ في ${esc(monthIdxToLabel(g.startMonthIdx))} · مدة ${esc(g.months)} شهر</div></div>
          <div class="status-badge ${st.ok?'ok':'warn'}">${st.ok?'✓ قابل للتحقيق':'⚠ عجز مالي'}</div>
        </div>
        <div class="path-wrap" data-goal="${g.id}"></div>
        <div class="goal-nums">
          <div class="gn"><div class="gn-label">المدخر حالياً</div><div class="gn-val num">${fmt(g.current)} ${esc(currency())}</div></div>
          <div class="gn"><div class="gn-label">المستهدف</div><div class="gn-val num">${fmt(g.target)} ${esc(currency())}</div></div>
          <div class="gn"><div class="gn-label">مطلوب شهرياً</div><div class="gn-val num">${fmt(st.req)} ${esc(currency())}</div></div>
        </div>
        ${!st.ok ? `<div class="goal-suggestion">لتصل لهدفك، يحتاج تزيد المدة لنحو <strong>${Math.ceil((g.target-g.current)/Math.max(engine.surplus(CUR_MONTH_IDX),1))}</strong> شهر إضافي، أو تقلل مصاريفك بمقدار <strong class="num">${fmt(st.deficit)} ${esc(currency())}</strong> شهرياً.</div>` : ''}
        <details class="goal-plan">
          <summary><span>خطة الادخار الشهرية · ${goalInstallmentRows(g).filter(x=>x.paid).length} من ${g.months} أشهر مكتملة</span><span>⌄</span></summary>
          <div class="goal-month-list">${goalInstallmentRows(g).map(row=>{const done=!!row.paid;const amount=done?Number(row.paid.paid_amount):goalPlanAmount(g);return `<div class="goal-month-row"><div><strong>${esc(monthIdxToLabel(row.monthIdx))}</strong><div class="goal-month-meta">${done?'المبلغ المدخر: '+fmt(amount):'المطلوب حالياً: '+fmt(amount)} ${esc(currency())}</div></div><span class="status-badge ${done?'ok':'warn'}">${done?'مكتمل':'غير مكتمل'}</span><div class="goal-month-actions">${done?`<span aria-label="مكتمل">✓</span>${state.goalPlanEdit[String(g.id)]?`<button class="btn btn-ghost btn-sm goal-plan-edit" data-action="unpayGoalMonth" data-id="${g.id}" data-month="${row.monthIdx}">إلغاء</button>`:''}`:`<button class="btn btn-teal btn-sm" data-action="payGoalMonth" data-id="${g.id}" data-month="${row.monthIdx}">إيداع الشهر</button>`}</div></div>`;}).join('')}</div>
          <button class="btn btn-ghost btn-sm goal-plan-edit" style="margin-top:10px" data-action="toggleGoalPlanEdit" data-id="${g.id}">${state.goalPlanEdit[String(g.id)]?'إنهاء التعديل':'تعديل الخطة'}</button>
        </details>
        <div class="goal-actions">
          <button class="btn btn-teal btn-sm" data-action="openDepositModal" data-id="${g.id}">+ إضافة إدخار</button>
          <button class="btn btn-ghost btn-sm" data-action="editGoal" data-id="${g.id}">تعديل</button>
          <button class="btn btn-danger btn-sm" data-action="deleteGoal" data-id="${g.id}">حذف</button>
        </div>
      `;
      wrap.appendChild(card);
      renderGoalPath(card.querySelector('.path-wrap'), pct, g.months);
    });
  },
  async deleteGoal(id){
    if(!state.demoMode && sb){
      try { await db.remove('goals', id); } catch(err){ dbErrorToast(err); return; }
    }
    state.goals = state.goals.filter(g=>String(g.id)!==String(id));
    toast('تم حذف الهدف');
    this.renderGoals(); this.renderDashboard();
  },

  /* ---------- REPORTS ---------- */
  renderReports(){
    this.chartDefaults();
    const byCat = engine.expensesByCategory(CUR_MONTH_IDX);
    const cats = Object.keys(byCat);
    this.destroyChart('rpie');
    this.charts.rpie = safeChart(document.getElementById('reportPie').getContext('2d'), {
      type:'pie',
      data:{labels:cats, datasets:[{data:cats.map(c=>byCat[c]), backgroundColor:cats.map(c=>CATEGORY_META[c].color), borderColor:'#151B38', borderWidth:3}]},
      options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom', labels:{padding:14}}}}
    });

    const fixedTotal = state.expenses.filter(e=>e.type==='fixed').reduce((s,e)=>{
      const end=e.startMonthIdx+e.duration-1; return CUR_MONTH_IDX>=e.startMonthIdx&&CUR_MONTH_IDX<=end?s+e.amount:s;
    },0);
    const varTotal = state.expenses.filter(e=>e.type==='variable').reduce((s,e)=>{
      const end=e.startMonthIdx+e.duration-1; return CUR_MONTH_IDX>=e.startMonthIdx&&CUR_MONTH_IDX<=end?s+e.amount:s;
    },0);
    this.destroyChart('rfv');
    this.charts.rfv = safeChart(document.getElementById('reportFixedVar').getContext('2d'), {
      type:'doughnut',
      data:{labels:['ثابت','متغير'], datasets:[{data:[fixedTotal,varTotal], backgroundColor:['#D9A441','#3FA796'], borderColor:'#151B38', borderWidth:3}]},
      options:{cutout:'60%', responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}}
    });

    const months = [];
    for(let i=0;i<6;i++){
      const idx = CUR_MONTH_IDX+i;
      months.push({label:MONTH_NAMES[idx%12].slice(0,3), inc:engine.monthlyIncome(idx), exp:engine.monthlyExpenses(idx)});
    }
    this.destroyChart('rcombo');
    this.charts.rcombo = safeChart(document.getElementById('reportCombo').getContext('2d'), {
      data:{
        labels:months.map(m=>m.label),
        datasets:[
          {type:'bar', label:'الدخل', data:months.map(m=>m.inc), backgroundColor:'#3FA796', borderRadius:6, maxBarThickness:28},
          {type:'bar', label:'المصاريف', data:months.map(m=>m.exp), backgroundColor:'#E2604F', borderRadius:6, maxBarThickness:28},
          {type:'line', label:'الفائض', data:months.map(m=>m.inc-m.exp), borderColor:'#D9A441', tension:.4, pointBackgroundColor:'#D9A441'}
        ]
      },
      options:{responsive:true, maintainAspectRatio:false, plugins:{legend:{position:'bottom'}}, scales:{y:{grid:{color:'rgba(244,242,234,0.06)'}}, x:{grid:{display:false}}}}
    });

    this.destroyChart('rgoals');
    this.charts.rgoals = safeChart(document.getElementById('reportGoals').getContext('2d'), {
      type:'bar',
      data:{labels:state.goals.map(g=>g.name), datasets:[{data:state.goals.map(g=>Math.min(100,(g.current/g.target)*100)), backgroundColor:'#D9A441', borderRadius:8, maxBarThickness:36}]},
      options:{indexAxis:'y', responsive:true, maintainAspectRatio:false, plugins:{legend:{display:false}}, scales:{x:{min:0,max:100,grid:{color:'rgba(244,242,234,0.06)'}}, y:{grid:{display:false}}}}
    });
  },

  /* ---------- PROFILE ---------- */
  renderProfile(){
    document.getElementById('prof-name').value = state.user.name;
    document.getElementById('prof-email').value = state.user.email;
    document.getElementById('prof-currency').value = state.user.currency;
    document.getElementById('profCountIncome').textContent = state.income.length;
    document.getElementById('profCountExpense').textContent = state.expenses.length;
    document.getElementById('profCountGoals').textContent = state.goals.length;
  },
  async saveProfile(){
    const name = document.getElementById('prof-name').value.trim() || state.user.name;
    const currencyVal = document.getElementById('prof-currency').value;
    const prev = {name:state.user.name, currency:state.user.currency};
    state.user.name = name;
    state.user.currency = currencyVal;
    try{
      if(!state.demoMode && sb){
        const {error} = await sb.from('profiles').update({name, currency:currencyVal}).eq('id', state.user.id);
        if(error) throw error;
      }
      this.refreshSidebar();
      toast('تم حفظ التغييرات بنجاح');
    } catch(err){
      state.user.name = prev.name; state.user.currency = prev.currency;
      dbErrorToast(err);
    }
  },

  /* ---------- ONBOARDING ---------- */
  selectOnbFreq(el){
    el.parentElement.querySelectorAll('.chip').forEach(c=>c.classList.remove('active'));
    el.classList.add('active');
  },
  async completeOnboarding(){
    const val = parseFloat(document.getElementById('onb-income').value.replace(/,/g,''));
    const errEl = document.getElementById('onb-err');
    if(!val || val<=0){ errEl.style.display='block'; return; }
    errEl.style.display='none';
    const freqChip = document.querySelector('#view-onboarding .chip.active');
    const draft = {name:'الدخل الأساسي', amount:val, recurrence:freqChip.dataset.val==='monthly'?'monthly':'irregular', months:null, day:1, createdMonthIdx:CUR_MONTH_IDX, revisions:[]};
    try{
      if(!state.demoMode && sb){
        const saved = await db.insert('income', draft);
        state.income.push(saved);
        const {error} = await sb.from('profiles').update({onboarded:true}).eq('id', state.user.id);
        if(error) throw error;
      } else {
        state.income.push({...draft, id:'local-'+Date.now()});
      }
      state.onboarded = true;
      toast('تم إعداد حسابك بنجاح 🎉');
      router.go('dashboard');
    } catch(err){ dbErrorToast(err); }
  }
};

/* =========================================================================
   FORM HANDLERS
========================================================================= */
document.getElementById('resetForm').addEventListener('submit', async function(e){
  e.preventDefault();
  if(!sb) return;
  const password=document.getElementById('new-pass').value;
  if(password.length<8 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)){
    toast('كلمة المرور تحتاج 8 خانات وحروف وأرقام',true); return;
  }
  const btn=this.querySelector('button[type=submit]'); btn.disabled=true;
  try { const {error}=await sb.auth.updateUser({password}); if(error) throw error;
    toast('تم تحديث كلمة المرور، سجّل دخولك من جديد');
    await sb.auth.signOut(); state.session=null;state.user=null; router.go('login');
  } catch(err){console.error(err);toast('رابط الاستعادة غير صالح أو انتهت صلاحيته',true);}
  finally{btn.disabled=false;}
});

document.getElementById('signupForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const name = document.getElementById('su-name').value.trim();
  const email = document.getElementById('su-email').value.trim();
  const pass = document.getElementById('su-pass').value;
  const currencyVal = document.getElementById('su-currency').value;
  let valid = true;
  document.getElementById('f-name').classList.toggle('has-error', !name); if(!name) valid=false;
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
  document.getElementById('f-email').classList.toggle('has-error', !emailOk); if(!emailOk) valid=false;
  const passOk = pass.length>=8 && /[a-zA-Z]/.test(pass) && /[0-9]/.test(pass);
  document.getElementById('f-pass').classList.toggle('has-error', !passOk); if(!passOk) valid=false;
  if(!valid) return;
  if(!sb){ toast('لم يتم ضبط الاتصال بقاعدة البيانات بعد (راجع config.js)', true); return; }
  const submitBtn = this.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try{
    // Supabase Auth hashes and stores the password server-side (bcrypt) and
    // returns a JWT session — no plaintext password is ever kept here.
    // name/currency travel as user metadata; a database trigger (see
    // schema.sql: handle_new_user) creates the `profiles` row from them
    // server-side, so it works even before the user has a session yet
    // (e.g. when "Confirm email" is enabled and signUp() returns no session).
    const {data, error} = await sb.auth.signUp({
      email, password: pass,
      options: { data: { name, currency: currencyVal } }
    });
    if(error) throw error;
    if(!data.user){ throw new Error('signup-failed'); }
    if(!data.session){
      // Project has "confirm email" turned on — no session yet, but the
      // profile row already exists (created by the trigger above).
      toast('تم إنشاء الحساب! تحقق من بريدك الإلكتروني لتأكيد الحساب ثم سجّل الدخول');
      router.go('login');
      return;
    }
    state.session = data.session;
    state.user = {id:data.user.id, name, email, currency:currencyVal};
    state.onboarded = false;
    state.income = []; state.expenses = []; state.goals = [];
    toast('تم إنشاء حسابك بنجاح');
    document.getElementById('onbCur').textContent = currencyVal;
    router.go('onboarding');
  } catch(err){
    console.error(err);
    const msg = /already registered|already exists/i.test(err.message||'') ? 'هذا البريد مسجّل مسبقاً — جرّب تسجيل الدخول' : 'تعذّر إنشاء الحساب، حاول مرة أخرى';
    toast(msg, true);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('su-pass').addEventListener('input', function(){
  const v = this.value;
  let score = 0;
  if(v.length>=8) score+=40;
  if(/[a-zA-Z]/.test(v)) score+=30;
  if(/[0-9]/.test(v)) score+=30;
  const bar = document.getElementById('pwBar');
  bar.style.width = score+'%';
  bar.style.background = score<50?'#E2604F':score<100?'#D9A441':'#3FA796';
});

document.getElementById('loginForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const email = document.getElementById('li-email').value.trim();
  const pass = document.getElementById('li-pass').value;
  document.getElementById('lf-email').classList.remove('has-error');
  document.getElementById('lf-pass').classList.remove('has-error');
  if(!sb){ toast('لم يتم ضبط الاتصال بقاعدة البيانات بعد (راجع config.js)', true); return; }
  const submitBtn = this.querySelector('button[type=submit]');
  submitBtn.disabled = true;
  try{
    const {data, error} = await sb.auth.signInWithPassword({ email, password: pass });
    if(error){
      // Supabase deliberately gives one generic error for both "no such
      // user" and "wrong password" so a login form can't be used to probe
      // which emails have accounts — we mirror that on the wrong-password field.
      document.getElementById('lf-pass').classList.add('has-error');
      throw error;
    }
    state.session = data.session;
    state.demoMode = false;
    await db.loadAll();
    if(!state.user){
      // Auth user exists but has no matching `profiles` row — most likely
      // it was created before the handle_new_user trigger existed, or
      // during a database outage that interrupted the trigger. We have an
      // authenticated session now, so RLS allows us to create it here as
      // a one-time repair instead of leaving the account stuck.
      const meta = (data.user && data.user.user_metadata) || {};
      const fallbackName = meta.name || email.split('@')[0];
      const fallbackCurrency = meta.currency || 'ر.س';
      try{
        const {error:repairError}=await sb.from('profiles').insert({ id: data.user.id, name: fallbackName, currency: fallbackCurrency, onboarded: false });
        if(repairError) throw repairError;
      } catch(err){ console.error('تعذّر إصلاح ملف التعريف الناقص:', err); }
      state.user = { id: data.user.id, name: fallbackName, email, currency: fallbackCurrency };
      state.onboarded = false;
    }
    toast('أهلاً بعودتك، ' + (state.user.name||'').split(' ')[0]);
    router.go(state.onboarded ? 'dashboard' : 'onboarding');
  } catch(err){
    console.error(err);
  } finally {
    submitBtn.disabled = false;
  }
});

document.getElementById('incomeForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const id = document.getElementById('income-id').value;
  const name = document.getElementById('income-name').value.trim();
  const amount = parseFloat(document.getElementById('income-amount').value.replace(/,/g,''));
  const recurrence = document.getElementById('income-recurrence').value;
  const months = parseInt(document.getElementById('income-months').value)||null;
  const day = parseInt(document.getElementById('income-day').value)||null;
  if(!name || !amount || amount<=0) { toast('فضلاً أكمل بيانات مصدر الدخل', true); return; }
  try{
    if(id){
      const item = state.income.find(i=>String(i.id)===String(id));
      const draft = structuredClone(item);
      applyEditWithHistory(draft, {name, amount, recurrence, months, day}, INCOME_REVISION_FIELDS, item.createdMonthIdx);
      if(!state.demoMode && sb) await db.update('income', item.id, draft);
      Object.assign(item, draft);
      toast('تم تحديث مصدر الدخل');
    } else {
      const draft = {name, amount, recurrence, months, day, createdMonthIdx:CUR_MONTH_IDX, revisions:[]};
      if(!state.demoMode && sb){
        const saved = await db.insert('income', draft);
        state.income.push(saved);
      } else {
        state.income.push({...draft, id:'local-'+Date.now()});
      }
      toast('تمت إضافة مصدر الدخل');
    }
    app.closeModal('modalIncome');
    app.renderIncome(); app.renderDashboard();
  } catch(err){ dbErrorToast(err); }
});
document.getElementById('income-recurrence').addEventListener('change', function(){
  document.getElementById('income-months-field').classList.toggle('hidden', this.value!=='limited');
});

document.getElementById('expenseForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const id = document.getElementById('expense-id').value;
  const name = document.getElementById('expense-name').value.trim();
  const amount = parseFloat(document.getElementById('expense-amount').value.replace(/,/g,''));
  const category = document.getElementById('expense-category').value;
  const type = document.getElementById('expense-type').value;
  const duration = parseInt(document.getElementById('expense-duration').value)||1;
  const startVal = document.getElementById('expense-start').value;
  if(!name || !amount || amount<=0 || !startVal) { toast('فضلاً أكمل بيانات المصروف', true); return; }
  const [sy,sm] = startVal.split('-').map(Number);
  const startMonthIdx = sy*12 + (sm-1);
  try{
    if(id){
      const item = state.expenses.find(x=>String(x.id)===String(id));
      // name/amount/category are protected by revision history; type/duration
      // /startMonthIdx are structural and always apply immediately.
      const draft = structuredClone(item);
      applyEditWithHistory(draft, {name, amount, category, type, duration, startMonthIdx}, EXPENSE_REVISION_FIELDS, item.startMonthIdx);
      if(!state.demoMode && sb) await db.update('expenses', item.id, draft);
      Object.assign(item, draft);
      toast('تم تحديث المصروف (القيم القديمة محفوظة في السجل التاريخي)');
    } else {
      const draft = {name, amount, category, type, duration, startMonthIdx, revisions:[]};
      if(!state.demoMode && sb){
        const saved = await db.insert('expenses', draft);
        state.expenses.push(saved);
      } else {
        state.expenses.push({...draft, id:'local-'+Date.now()});
      }
      toast('تمت إضافة المصروف');
    }
    app.closeModal('modalExpense');
    app.renderExpenses(); app.renderDashboard();
  } catch(err){ dbErrorToast(err); }
});

document.getElementById('goalForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const id = document.getElementById('goal-id').value;
  const name = document.getElementById('goal-name').value.trim();
  const target = parseFloat(document.getElementById('goal-target').value.replace(/,/g,''));
  const current = parseFloat(document.getElementById('goal-current').value.replace(/,/g,''))||0;
  const months = parseInt(document.getElementById('goal-months').value);
  const startMonthIdx = monthInputToIdx(document.getElementById('goal-start-month').value);
  if(!name || !target || target<=0 || !months || months<=0){ toast('فضلاً أكمل بيانات الهدف', true); return; }
  try{
    if(id){
      const item = state.goals.find(g=>String(g.id)===String(id));
      const draft = {...item, name, target, months, startMonthIdx};
      if(!state.demoMode && sb){await db.update('goals', item.id, draft);draft.installments=await db.loadGoalInstallments(item.id);}
      Object.assign(item, draft);
      toast('تم تحديث الهدف');
    } else {
      const draft = {name, target, current, months, startMonthIdx, deposits:[], installments:[]};
      let saved = draft;
      if(!state.demoMode && sb){
        saved = await db.insert('goals', draft);
        saved.installments = await db.loadGoalInstallments(saved.id);
      } else {
        saved = {...draft, id:'local-'+Date.now()};
      }
      state.goals.push(saved);
      const st = engine.goalStatus(saved);
      toast(st.ok ? 'هدف قابل للتحقيق ✓' : 'تنبيه: هذا الهدف يحتاج تعديل خطة', !st.ok);
    }
    app.closeModal('modalGoal');
    app.renderGoals(); app.renderDashboard();
  } catch(err){ dbErrorToast(err); }
});

document.getElementById('depositForm').addEventListener('submit', async function(e){
  e.preventDefault();
  const goalId = document.getElementById('deposit-goal-id').value;
  const amount = parseFloat(document.getElementById('deposit-amount').value.replace(/,/g,''));
  if(!amount || amount<=0) { toast('فضلاً أدخل مبلغاً صحيحاً', true); return; }
  const g = state.goals.find(x=>String(x.id)===String(goalId));
  if(!g) return;
  const submitButton = this.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try{
    if(state.demoMode){
      g.current = Math.round((g.current+amount)*100)/100;
    } else {
      if(!sb) throw new Error('Supabase is not configured');
      g.current = await db.addGoalDeposit(g.id, amount);
    }
    toast('تم تسجيل الإيداع، تقدمك الآن ' + Math.min(100,Math.round((g.current/g.target)*100)) + '%');
    app.closeModal('modalDeposit');
    app.renderGoals(); app.renderDashboard();
  } catch(err){
    dbErrorToast(err);
  } finally { submitButton.disabled = false; }
});

document.getElementById('goalInstallmentForm').addEventListener('submit',async function(e){
  e.preventDefault();const goalId=document.getElementById('installment-goal-id').value;const monthIdx=Number(document.getElementById('installment-month-idx').value);const amount=parseFloat(document.getElementById('installment-amount').value.replace(/,/g,''));
  if(!Number.isFinite(amount)||amount<=0){toast('أدخل مبلغاً صحيحاً',true);return;}
  const g=state.goals.find(x=>String(x.id)===String(goalId));if(!g)return;const btn=this.querySelector('button[type="submit"]');btn.disabled=true;
  try{
    if(state.demoMode){g.current=Math.round((g.current+amount)*100)/100;g.installments=g.installments||[];g.installments.push({month_idx:monthIdx,paid_amount:amount,paid_at:new Date().toISOString()});}
    else {if(!sb)throw new Error('Supabase is not configured');g.current=await db.payGoalInstallment(g.id,monthIdx,amount);const {data,error}=await sb.from('goal_installments').select('id,goal_id,month_idx,planned_amount,paid_amount,paid_at,deposit_id').eq('goal_id',g.id);if(error)throw error;g.installments=data||[];}
    toast('تم تسجيل ادخار الشهر وإضافته إلى رصيد الهدف');app.closeModal('modalGoalInstallment');app.renderGoals();app.renderDashboard();
  }catch(err){dbErrorToast(err);}finally{btn.disabled=false;}
});

document.getElementById('profileForm') && document.getElementById('profileForm').addEventListener('submit', function(e){ e.preventDefault(); });

/* =========================================================================
   GLOBAL EVENT DELEGATION
   One listener handles every data-action in the app (nav links, list-item
   edit/delete buttons, modal open/close, chips...) instead of inline
   onclick="..." attributes scattered through the markup and rebuilt with
   raw user data on every re-render.
========================================================================= */
document.addEventListener('click', function(e)
{
  const el = e.target.closest('[data-action]');
  if(!el) return;
  const id = el.dataset.id;
  switch(el.dataset.action)
  {
    case 'go': router.go(el.dataset.route); break;
    case 'demoLogin': app.demoLogin(); break;
    case 'forgotPassword': app.forgotPassword(); break;
    case 'logout': app.logout(); break;
    case 'selectOnbFreq': app.selectOnbFreq(el); break;
    case 'completeOnboarding': app.completeOnboarding(); break;
    case 'openIncomeModal': app.openIncomeModal(); break;
    case 'openExpenseModal': app.openExpenseModal(); break;
    case 'openGoalModal': app.openGoalModal(); break;
    case 'filterExpenses': app.filterExpenses(el); break;
    case 'saveProfile': app.saveProfile(); break;
    case 'closeModal': app.closeModal(el.dataset.modal); break;
    case 'selectChip': app.selectChip(el, el.dataset.target); break;
    case 'editIncome': app.editIncome(id); break;
    case 'deleteIncome': app.deleteIncome(id); break;
    case 'editExpense': app.editExpense(id); break;
    case 'deleteExpense': app.deleteExpense(id); break;
    case 'editGoal': app.editGoal(id); break;
    case 'deleteGoal': app.deleteGoal(id); break;
    case 'openDepositModal': app.openDepositModal(id); break;
    case 'payGoalMonth': app.openGoalInstallment(id,el.dataset.month); break;
    case 'unpayGoalMonth': app.unpayGoalMonth(id,el.dataset.month); break;
    case 'toggleGoalPlanEdit': app.toggleGoalPlanEdit(id); break;
  }
});


// clicking a modal's dark backdrop closes it too
document.querySelectorAll('.modal-overlay').forEach(ov=>
{
  ov.addEventListener('click', e=>{ if(e.target===ov) ov.classList.add('hidden'); });
}
);

/* =========================================================================
   INIT
========================================================================= */
async function boot(){
  // hero path visual (static preview on the landing page)
  renderGoalPath(document.getElementById('heroPath'), 62, 14);
  

  // Chart.js comes from a CDN and can fail to load (network issue, ad/
  // tracking blockers, offline testing...). That must NEVER stop the rest
  // of boot() — routing and session restore have to run either way, or the
  // whole app looks "stuck" on a blank page.
  try{
    const landingCtx = document.getElementById('landingChart');
    if(landingCtx && typeof Chart !== 'undefined'){
      Chart.defaults.font.family = "'IBM Plex Sans Arabic',sans-serif";
      Chart.defaults.color = '#8D93BC';
      safeChart(landingCtx.getContext('2d'), {
        type:'line',
        data:{labels:['يناير','فبراير','مارس','أبريل','مايو','يونيو'],
          datasets:[{data:[2100,3400,2900,4100,3800,4350], borderColor:'#D9A441', backgroundColor:'rgba(217,164,65,.12)', fill:true, tension:.4, pointRadius:0}]},
        options:{plugins:{legend:{display:false}}, scales:{x:{display:false}, y:{display:false}}, responsive:true, maintainAspectRatio:false}
      });
    } else if(landingCtx){
      console.error('تعذّر تحميل مكتبة Chart.js من الشبكة — الرسم البياني في الصفحة الرئيسية لن يظهر، لكن باقي التطبيق يعمل بشكل طبيعي.');
    }
  } catch(err){
    console.error('فشل رسم مخطط الصفحة الرئيسية:', err);
  }

  if(!sb){
    // Visible banner, not just a console.error — a missing/misconfigured
    // config.js should be obvious to whoever is testing the deployment,
    // not something only developers notice by opening devtools.
    const banner = document.createElement('div');
    banner.textContent = '⚠ لم يتم إعداد الاتصال بقاعدة البيانات بعد — أنشئ config.js من config.example.js وضع فيه رابط ومفتاح مشروع Supabase (راجع README.md).';
    banner.style.cssText = 'position:fixed;top:0;right:0;left:0;z-index:9999;background:#E2604F;color:#fff;padding:10px 16px;text-align:center;font-size:14px;font-family:inherit;';
    document.body.prepend(banner);
  } else {
    try{
      // Restore an existing session (JWT kept by supabase-js in localStorage
      // under its own key) so a page refresh doesn't log the user out.
      const {data:{session}} = await sb.auth.getSession();
      if(session){
        state.session = session;
        try { await db.loadAll(); } catch(err){ console.error(err); }
      }
      sb.auth.onAuthStateChange((event, session) => {
        if(event === 'SIGNED_OUT'){ state.session = null; }
        if(event === 'PASSWORD_RECOVERY') { router.go('reset'); }
      });
    } catch(err){
      console.error('فشل استعادة الجلسة:', err);
    }
  }

  router.render(router.parseHash());
}
window.addEventListener('DOMContentLoaded', boot);
