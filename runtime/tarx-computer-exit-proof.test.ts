import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,readFile,writeFile,rm,rename,mkdir,rmdir} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createComputerTaskController,computerIntentHash,COMPUTER_TASK,type ComputerRequest,type ComputerSession,type ComputerOutcome} from './tarx-computer-task.ts'
const id={subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture_proof_install',task_scopes:[COMPUTER_TASK]}
const request:ComputerRequest={task:COMPUTER_TASK,request_id:'proof_request_01',session_id:'wrun_'+'G'.repeat(26),channel_id:'proof-channel',agent_id:'proof-agent',goal:'Synthetic proof goal'}
const core='c'.repeat(40),done:ComputerOutcome={outcome:'done',independent_verified:true,native_actions:1,model_calls:1,core_source:core,execution_mode:'local_model'}
async function fixture(){
 const dir=await mkdtemp(join(tmpdir(),'tarx-exit-proof-')),file=join(dir,'tasks.json')
 const grant:ComputerSession={session_id:request.session_id,subject_id:id.subject_id,install_id:id.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+60000,max_steps:2,timeout_ms:45000}
 const controllers:ReturnType<typeof createComputerTaskController>[]=[];let observations=0
 const controller=(run=async()=>done)=>{const c=createComputerTaskController({file,coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run,observe:async()=>{observations++;return done}}});controllers.push(c);return c}
 return {file,dir,controller,observations:()=>observations,async cleanup(){for(const c of controllers)await c.close();await rm(dir,{recursive:true,force:true})}}
}
async function terminal(c:any){for(let i=0;i<100;i++){const r=await c.read(id,request.request_id);if(['completed','failed','cancelled','uncertain'].includes(r.body.status))return r;await new Promise(resolve=>setTimeout(resolve,5))}throw Error('fixture did not settle')}
async function saved(file:string){const all=JSON.parse(await readFile(file,'utf8'));return {all,key:Object.keys(all)[0],row:Object.values(all)[0] as any}}

test('only a fulfilled execution writes private bound exit proof; proof-backed recovery can complete',async()=>{
 const f=await fixture(),a=f.controller()
 try{
  await a.submit(id,request,async()=>true);assert.equal((await terminal(a)).body.status,'completed')
  const {all,key,row}=await saved(f.file)
  assert.equal(row.execution_exit.kind,'computer_execution_exit');assert.equal(row.execution_exit.intent_sha256,row.intent_sha256)
  assert.equal(row.execution_exit.core_source,core);assert.equal(row.execution_exit.subject_id,id.subject_id)
  assert.equal('execution_exit' in (await a.read(id,request.request_id)).body,false)
  all[key]={...row,status:'uncertain'};delete all[key].receipt
  await writeFile(f.file,JSON.stringify(all))
  const b=f.controller();const recovered=await b.submit(id,request,async()=>true)
  assert.equal(recovered.body.status,'completed');assert.equal(recovered.body.receipt?.independent_verified,true)
 }finally{await f.cleanup()}
})

test('legacy nonterminal rows without proof stay held, while legacy terminal receipts stay readable',async()=>{
 const f=await fixture(),a=f.controller()
 try{
  await a.submit(id,request,async()=>true);await terminal(a)
  const {all,key,row}=await saved(f.file);delete row.execution_exit
  all[key]=row;await writeFile(f.file,JSON.stringify(all))
  assert.equal((await a.read(id,request.request_id)).body.status,'completed')
  all[key]={...row,status:'running'};delete all[key].receipt;await writeFile(f.file,JSON.stringify(all))
  const b=f.controller();assert.equal((await b.submit(id,request,async()=>true)).body.status,'uncertain')
  assert.equal((await saved(f.file)).row.execution_exit,undefined,'an observer never creates execution-exit evidence')
 }finally{await f.cleanup()}
})

for(const defect of ['core','intent','owner','extra'])test(`foreign/malformed ${defect} proof fails closed`,async()=>{
 const f=await fixture(),a=f.controller()
 try{
  await a.submit(id,request,async()=>true);await terminal(a)
  const {all,key,row}=await saved(f.file);row.status='uncertain';delete row.receipt
  if(defect==='core')row.execution_exit.core_source='d'.repeat(40)
  if(defect==='intent')row.execution_exit.intent_sha256='e'.repeat(64)
  if(defect==='owner')row.execution_exit.subject_id='tvs_'+'b'.repeat(32)
  if(defect==='extra')row.execution_exit.unbound=true
  all[key]=row;await writeFile(f.file,JSON.stringify(all))
  await assert.rejects(a.read(id,request.request_id),/invalid_computer_record/)
  await assert.rejects(f.controller().submit(id,request,async()=>true),/invalid_computer_record/)
  assert.equal(f.observations(),0,'invalid stored proof must fail before any observer is started')
  assert.equal((await saved(f.file)).row.receipt,undefined)
 }finally{await f.cleanup()}
})

test('Stop after a proof/receipt-publication gap can settle without a running owner or observation',async()=>{
 const f=await fixture(),a=f.controller()
 try{
  await a.submit(id,request,async()=>true);await terminal(a)
  const {all,key,row}=await saved(f.file);all[key]={...row,status:'uncertain'};delete all[key].receipt
  await writeFile(f.file,JSON.stringify(all))
  const b=f.controller();const stopped=await b.cancel(id,request.request_id)
  assert.equal(stopped.code,200);assert.equal(stopped.body.status,'cancelled');assert.equal(stopped.body.receipt,null)
 }finally{await f.cleanup()}
})

test('proof-publication failure cannot be replaced with observer success',async()=>{
 const f=await fixture();let entered=false,release!:()=>void
 const gate=new Promise<void>(resolve=>{release=resolve})
 const a=f.controller(async()=>{entered=true;await gate;return done})
 let displaced=false
 try{
  await a.submit(id,request,async()=>true)
  for(let i=0;i<100&&!entered;i++)await new Promise(resolve=>setTimeout(resolve,5))
  assert.equal(entered,true)
  await rename(f.file,f.file+'.saved');displaced=true;await mkdir(f.file)
  release();await a.close()
  await rmdir(f.file);await rename(f.file+'.saved',f.file);displaced=false
  assert.equal((await saved(f.file)).row.execution_exit,undefined)
  const reply=await f.controller().submit(id,request,async()=>true)
  assert.equal(reply.body.status,'uncertain');assert.equal(reply.body.receipt,null)
 }finally{
  release()
  if(displaced){await rmdir(f.file).catch(()=>{});await rename(f.file+'.saved',f.file).catch(()=>{})}
  await f.cleanup()
 }
})
