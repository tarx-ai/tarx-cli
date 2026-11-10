import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createComputerTaskController,computerIntentHash,COMPUTER_TASK,type ComputerRequest,type ComputerSession,type ComputerOutcome} from './tarx-computer-task.ts'
const identity={subject_id:'tvs_'+'f'.repeat(32),install_id:'fixture_lost_owner',task_scopes:[COMPUTER_TASK]}
const request:ComputerRequest={task:COMPUTER_TASK,request_id:'lost_owner_request',session_id:'wrun_'+'F'.repeat(26),channel_id:'fixture-channel',agent_id:'fixture-agent',goal:'Synthetic owner-loss task'}
const core='a'.repeat(40)
const done:ComputerOutcome={outcome:'done',independent_verified:true,native_actions:1,model_calls:0,core_source:core,execution_mode:'deterministic_actuator'}

for(const phase of ['before observation','during observation'])test(`authority loss ${phase} cannot acknowledge an unknown execution owner stopped`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-recovery-authority-')),file=join(dir,'tasks.json')
 let executing=false,executionFinished=false,observing=false,observationFinished=false,observations=0,release!:()=>void,grantAvailable=phase==='during observation'
 const gate=new Promise<void>(resolve=>{release=resolve})
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const original=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{executing=true;await gate;executionFinished=true;return done}}})
 const replacement=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grantAvailable?grant:null},executor:{ready:async()=>true,run:async()=>{throw Error('must not replay')},observe:async({signal})=>{
  observations++;observing=true
  await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
  observationFinished=true;return done
 }}})
 try{
  await original.submit(identity,request,async()=>true)
  for(let i=0;i<100&&!executing;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(executing,true)
  const recovery=replacement.submit(identity,request,async()=>true)
  if(phase==='during observation'){
   for(let i=0;i<100&&!observing;i++)await new Promise(resolve=>setTimeout(resolve,5))
   assert.equal(observing,true);grantAvailable=false
  }
  const reply=await recovery
  assert.equal(reply.code,phase==='before observation'?403:200)
  assert.equal(reply.body.status,'uncertain','lost permission or observer cleanup cannot prove the original worker exited')
  assert.equal(reply.body.receipt,null);assert.equal(executionFinished,false)
  assert.equal(observations,phase==='before observation'?0:1)
  if(observations)assert.equal(observationFinished,true,'observer must still finish its own cleanup')
  const other={...request,request_id:'lost_owner_other_request'}
  const contender=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>({...grant,intent_sha256:computerIntentHash(other)})},executor:{ready:async()=>true,run:async()=>{throw Error('must not execute while original exit is unknown')}}})
  try{assert.equal((await contender.submit(identity,other,async()=>true)).body.error,'computer_task_in_progress')}
  finally{await contender.close()}
  release()
  let completed=await original.read(identity,request.request_id)
  for(let i=0;i<100&&completed.body.status!=='completed';i++){
   await new Promise(resolve=>setTimeout(resolve,5));completed=await original.read(identity,request.request_id)
  }
  assert.equal(executionFinished,true)
  assert.equal(completed.body.status,'completed','the real execution owner may publish its independently verified result')
  assert.equal(completed.body.receipt?.independent_verified,true)
 }finally{release();await original.close();await replacement.close();await rm(dir,{recursive:true,force:true})}
})

test('Stop while the final observation authority read is pending cannot publish late completion',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-recovery-authority-race-')),file=join(dir,'tasks.json')
 let executing=false,observed=false,checkingFinal=false,releaseRun!:()=>void,releaseAuthority!:()=>void
 const runGate=new Promise<void>(resolve=>{releaseRun=resolve}),authorityGate=new Promise<void>(resolve=>{releaseAuthority=resolve})
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const original=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{executing=true;await runGate;return done}}})
 const replacement=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>{
  if(observed){checkingFinal=true;await authorityGate}
  return grant
 }},executor:{ready:async()=>true,run:async()=>{throw Error('must not replay')},observe:async()=>{observed=true;return done}}})
 try{
  await original.submit(identity,request,async()=>true)
  for(let i=0;i<100&&!executing;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(executing,true)
  const recovery=replacement.submit(identity,request,async()=>true)
  for(let i=0;i<100&&!checkingFinal;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(checkingFinal,true)
  const closing=replacement.close()
  releaseAuthority()
  await closing
  const reply=await recovery
  assert.equal(reply.body.status,'uncertain')
  assert.equal(reply.body.receipt,null,'an observer result is not completion after Stop')
 }finally{releaseRun();releaseAuthority();await original.close();await replacement.close();await rm(dir,{recursive:true,force:true})}
})

for(const verdict of ['unverified','denied','error','cancelled','invalid'] as const)test(`observer-only ${verdict} cannot release an unknown execution owner's lease`,async()=>{
 const dir=await mkdtemp(join(tmpdir(),'tarx-recovery-observer-verdict-')),file=join(dir,'tasks.json')
 let executing=false,finished=false,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const grant:ComputerSession={session_id:request.session_id,subject_id:identity.subject_id,install_id:identity.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const observed:ComputerOutcome={...done,...(verdict==='invalid'?{core_source:'b'.repeat(40)}:{outcome:verdict})}
 const original=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{executing=true;await gate;finished=true;return done}}})
 const replacement=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{throw Error('must not replay')},observe:async()=>observed}})
 try{
  await original.submit(identity,request,async()=>true)
  for(let i=0;i<100&&!executing;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(executing,true)
  const reply=await replacement.submit(identity,request,async()=>true)
  assert.equal(reply.body.status,'uncertain');assert.equal(reply.body.receipt,null);assert.equal(finished,false)
  const other={...request,request_id:'observer_verdict_other'}
  const contender=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>({...grant,intent_sha256:computerIntentHash(other)})},executor:{ready:async()=>true,run:async()=>{throw Error('must not execute')}}})
  try{assert.equal((await contender.submit(identity,other,async()=>true)).body.error,'computer_task_in_progress')}
  finally{await contender.close()}
 }finally{release();await original.close();await replacement.close();await rm(dir,{recursive:true,force:true})}
})
