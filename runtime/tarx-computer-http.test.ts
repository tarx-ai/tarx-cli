import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createComputerTaskController,computerIntentHash,COMPUTER_TASK,type ComputerRequest,type ComputerSession} from './tarx-computer-task.ts'
const origin='https://www.tarx.com',subject='tvs_'+'a'.repeat(32),core='b'.repeat(40)
const request:ComputerRequest={request_id:'http_computer_0001',task:COMPUTER_TASK,session_id:'wrun_'+'C'.repeat(26),channel_id:'fixture-channel',agent_id:'fixture-agent',goal:'Synthetic private goal'}
async function fixture(t:any,scope=true) {
 const dir=await mkdtemp(join(tmpdir(),'tarx-computer-http-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const pairs=createFilePairStore(join(dir,'pairs.json')),owners=createFileOwnerStore(join(dir,'owners.json'))
 const challenge=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'f'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))})
 assert.ok(challenge.ok);if(!challenge.ok)throw Error('fixture pairing')
 assert.equal(await approvePairingChallenge(challenge.challenge,pairs,Date.now(),scope?COMPUTER_TASK:undefined),true)
 let calls=0,grant:ComputerSession|null={session_id:request.session_id,subject_id:subject,install_id:'fixture_install',channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+10000,max_steps:4,timeout_ms:1000}
 const tasks=createComputerTaskController({file:join(dir,'tasks.json'),coreSource:core,authority:{resolve:async()=>grant},executor:{ready:async()=>true,run:async()=>{calls++;return {outcome:'done',independent_verified:true,native_actions:1,model_calls:1,core_source:core,execution_mode:'local_model'}}}})
 const server=createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore:pairs,ownerStore:owners,computerTasks:tasks,eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false})})
 const {port}=await server.listen();const base='http://127.0.0.1:'+port
 t.after(async()=>{await tasks.close();await server.close()})
 const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:challenge.challenge})})
 assert.equal(claim.status,200);const bearer=(await claim.json()).pairing_credential
 return {base,headers:{origin,'content-type':'application/json',authorization:'Bearer '+bearer},calls:()=>calls,removeGrant:()=>{grant=null},revoke:()=>revokePairing(createHash('sha256').update(challenge.challenge).digest('hex'),pairs),dir}
}
test('computer route requires fresh scope and native channel/session approval; verified receipt returns to the same channel',async t=>{
 const f=await fixture(t)
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:f.headers,body:JSON.stringify(request)})).status,202)
 let result:any
 for(let i=0;i<50;i++){result=await(await fetch(f.base+'/computer-tasks/'+request.request_id,{headers:f.headers})).json();if(result.status==='completed')break;await new Promise(r=>setTimeout(r,10))}
 assert.equal(result.status,'completed');assert.equal(result.receipt.channel_id,request.channel_id);assert.equal(result.receipt.agent_id,request.agent_id)
 assert.equal(f.calls(),1)
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:f.headers,body:JSON.stringify(request)})).status,200)
 assert.doesNotMatch(await readFile(join(f.dir,'tasks.json'),'utf8'),/Synthetic private goal|tpc_/)
 await f.revoke();assert.equal((await fetch(f.base+'/computer-tasks/'+request.request_id,{headers:f.headers})).status,401)
})
test('read-only pairing, a foreign origin or browser-supplied approval cannot execute',async t=>{
 const f=await fixture(t,false)
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:f.headers,body:JSON.stringify(request)})).status,403)
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:{...f.headers,origin:'https://evil.test'},body:JSON.stringify(request)})).status,403)
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:f.headers,body:JSON.stringify({...request,approved:true})})).status,400)
 assert.equal((await fetch(f.base+'/computer-tasks/'+request.request_id,{headers:f.headers})).status,403)
 assert.equal(f.calls(),0)
})
test('a paired task scope without native approval remains blocked and no fixture tool is auto-advertised',async t=>{
 const f=await fixture(t);f.removeGrant()
 assert.equal((await fetch(f.base+'/computer-tasks',{method:'POST',headers:f.headers,body:JSON.stringify(request)})).status,403)
 const capability=await(await fetch(f.base+'/task-capabilities',{headers:f.headers})).json()
 assert.deepEqual(capability,{available_tasks:[COMPUTER_TASK],permitted_tasks:[COMPUTER_TASK]})
 assert.equal(f.calls(),0)
})
