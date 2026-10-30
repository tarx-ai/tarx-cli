import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createBoundedTaskController,PUBLIC_NOTE,TASK_NAME,TASK_MESSAGE} from './tarx-bounded-task.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
const identity={subject_id:'tvs_'+'a'.repeat(32),install_id:'install_fixture',task_scopes:[TASK_NAME]}
const session='wrun_'+'A'.repeat(26)
const completed:any[]=[{type:'action.result',data:{status:'completed',result:{kind:'tool-result',toolName:TASK_NAME,output:{text:PUBLIC_NOTE,source:'fixture',privateContext:false}}}},{type:'turn.completed'}]
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'tarx-bounded-')),file=join(dir,'tasks.json'),owners=createFileOwnerStore(join(dir,'owners.json'))
 let starts=0,prepares=0,events:any[]=completed,failStart=false
 const executor={profile:TASK_NAME as typeof TASK_NAME,prepare:async()=>{prepares++;return session},start:async(_id:string,message:string)=>{starts++;assert.equal(message,TASK_MESSAGE);if(failStart)throw Error('private error')},async *events(){yield*events}}
 const factory=()=>createBoundedTaskController({file,owners,executor})
 return {dir,file,owners,factory,counts:()=>({starts,prepares}),setEvents:(v:any[])=>{events=v},failStart:()=>{failStart=true}}
}
test('concurrent retry creates and dispatches once, result survives controller recreation',async()=>{
 const f=await fixture(),controller=f.factory(),request={request_id:'request_0001',task:TASK_NAME}
 const results=await Promise.all(Array.from({length:4},()=>controller.submit(identity,request)))
 assert.ok(results.every(r=>r.code===200||r.code===202));assert.deepEqual(f.counts(),{starts:1,prepares:1})
 const result=await f.factory().read(identity,request.request_id);assert.equal(result.code,200);assert.equal(result.body.status,'completed');assert.equal(result.body.receipt?.result,PUBLIC_NOTE)
 assert.equal((await f.owners.get(session))?.subject_id,identity.subject_id)
 assert.equal((await stat(f.file)).mode&0o777,0o600)
 assert.equal((await f.factory().submit(identity,request)).body.status,'completed');assert.equal(f.counts().starts,1)
})
test('read pairing does not grant task execution; unsupported body and task rejected',async()=>{
 const f=await fixture(),c=f.factory(),body={request_id:'request_0002',task:TASK_NAME}
 assert.equal((await c.submit({...identity,task_scopes:[]},body)).code,403)
 assert.equal((await c.submit(identity,{...body,subject_id:'spoof'})).code,400)
 assert.equal((await c.submit(identity,{...body,task:'shell'})).code,400)
 assert.equal(f.counts().starts,0)
})
test('same request id is private to account/install and unknown reads do not execute',async()=>{
 const f=await fixture();await f.factory().submit(identity,{request_id:'request_0003',task:TASK_NAME})
 assert.equal((await f.factory().read({...identity,subject_id:'tvs_'+'b'.repeat(32)},'request_0003')).code,404)
 assert.equal((await f.factory().read({...identity,install_id:'other'},'request_0003')).code,404)
 assert.equal(f.counts().starts,1)
})
test('uncertain dispatch is retained and retry never executes again',async()=>{
 const f=await fixture();f.failStart();const body={request_id:'request_0004',task:TASK_NAME}
 const first=await f.factory().submit(identity,body);assert.equal(first.code,502);assert.equal(first.body.status,'uncertain');assert.doesNotMatch(JSON.stringify(first),/private error/)
 assert.equal((await f.factory().submit(identity,body)).body.status,'uncertain');assert.equal(f.counts().starts,1)
})
test('completion without exact successful tool result fails instead of inventing success',async()=>{
 for(const events of [[{type:'turn.completed'}],[{...completed[0],data:{status:'failed'}},completed[1]],[{...completed[0],data:{...completed[0].data,result:{...completed[0].data.result,toolName:'other'}}},completed[1]]]){
  const f=await fixture();f.setEvents(events);await f.factory().submit(identity,{request_id:'request_0005',task:TASK_NAME})
  const r=await f.factory().read(identity,'request_0005');assert.equal(r.body.status,'failed');assert.equal(r.body.receipt,null)
 }
})
test('one in-flight task per account/install and corrupt ledger fails closed',async()=>{
 const f=await fixture();f.setEvents([]);await f.factory().submit(identity,{request_id:'request_0006',task:TASK_NAME})
 assert.equal((await f.factory().submit(identity,{request_id:'request_0007',task:TASK_NAME})).code,409)
 await writeFile(f.file,'corrupt');await assert.rejects(()=>f.factory().submit(identity,{request_id:'request_0008',task:TASK_NAME}))
 assert.equal(f.counts().starts,1)
})
test('SDK executor requires trusted profile evidence before create and every send',async()=>{
 const {createEveReadNoteExecutor}=await import('./tarx-bounded-task.ts')
 let verified=false,creates=0,sends=0
 const executor=createEveReadNoteExecutor({sessions:{create:async()=>{creates++;return {session:{state:{sessionId:session}}}},attach:()=>({send:async()=>{sends++;return {result:async()=>null}},async *stream(){yield*completed}})}},async()=>verified)
 await assert.rejects(()=>executor.prepare(),/trusted_profile_required/);assert.equal(creates,0)
 verified=true;assert.equal(await executor.prepare(),session);verified=false
 await assert.rejects(()=>executor.start(session,TASK_MESSAGE),/trusted_profile_required/);assert.equal(sends,0)
 verified=true;await executor.start(session,TASK_MESSAGE);assert.equal(sends,1)
 const events=[];for await(const event of executor.events(session))events.push(event);assert.equal(events.length,2)
})


test('failed preparation is terminal and releases the owner for a new explicit request',async()=>{
 const f=await fixture();let attempts=0,starts=0
 const executor={profile:TASK_NAME as typeof TASK_NAME,prepare:async()=>{if(++attempts===1)throw Error('private preparation error');return session},start:async()=>{starts++},async *events(){}}
 const c=createBoundedTaskController({file:f.file,owners:f.owners,executor})
 const first={request_id:'prepare_fail_01',task:TASK_NAME}
 const failed=await c.submit(identity,first)
 assert.equal(failed.code,503);assert.equal(failed.body.status,'failed');assert.equal(failed.body.error,'task_preparation_failed')
 assert.doesNotMatch(JSON.stringify(failed),/private preparation error/)
 assert.equal((await c.submit(identity,first)).body.status,'failed');assert.equal(attempts,1)
 assert.equal((await c.submit(identity,{...first,request_id:'prepare_next_01'})).code,202)
 assert.equal(starts,1)
})

test('late preparation cannot dispatch after its acknowledgement deadline',{timeout:2000},async()=>{
 const f=await fixture();let release!:(id:string)=>void,starts=0,attempts=0
 const waiting=new Promise<string>(resolve=>{release=resolve})
 const executor={profile:TASK_NAME as typeof TASK_NAME,prepare:()=>++attempts===1?waiting:Promise.resolve(session),start:async()=>{starts++},async *events(){}}
 const c=createBoundedTaskController({file:f.file,owners:f.owners,executor,dispatchTimeoutMs:15})
 const first={request_id:'prepare_late_01',task:TASK_NAME}
 const timedOut=await c.submit(identity,first)
 assert.equal(timedOut.code,503);assert.equal(timedOut.body.status,'failed');assert.equal(starts,0)
 release(session);await new Promise(resolve=>setImmediate(resolve))
 assert.equal((await c.read(identity,first.request_id)).body.status,'failed');assert.equal(starts,0)
 assert.equal((await c.submit(identity,{...first,request_id:'prepare_late_02'})).code,202);assert.equal(starts,1)
})

test('start acknowledgement timeout stays uncertain and prevents replay or overlapping work',{timeout:2000},async()=>{
 const f=await fixture();let release!:()=>void,starts=0
 const waiting=new Promise<void>(resolve=>{release=resolve})
 const executor={profile:TASK_NAME as typeof TASK_NAME,prepare:async()=>session,start:()=>{starts++;return waiting},async *events(){}}
 const c=createBoundedTaskController({file:f.file,owners:f.owners,executor,dispatchTimeoutMs:15})
 const first={request_id:'dispatch_late_01',task:TASK_NAME}
 const timedOut=await c.submit(identity,first)
 assert.equal(timedOut.code,502);assert.equal(timedOut.body.status,'uncertain')
 assert.equal((await c.submit(identity,first)).body.status,'uncertain')
 assert.equal((await c.submit(identity,{...first,request_id:'dispatch_late_02'})).code,409)
 release();await new Promise(resolve=>setImmediate(resolve))
 assert.equal((await c.read(identity,first.request_id)).body.status,'uncertain');assert.equal(starts,1)
})
