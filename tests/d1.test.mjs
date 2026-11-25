import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import worker from "../worker/index.mjs";
import { presets } from "../dist/model.mjs";

function database() {
  const sqlite = new DatabaseSync(":memory:");
  function prepare(sql, params = []) {
    const statement = () => sqlite.prepare(sql);
    return {
      bind: (...args) => prepare(sql, args),
      run: async () => statement().run(...params),
      all: () => ({ results: statement().all(...params) }),
      first: async column => statement().get(...params)?.[column] ?? null
    };
  }
  return {
    DB: {
      prepare,
      batch(queries) {
        sqlite.exec("BEGIN");
        try {
          const result = queries.map(query => query.all());
          sqlite.exec("COMMIT");
          return result;
        } catch (error) { sqlite.exec("ROLLBACK"); throw error; }
      }
    }
  };
}

test("password-protected account: independent browsers share records and deletions", async () => {
  const env = {...database(),PASSWORD:"test-only-password"};
  const call = (token,path,method="GET",data) => worker.fetch(new Request("https://planner.test/api/"+path,{
    method,headers:token?{Authorization:"Bearer "+token}:{},body:data?JSON.stringify(data):undefined
  }),env);
  const login = async (password=env.PASSWORD,username="markarv") => call(null,"login","POST",{username,password});
  assert.equal((await call(null,"planner")).status,401);
  assert.equal((await login("wrong")).status,401);
  assert.equal((await login(env.PASSWORD,"other")).status,401);
  const a=(await (await login()).json()).token, b=(await (await login()).json()).token;
  assert.notEqual(a,b);
  assert.equal((await call(a,"session")).status,200);
  const version=n=>String(n).padStart(16,"0")+"-00000000-0000-4000-8000-000000000000";
  const book={key:"book:shopping",value:presets[0],version:version(1)};
  assert.equal((await call(a,"planner","PUT",book)).status,200);
  assert.deepEqual((await (await call(b,"planner")).json()).records,[book]);
  const note={key:"note:a",version:version(2),value:{id:"a",title:"Milk",kind:"list",text:"",items:[{label:"Milk",done:false}],date:"",bookId:"shopping",updated:2}};
  assert.equal((await call(b,"planner","PUT",note)).status,200);
  assert.equal((await (await call(a,"diagnostics")).json()).notes,1);
  assert.equal((await call(a,"planner","PUT",{...note,value:null,version:version(3),base:note.version})).status,200);
  assert.equal((await (await call(b,"planner")).json()).records.find(r=>r.key==="note:a").value,null);
  // A late migration cannot overwrite a tombstone.
  assert.equal((await (await call(b,"planner","PUT",{...note,version:version(4),importOnly:true})).json()).value,null);
  assert.equal((await call(randomBytes(32).toString("hex"),"planner")).status,401);
  env.PASSWORD="changed";
  assert.equal((await call(a,"session")).status,401);
});
test("authenticated migration preserves old namespace and existing account records",async()=>{
  const env={...database(),PASSWORD:"test-only-password"};
  const legacyToken=randomBytes(32).toString("hex");
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(legacyToken))),n=>n.toString(16).padStart(2,"0")).join("");
  const call=(token,path,method="GET",data)=>worker.fetch(new Request("https://planner.test/api/"+path,{
    method,headers:token?{Authorization:"Bearer "+token}:{},body:data?JSON.stringify(data):undefined
  }),env);
  const auth=(await (await call(null,"login","POST",{username:"markarv",password:env.PASSWORD})).json()).token;
  const version="0000000000000001-00000000-0000-4000-8000-000000000000";
  await env.DB.prepare("INSERT INTO planner_records (planner_id,record_key,version,data) VALUES (?,?,?,?)").bind(digest,"book:shopping",version,JSON.stringify(presets[0])).run();
  assert.equal((await call(null,"migrate","POST",{legacyToken})).status,401);
  assert.equal((await call(auth,"migrate","POST",{legacyToken})).status,200);
  assert.deepEqual((await (await call(auth,"planner")).json()).records,[{key:"book:shopping",version,value:presets[0]}]);
  assert.equal((await call(auth,"migrate","POST",{legacyToken})).status,200);
  assert.equal((await (await call(auth,"diagnostics")).json()).books,1);
});

test("food records sync independently without breaking old clients", async()=>{
  const env={...database(),PASSWORD:"test-only-password"};
  const call=(token,path,method="GET",data)=>worker.fetch(new Request("https://planner.test/api/"+path,{
    method,headers:token?{Authorization:"Bearer "+token}:{},body:data?JSON.stringify(data):undefined
  }),env);
  const login=async()=>(await (await call(null,"login","POST",{username:"markarv",password:env.PASSWORD})).json()).token;
  const a=await login(),b=await login();
  const version=n=>String(n).padStart(16,"0")+"-00000000-0000-4000-8000-000000000000";
  const meal={key:"food:meal-a",version:version(1),value:{id:"meal-a",name:"Toast",date:"2026-11-25",calories:null,created:1,updated:1}};
  assert.equal((await call(a,"planner","PUT",meal)).status,200);
  assert.deepEqual((await (await call(b,"planner?types=all")).json()).records,[meal]);
  assert.deepEqual((await (await call(b,"planner")).json()).records,[]);
  assert.equal((await call(a,"planner","PUT",{...meal,value:{...meal.value,date:"2026-02-30"}})).status,400);
  assert.equal((await call(b,"planner","PUT",{...meal,version:version(2),value:null,base:meal.version})).status,200);
  assert.equal((await (await call(a,"planner?types=all")).json()).records[0].value,null);
});
