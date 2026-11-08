/** Fixture authority only. Stored statuses stay on the existing ledger schema:
 * queued=reserved, leased=one non-terminal task per install, running=running,
 * verifying=independent observation before a receipt, succeeded=completed.
 * This does not mint a session, start a planner, or claim native execution. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createComputerTaskController,computerIntentHash,COMPUTER_TASK,type ComputerExecutor,type ComputerOutcome,type ComputerRequest,type ComputerSession} from './tarx-computer-task.ts'
const identity={subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture_install',task_scopes:[COMPUTER_TASK]}
const request:ComputerRequest={request_id:'computer_request_01',task:COMPUTER_TASK,session_id:'wrun_'+'B'.repeat(26),channel_id:'channel-fixture',agent_id:'channel-agent:qa-pass',goal:'Private synthetic goal',context:'Private synthetic channel context'}
const core='a'.repeat(40)
const verified:ComputerOutcome={outcome:'done',independent_verified:true,native_actions:1,model_calls:0,core_source:core,execution_mode:'deterministic_actuator'}
async function fixture(t:any,executor:Pick<ComputerExecutor,'run'|'observe'>) {
 const dir=await mkdtemp(join(tmpdir(),'tarx-computer-contract-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 let paired=true,grant:ComputerSession|null={session_id:request.session_id,channel_id:request.channel_id,agent_id:request.agent_id,subject_id:identity.subject_id,install_id:identity.install_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:4,timeout_ms:4000}
 const file=join(dir,'tasks.json')
 const controller=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,...executor}})
 t.after(()=>controller.close())
 return {controller,file,paired:()=>Promise.resolve(paired),setPaired:(v:boolean)=>{paired=v},setGrant:(v:ComputerSession|null)=>{grant=v},grant:()=>grant!}
}
async function until(controller:any,states:string[]) {
 for(let i=0;i<100;i++){const r=await controller.read(identity,request.request_id);if(states.includes(r.body.status))return r;await new Promise(r=>setTimeout(r,10))}
 throw Error('fixture did not finish')
}

test('queued reservation, install lease, running, and verified success use the stored statuses',async t=>{
 let release:any,actions=0
 const f=await fixture(t,{run:async()=>{actions++;return new Promise(r=>{release=r})}})
 const queued=await f.controller.submit(identity,request,f.paired)
 assert.equal(queued.code,202);assert.equal(queued.body.status,'reserved');assert.equal(queued.body.receipt,null)
 for(let i=0;i<50&&!actions;i++)await new Promise(r=>setTimeout(r,10))
 assert.equal((await f.controller.read(identity,request.request_id)).body.status,'running')
 const saved=f.grant(),other={...request,request_id:'computer_other_02',channel_id:'another-channel'}
 f.setGrant({...saved,channel_id:other.channel_id,intent_sha256:computerIntentHash(other)})
 const leased=await f.controller.submit(identity,other,f.paired)
 f.setGrant(saved)
 assert.equal(leased.code,409)
 assert.equal((await f.controller.read(identity,request.request_id)).body.receipt,null)
 release(verified)
 const done=await until(f.controller,['completed','failed','cancelled','uncertain'])
 assert.equal(done.body.status,'completed');assert.equal(done.body.receipt.independent_verified,true);assert.equal(done.body.receipt.native_actions,1)
 assert.equal(actions,1);assert.equal((await f.controller.submit(identity,request,f.paired)).code,200);assert.equal(actions,1)
 assert.doesNotMatch(await readFile(f.file,'utf8'),/Private synthetic/)
})

test('verifying rejects an unverified outcome, and owner loss blocks a late success',async t=>{
 const failed=await fixture(t,{run:async()=>({...verified,outcome:'unverified',independent_verified:false})})
 await failed.controller.submit(identity,request,failed.paired)
 assert.equal((await until(failed.controller,['failed','completed'])).body.status,'failed')
 assert.equal((await failed.controller.read(identity,request.request_id)).body.receipt,null)
 let release:any
 const lost=await fixture(t,{run:async({signal}:any)=>{await new Promise(r=>signal.addEventListener('abort',r,{once:true}));release=true;return verified}})
 await lost.controller.submit(identity,request,lost.paired)
 for(let i=0;i<30;i++){const seen=await lost.controller.read(identity,request.request_id);if(seen.body.status==='running'||seen.body.status==='reserved')break;await new Promise(r=>setTimeout(r,5))}
 lost.setPaired(false)
 const result=await until(lost.controller,['cancelled','completed','failed','uncertain'])
 assert.equal(release,true);assert.equal(result.body.status,'cancelled');assert.equal(result.body.receipt,null)
 assert.equal((await lost.controller.submit(identity,request,lost.paired)).code,403)
})

test('a crash after delivery reconciles from observation and does not replay the action',async t=>{
 let actions=0,observations=0
 const f=await fixture(t,{
  run:async()=>{actions++;throw Error('crashed_before_receipt')},
  observe:async()=>{observations++;return verified},
 })
 await f.controller.submit(identity,request,f.paired)
 assert.equal((await until(f.controller,['uncertain','completed','failed'])).body.status,'uncertain')
 const again=await f.controller.submit(identity,request,f.paired)
 assert.equal(again.body.status,'completed');assert.equal(again.body.receipt?.independent_verified,true)
 assert.equal(actions,1);assert.equal(observations,1)
 const negative=await fixture(t,{
  run:async()=>{actions++;throw Error('crashed_before_receipt')},
  observe:async()=>{observations++;return {...verified,outcome:'unverified',independent_verified:false}},
 })
 await negative.controller.submit(identity,request,negative.paired)
 assert.equal((await until(negative.controller,['uncertain'])).body.status,'uncertain')
 const denied=await negative.controller.submit(identity,request,negative.paired)
 assert.equal(denied.body.status,'failed');assert.equal(denied.body.receipt,null)
 assert.equal(actions,2);assert.equal(observations,2)
})

test('owner loss and a missing observation hook cannot post success or replay a delivered action',async t=>{
 let actions=0,observations=0
 const lost=await fixture(t,{
  run:async()=>{actions++;throw Error('crashed_before_receipt')},
  observe:async()=>{observations++;return verified},
 })
 await lost.controller.submit(identity,request,lost.paired)
 assert.equal((await until(lost.controller,['uncertain'])).body.status,'uncertain')
 lost.setGrant(null)
 const denied=await lost.controller.submit(identity,request,lost.paired)
 assert.equal(denied.code,403);assert.equal(denied.body.status,'cancelled');assert.equal(denied.body.receipt,null)
 assert.equal(observations,0);assert.equal(actions,1)
 const stuck=await fixture(t,{run:async()=>{actions++;throw Error('crashed_before_receipt')}})
 await stuck.controller.submit(identity,request,stuck.paired)
 assert.equal((await until(stuck.controller,['uncertain'])).body.status,'uncertain')
 const replay=await stuck.controller.submit(identity,request,stuck.paired)
 assert.equal(replay.body.status,'uncertain');assert.equal(replay.body.receipt,null);assert.equal(actions,2)
})
