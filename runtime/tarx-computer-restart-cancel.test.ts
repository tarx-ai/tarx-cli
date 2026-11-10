import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp, readFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {createComputerTaskController, computerIntentHash, COMPUTER_TASK, type ComputerRequest, type ComputerSession, type ComputerOutcome} from './tarx-computer-task.ts'

const identity={subject_id:'tvs_'+'e'.repeat(32),install_id:'fixture_restart_install',task_scopes:[COMPUTER_TASK]}
const request:ComputerRequest={task:COMPUTER_TASK,request_id:'restart_cancel_request',session_id:'wrun_'+'E'.repeat(26),channel_id:'fixture-channel',agent_id:'fixture-agent',goal:'Synthetic restart task'}
const core='a'.repeat(40)
const outcome:ComputerOutcome={outcome:'cancelled',independent_verified:false,native_actions:0,model_calls:0,core_source:core,execution_mode:'deterministic_actuator'}

for(const grantAvailable of [true,false])test(`a recreated controller cannot acknowledge orphaned Stop or release its lease (grant ${grantAvailable?'present':'absent'})`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-restart-cancel-')),file=join(dir,'tasks.json')
 let entered=false,finished=false,replayed=0,observed=0,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const original=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{entered=true;await gate;finished=true;return outcome}}})
 const replacement=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grantAvailable?grant:null},executor:{ready:async()=>true,run:async()=>{replayed++;return outcome},observe:async()=>{observed++;return outcome}}})
 try{
  assert.equal((await original.submit(identity,request,async()=>true)).code,202)
  for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(entered,true)
  assert.equal((await original.cancel(identity,request.request_id)).body.status,'cancelling')
  assert.equal(finished,false)
  for(let i=0;i<2;i++){
   const reply=await replacement.submit(identity,request,async()=>true)
   assert.equal(reply.code,409,'lost in-memory owner is not native-exit proof')
   assert.equal(reply.body.error,'computer_outcome_uncertain')
   assert.equal(reply.body.status,'cancelling','durable Stop intent must survive repeated recovery attempts')
   assert.equal(reply.body.receipt,null)
  }
  const other={...request,request_id:'restart_other_request'}
  const otherController=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>({...grant,intent_sha256:computerIntentHash(other)})},executor:{ready:async()=>true,run:async()=>{replayed++;return outcome}}})
  try{
   assert.equal((await otherController.submit(identity,other,async()=>true)).body.error,'computer_task_in_progress')
   assert.equal(replayed,0);assert.equal(observed,0);assert.equal(finished,false)
   const records=Object.values(JSON.parse(await readFile(file,'utf8'))) as {status:string;receipt?:unknown}[]
   assert.equal(records.length,1);assert.equal(records[0].status,'cancelling');assert.equal(records[0].receipt,undefined)
   release();await original.close()
   assert.equal(finished,true)
   assert.equal((await replacement.read(identity,request.request_id)).body.status,'cancelled')
   assert.equal((await otherController.submit(identity,other,async()=>true)).code,202,'confirmed owned cleanup releases the lease')
  }finally{await otherController.close()}
 }finally{
  release();await original.close();await replacement.close();await rm(dir,{recursive:true,force:true})
 }
})

test('late confirmed owned cleanup resolves Stop after grace expiry without a completion receipt',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-restart-cancel-timeout-')),file=join(dir,'tasks.json')
 let entered=false,finished=false,observations=0,release!:()=>void,finishedRun!:()=>void
 const runFinished=new Promise<void>(resolve=>{finishedRun=resolve})
 const gate=new Promise<void>(resolve=>{release=resolve})
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const original=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{shutdownGraceMs:20,ready:async()=>true,run:async()=>{entered=true;await gate;finished=true;finishedRun();return {...outcome,outcome:'done',independent_verified:true}}}})
 const replacement=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{throw Error('must not replay')},observe:async()=>{observations++;return {...outcome,outcome:'done',independent_verified:true}}}})
 try{
  await original.submit(identity,request,async()=>true)
  for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(entered,true)
  await original.cancel(identity,request.request_id)
  await original.close()
  assert.equal(finished,false,'owned cleanup exceeded its grace budget')
  assert.equal((await replacement.read(identity,request.request_id)).body.status,'cancelling')
  assert.equal((await replacement.submit(identity,request,async()=>true)).code,409)
  assert.equal(observations,0,'Stop cannot become a successful read-only recovery')
  release();await runFinished
  assert.equal(finished,true)
  let stopped=await replacement.read(identity,request.request_id)
  for(let i=0;i<100&&stopped.body.status!=='cancelled';i++){
   await new Promise(resolve=>setTimeout(resolve,5));stopped=await replacement.read(identity,request.request_id)
  }
  assert.equal((await replacement.read(identity,request.request_id)).body.receipt,null)
  assert.equal(stopped.body.status,'cancelled','only the real execution exit may release the held Stop')
 }finally{release();await original.close();await replacement.close();await rm(dir,{recursive:true,force:true})}
})
