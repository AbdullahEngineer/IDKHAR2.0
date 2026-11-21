const fs = require('fs');
const assert = require('assert');
const vm = require('vm');
const html = fs.readFileSync(__dirname + '/../index.html','utf8');
const start = html.indexOf('const db = {');
const stop = html.indexOf('function dbErrorToast(',start);
assert(start>0 && stop>start, 'DB layer present');
const calls=[];
let sessionUser='11111111-1111-4111-8111-111111111111';
let goalDep=[{goal_id:7,amount:'50.25',month_idx:24322}];
let goal={id:7,user_id:sessionUser,name:'سيارة',target:'10000',initial_amount:'200',months:12,start_month_idx:24320};
let all={profiles:[{id:sessionUser,name:'اختبار',currency:'ر.س',onboarded:true}], income_sources:[], expenses:[],goals:[goal],goal_deposits:goalDep};
const sb={
  from(table){
    calls.push(table);
    const q={
      select(){return this;}, order(){return Promise.resolve({data:all[table],error:null});},
      maybeSingle(){return Promise.resolve({data:all[table]?.[0]||null,error:null});},
      single(){return Promise.resolve({data:table==='goals'?goal:all[table]?.[0],error:null});},
      insert(payload){this.payload=payload;return this;},
      update(payload){this.payload=payload;return this;},
      delete(){return this;}, eq(){return this;},
      then(resolve){return Promise.resolve({data:all[table]||[],error:null}).then(resolve);}
    };
    return q;
  },
  async rpc(fn,args){calls.push(fn);assert.strictEqual(fn,'fn_add_deposit');assert.strictEqual(args.p_goal_id,7);return {data:1,error:null};}
};
const state={session:{user:{id:sessionUser,email:'test@example.com'}},user:null,onboarded:false,income:[],expenses:[],goals:[]};
const context=vm.createContext({sb,state,console,Map,Number,Error});
vm.runInContext(html.slice(start,stop)+'\nthis.db=db;',context);
const db=context.db;
assert.strictEqual(db.tableName('income'),'income_sources');
assert.strictEqual(db.income.fromDb({id:1,name:'راتب',amount:'1000',recurrence:'monthly',due_day:25,created_month_idx:24320}).day,25);
assert.strictEqual(db.income.toDb({name:'راتب',amount:1000,recurrence:'monthly',months:null,day:25,createdMonthIdx:24320,revisions:[]}).due_day,25);
assert.strictEqual(db.goals.fromDb(goal,goalDep).current,250.25);
(async()=>{
  await db.loadAll();
  assert.strictEqual(state.goals[0].current,250.25);
  assert(calls.includes('income_sources') && calls.includes('goal_deposits'));
  let total=await db.addGoalDeposit(7,10);
  assert.strictEqual(total,250.25);
  console.log('PASS: schema table mapping, monthly day field, balance calculation, goal RPC naming, initial data load');
})().catch(e=>{console.error(e);process.exitCode=1});
