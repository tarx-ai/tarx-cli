import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createComputerTaskController,computerIntentHash,parseComputerRequest,COMPUTER_TASK,type ComputerRequest,type ComputerSession,type ComputerOutcome} from './tarx-computer-task.ts'
const identity={subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture_install',task_scopes:[COMPUTER_TASK]}
const request:ComputerRequest={request_id:'computer_request_01',task:COMPUTER_TASK,session_id:'wrun_'+'B'.repeat(26),channel_id:'channel-fixture',agent_id:'agent-fixture',goal:'Private synthetic goal',context:'Private synthetic channel context'}
const core='a'.repeat(40)
const completed:ComputerOutcome={outcome:'done',independent_verified:true,native_actions:1,model_calls:1,core_source:core,execution_mode:'local_model'}
async function fixture(t:any,run?:any) {
 const dir=await mkdtemp(join(tmpdir(),'tarx-computer-controller-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let calls=0,paired=true,grant:ComputerSession|null={session_id:request.session_id,channel_id:request.channel_id,agent_id:request.agent_id,subject_id:identity.subject_id,install_id:identity.install_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:4,timeout_ms:1000}
 const file=join(dir,'tasks.json')
 const controller=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async(input)=>{calls++;return run?run(input):completed}}})
 t.after(()=>controller.close())
 return {controller,file,paired:()=>Promise.resolve(paired),setPaired:(v:boolean)=>{paired=v},setGrant:(v:ComputerSession|null)=>{grant=v},grant:()=>grant!,calls:()=>calls}
}
async function final(controller:any){for(let i=0;i<100;i++){const r=await controller.read(identity,request.request_id);if(['completed','failed','cancelled','uncertain'].includes(r.body.status))return r;await new Promise(r=>setTimeout(r,10))}throw Error('fixture did not finish')}
test('verified state with unknown interrupted model accounting stays uncertain without a completion receipt or replay',async t=>{
 const f=await fixture(t,async()=>({...completed,model_calls:null}))
 await f.controller.submit(identity,request,f.paired)
 const outcome=await final(f.controller);assert.equal(outcome.body.status,'uncertain');assert.equal(outcome.body.receipt,null)
 await f.controller.submit(identity,request,f.paired);assert.equal(f.calls(),1)
})

test('channel/agent/native-session binding runs once and stores only independently verified metadata',async t=>{
 const f=await fixture(t)
 assert.equal((await f.controller.submit(identity,request,f.paired)).code,202)
 const result=await final(f.controller);assert.equal(result.body.status,'completed');assert.equal(result.body.receipt.independent_verified,true)
 assert.equal(result.body.receipt.channel_id,request.channel_id)
 const raw=await readFile(f.file,'utf8');assert.doesNotMatch(raw,/Private synthetic|authorization|tpc_/)
 assert.equal((await f.controller.submit(identity,request,f.paired)).code,200);assert.equal(f.calls(),1)
 assert.equal((await f.controller.submit(identity,{...request,goal:'Changed goal'},f.paired)).code,409)
})
test('pairing scope alone, foreign channel/agent/owner, expired native approval and caller-supplied grants cannot execute',async t=>{
 const f=await fixture(t)
 for(const change of [{channel_id:'other'},{agent_id:'other'},{session_id:'wrun_'+'C'.repeat(26)},{request_id:'another_request_02'}])assert.equal((await f.controller.submit(identity,{...request,...change},f.paired)).code,403)
 assert.equal((await f.controller.submit({...identity,subject_id:'tvs_'+'b'.repeat(32)},request,f.paired)).code,403)
 assert.equal((await f.controller.submit({...identity,task_scopes:[]},request,f.paired)).code,403)
 assert.equal((await f.controller.submit(identity,{...request,approved:true},f.paired)).code,400)
 f.setGrant({...f.grant(),expires_at:Date.now()-1});assert.equal((await f.controller.submit(identity,request,f.paired)).code,403)
 assert.equal(f.calls(),0)
})
test('model done, invalid provenance or missing independent verification never completes',async t=>{
 for(const outcome of [{...completed,independent_verified:false},{...completed,core_source:'b'.repeat(40)},{...completed,outcome:'unverified'}]){
  const f=await fixture(t,async()=>outcome);await f.controller.submit(identity,request,f.paired)
  const result=await final(f.controller);assert.equal(result.body.status,'failed');assert.equal(result.body.receipt,null)
 }
})
test('revocation stops the in-flight owner and preserves a cancelled result rather than late completion',async t=>{
 let stopped=false
 const f=await fixture(t,async({signal}:any)=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));stopped=true;return completed})
 await f.controller.submit(identity,request,f.paired)
 for(let i=0;i<30&&!f.calls();i++)await new Promise(r=>setTimeout(r,5))
 f.setPaired(false)
 const result=await final(f.controller);assert.equal(stopped,true);assert.equal(result.body.status,'cancelled');assert.equal(result.body.receipt,null)
})
test('cancel is acknowledged only after execution ends; uncertain/recreated tasks never replay',async t=>{
 let release:any
 const f=await fixture(t,()=>new Promise(r=>{release=r}))
 await f.controller.submit(identity,request,f.paired)
 for(let i=0;i<30&&!f.calls();i++)await new Promise(r=>setTimeout(r,5))
 assert.equal((await f.controller.cancel(identity,request.request_id)).body.status,'cancelling')
 release(completed)
 assert.equal((await final(f.controller)).body.status,'cancelled')
 assert.equal((await f.controller.submit(identity,request,f.paired)).code,200);assert.equal(f.calls(),1)
})
test('one computer lease excludes another channel and closing a non-cooperative executor is bounded',async t=>{
 const f=await fixture(t,()=>new Promise(()=>{}))
 await f.controller.submit(identity,request,f.paired)
 for(let i=0;i<30&&!f.calls();i++)await new Promise(r=>setTimeout(r,5))
 const other={...request,request_id:'computer_other_02',channel_id:'another-channel'}
 f.setGrant({...f.grant(),channel_id:other.channel_id,intent_sha256:computerIntentHash(other)})
 assert.equal((await f.controller.submit(identity,other,f.paired)).code,409)
 const start=Date.now();await f.controller.close();assert.ok(Date.now()-start<2200)
 assert.equal((await f.controller.read(identity,request.request_id)).body.status,'uncertain')
})

test('changing native consent bounds aborts an active run instead of inheriting a replacement grant',async t=>{
 const f=await fixture(t,async({signal}:any)=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));return completed})
 await f.controller.submit(identity,request,f.paired)
 for(let i=0;i<30&&!f.calls();i++)await new Promise(r=>setTimeout(r,5))
 f.setGrant({...f.grant(),max_steps:1})
 assert.equal((await final(f.controller)).body.status,'cancelled')
})

test('trusted native cleanup is awaited within its capped budget instead of returning before cleanup ends',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-computer-cleanup-budget-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+10000,max_steps:2,timeout_ms:5000}
 let running=false,cleaned=false
 const executor={shutdownGraceMs:2200,ready:async()=>true,run:async({signal}:any)=>{running=true;await new Promise(r=>signal.addEventListener('abort',r,{once:true}));await new Promise(r=>setTimeout(r,1650));cleaned=true;return completed}}
 const controller=createComputerTaskController({file:join(dir,'tasks.json'),coreSource:core,authority:{resolve:async()=>grant},executor});t.after(()=>controller.close())
 await controller.submit(identity,request,async()=>true)
 for(let i=0;i<30&&!running;i++)await new Promise(r=>setTimeout(r,5))
 const start=Date.now();await controller.close();assert.ok(Date.now()-start<2500);assert.equal(cleaned,true)
 assert.equal((await controller.read(identity,request.request_id)).body.status,'cancelled')
 assert.throws(()=>createComputerTaskController({file:join(dir,'other.json'),coreSource:core,authority:{resolve:async()=>grant},executor:{...executor,shutdownGraceMs:6001}}),/invalid_computer_shutdown_budget/)
})

test('channel-agent product ids parse and a second colon does not',()=>{
 const base={request_id:request.request_id,task:request.task,session_id:request.session_id,channel_id:request.channel_id,goal:request.goal}
 assert.equal(parseComputerRequest({...base,agent_id:'channel-agent:qa-pass'})?.agent_id,'channel-agent:qa-pass')
 assert.equal(parseComputerRequest({...base,agent_id:'agent-fixture'})?.agent_id,'agent-fixture')
 assert.equal(parseComputerRequest({...base,agent_id:'channel-agent:qa:pass'}),null)
 assert.equal(parseComputerRequest({...base,agent_id:'channel-agent:'}),null)
 assert.equal(parseComputerRequest({...base,agent_id:'other-agent:qa-pass'}),null)
 assert.equal(parseComputerRequest({...base,session_id:null})?.session_id,undefined)
 assert.equal(parseComputerRequest({...base,session_id:''}),null)
})
