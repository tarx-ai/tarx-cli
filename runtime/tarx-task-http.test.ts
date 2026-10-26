import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createBoundedTaskController,TASK_NAME,PUBLIC_NOTE} from './tarx-bounded-task.ts'
import {createHash} from 'node:crypto'
const origin='https://www.tarx.com',subject='tvs_'+'a'.repeat(32),session='wrun_'+'B'.repeat(26)
async function setup(taskApproval:boolean,enabled=true){
 const dir=await mkdtemp(join(tmpdir(),'tarx-task-http-')),pairs=createFilePairStore(join(dir,'pairs.json')),owners=createFileOwnerStore(join(dir,'owners.json'))
 const ch=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'f'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:(async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))) as typeof fetch});assert.ok(ch.ok);if(!ch.ok)throw Error('fixture')
 await approvePairingChallenge(ch.challenge,pairs,Date.now(),taskApproval?TASK_NAME:undefined)
 let starts=0
 const executor={profile:TASK_NAME as typeof TASK_NAME,prepare:async()=>session,start:async()=>{starts++},async *events(){yield {type:'action.result',data:{status:'completed',result:{kind:'tool-result',toolName:TASK_NAME,output:{text:PUBLIC_NOTE,source:'fixture',privateContext:false}}}};yield {type:'turn.completed'}}}
 function server(){return createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore:pairs,ownerStore:owners,eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false}),tasks:enabled?createBoundedTaskController({file:join(dir,'tasks.json'),owners,executor}):undefined})}
 const listener=server(),{port}=await listener.listen(),base='http://127.0.0.1:'+port
 const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:ch.challenge})});assert.equal(claim.status,200)
 const token=(await claim.json()).pairing_credential
 return {listener,server,base,headers:{origin,'content-type':'application/json',authorization:'Bearer '+token},starts:()=>starts,revoke:()=>revokePairing(createHash('sha256').update(ch.challenge).digest('hex'),pairs)}
}
test('approved HTTP task result survives listener recreation and repeat submit does not run again',async()=>{
 const f=await setup(true);let current=f.listener
 try{
  const body=JSON.stringify({request_id:'task_http_0001',task:TASK_NAME})
  assert.equal((await fetch(f.base+'/tasks',{method:'POST',headers:f.headers,body})).status,202)
  const first=await(await fetch(f.base+'/tasks/task_http_0001',{headers:f.headers})).json();assert.equal(first.status,'completed');assert.equal(first.receipt.result,PUBLIC_NOTE)
  await current.close();current=f.server();const {port}=await current.listen(),base='http://127.0.0.1:'+port
  const after=await(await fetch(base+'/tasks/task_http_0001',{headers:f.headers})).json();assert.deepEqual(after,first)
  assert.equal((await fetch(base+'/tasks',{method:'POST',headers:f.headers,body})).status,200);assert.equal(f.starts(),1)
  await f.revoke();assert.equal((await fetch(base+'/tasks/task_http_0001',{headers:f.headers})).status,401)
 }finally{await current.close()}
})
test('read-only pairing cannot execute and unregistered executor stays unavailable',async()=>{
 for(const [approval,enabled,status] of [[false,true,403],[true,false,503]] as const){
  const f=await setup(approval,enabled)
  try{assert.equal((await fetch(f.base+'/tasks',{method:'POST',headers:f.headers,body:JSON.stringify({request_id:'task_http_0002',task:TASK_NAME})})).status,status);assert.equal(f.starts(),0)}finally{await f.listener.close()}
 }
})
test('foreign origin and browser identity fields cannot reach task execution',async()=>{
 const f=await setup(true)
 try{
  const body={request_id:'task_http_0003',task:TASK_NAME}
  assert.equal((await fetch(f.base+'/tasks',{method:'POST',headers:{...f.headers,origin:'https://evil.example'},body:JSON.stringify(body)})).status,403)
  assert.equal((await fetch(f.base+'/tasks',{method:'POST',headers:f.headers,body:JSON.stringify({...body,subject_id:subject})})).status,400)
  assert.equal(f.starts(),0)
 }finally{await f.listener.close()}
})
