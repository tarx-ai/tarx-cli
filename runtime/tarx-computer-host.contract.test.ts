/** Fixture host consent and read-only native observation.
 * The session id is a fixed fixture string. This file does not mint one.
 * It does not claim a live planner, Always On, or a macOS host. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge} from './tarx-browser-pairing.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createNativeComputerExecutor,type ComputerArtifacts,type NativeScope} from './tarx-computer-executor.ts'
import {COMPUTER_TASK,computerIntentHash,type ComputerRequest,type ComputerSession} from './tarx-computer-task.ts'
import {connectComputerHost,createComputerHostConsent,issueNativeHostGrant} from './tarx-computer-consent.ts'
import {runRuntimeEntry} from './tarx-runtime-entry.ts'
const origin='https://www.tarx.com',subject='tvs_'+'a'.repeat(32),core='c'.repeat(40)
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const request:ComputerRequest={request_id:'host_consent_0001',task:COMPUTER_TASK,session_id:'wrun_'+'D'.repeat(26),channel_id:'qa-pass',agent_id:'channel-agent:qa-pass',goal:'Open the fixture control'}
const action={command:'click' as const,role:'button',name:'Fixture action'}
const check={kind:'enabled' as const,role:'button',name:'Fixture result'}
function scope():NativeScope{return {app:'Fixture',window:{id:'w-1',pid:123,title_sha256:hash('Fixture')},actions:[action],success:[check],mode:'deterministic_actuator',steps:[{action,expect:[check]}]}}
function session(now:number,patch:Partial<ComputerSession>={}):ComputerSession{
 return {session_id:request.session_id,subject_id:subject,install_id:'fixture_install',channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:now+60000,max_steps:2,timeout_ms:4000,...patch}
}
async function artifacts(t:any,clickLog:string){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'tarx-host-consent-')));t.after(()=>rm(dir,{recursive:true,force:true}))
 const files:Record<string,string>={
  'package.json':JSON.stringify({type:'module'}),
  'adapter.js':`import {writeFileSync} from 'node:fs';export class AgentDesktop {constructor(){if(!process.env.HOME.includes('tarx-cu-'))throw Error('ambient home')}async exec(argv){if(argv[0]==='click'){writeFileSync(${JSON.stringify(clickLog)},'click\\n',{flag:'a'});return {data:{}}}if(argv[0]==='list-windows')return {data:[{id:'w-1',pid:123,title:'Fixture'}]};throw Error('unexpected native command '+argv[0])}async snapshot(){return {tree:{ref_id:'@fixture:e1',role:'button',name:'Fixture action'}}}}`,
  'refs.js':`export const indexRefs=tree=>new Map([[tree.ref_id,tree]])`,
  'policy.js':`export const buildActionArgv=(action)=>({ok:true,argv:['click',action.ref],risk:{level:'low'}})`,
  'loop.js':`export const verifyAll=async()=>({passed:true});export const runTask=async()=>{throw Error('fixture is not a planner')}`,
  'model.js':`export const createLoopbackClient=()=>{throw Error('no model in fixture')}`,
 }
 const coreDir=join(dir,'core');await mkdir(coreDir)
 for(const [name,body] of Object.entries(files))await writeFile(join(coreDir,name),body)
 const node=await realpath(process.execPath),sha256=hash(await readFile(node))
 const built:ComputerArtifacts={coreSource:core,coreDirectory:coreDir,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,hash(b)])),node:{path:node,sha256},adapter:{path:node,sha256}}
 return {dir,built}
}
async function clicks(file:string){return readFile(file,'utf8').then(v=>v.length?v.trim().split('\n').length:0,()=>0)}

test('paired runtime still refuses execution until host consent matches channel, agent, request, actions, and expiry',async t=>{
 const now={value:Date.now()}
 const consent=createComputerHostConsent(()=>now.value)
 const scratch=await realpath(await mkdtemp(join(tmpdir(),'tarx-host-consent-')));t.after(()=>rm(scratch,{recursive:true,force:true}))
 const clickLog=join(scratch,'clicks.log')
 const {built}=await artifacts(t,clickLog)
 const pairs=createFilePairStore(join(scratch,'pairs.json')),owners=createFileOwnerStore(join(scratch,'owners.json'))
 const challenge=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'f'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))})
 assert.ok(challenge.ok);if(!challenge.ok)throw Error('fixture pairing')
 assert.equal(await approvePairingChallenge(challenge.challenge,pairs,Date.now(),COMPUTER_TASK),true)
 const tasks=connectComputerHost({file:join(scratch,'tasks.json'),coreSource:core,artifacts:built,consent})
 const server=createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore:pairs,ownerStore:owners,computerTasks:tasks,eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false})})
 const {port}=await server.listen();const base='http://127.0.0.1:'+port
 t.after(async()=>{await tasks.close();await server.close()})
 const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:challenge.challenge})})
 assert.equal(claim.status,200)
 const headers={origin,'content-type':'application/json',authorization:'Bearer '+(await claim.json()).pairing_credential}
 const post=(body:unknown)=>fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(body)})
 const caps=await(await fetch(base+'/task-capabilities',{headers})).json()
 assert.ok(caps.permitted_tasks.includes(COMPUTER_TASK))
 assert.equal((await post(request)).status,403)
 assert.equal(await clicks(clickLog),0)
 assert.throws(()=>consent.grant({request_id:request.request_id,actions:[{...action,name:'Other action'}],session:session(now.value),scope:scope()}),/invalid_computer_consent/)
 assert.throws(()=>consent.grant({request_id:request.request_id,actions:[action],session:{...session(now.value),session_id:'minted-on-the-vm'},scope:scope()}),/invalid_computer_consent/)
 consent.grant({request_id:request.request_id,actions:[action],session:session(now.value,{channel_id:'other-channel'}),scope:scope()})
 assert.equal((await post(request)).status,403)
 consent.revoke(request.session_id)
 consent.grant({request_id:'host_consent_0002',actions:[action],session:session(now.value,{intent_sha256:computerIntentHash({...request,request_id:'host_consent_0002'})}),scope:scope()})
 assert.equal((await post(request)).status,403)
 consent.revoke(request.session_id)
 const saved=session(now.value)
 consent.grant({request_id:request.request_id,actions:[action],session:saved,scope:scope()})
 now.value=saved.expires_at+1
 assert.equal((await post(request)).status,403)
 now.value=saved.expires_at-1000
 assert.equal((await post({...request,actions:['click everything']})).status,400)
 assert.equal((await post(request)).status,202)
 let result:any
 for(let i=0;i<100;i++){result=await(await fetch(base+'/computer-tasks/'+request.request_id,{headers})).json();if(['completed','failed','cancelled','uncertain'].includes(result.status))break;await new Promise(r=>setTimeout(r,50))}
 assert.equal(result.status,'completed');assert.equal(result.receipt.independent_verified,true);assert.equal(result.receipt.native_actions,1);assert.equal(result.receipt.model_calls,0)
 assert.equal(await clicks(clickLog),1)
 assert.equal((await consent.resolveScope(saved,{request_id:'host_consent_0002'})),null)
 assert.deepEqual((await consent.resolveScope(saved,request))?.actions,[action])
})

test('native recovery observation checks the consented window and does not click again',async t=>{
 const consent=createComputerHostConsent()
 const clickLog=join(await realpath(await mkdtemp(join(tmpdir(),'tarx-observe-'))),'clicks.log')
 t.after(()=>rm(join(clickLog,'..'),{recursive:true,force:true}))
 const {built}=await artifacts(t,clickLog)
 const saved=session(Date.now())
 consent.grant({request_id:request.request_id,actions:[action],session:saved,scope:scope()})
 const executor=createNativeComputerExecutor({artifacts:built,resolveScope:(s,r)=>consent.resolveScope(s,r)})
 const run=await executor.run({request,session:saved,signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(run.native_actions,1);assert.equal(await clicks(clickLog),1)
 assert.equal(typeof executor.observe,'function')
 const observed=await executor.observe!({request,session:saved,signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(observed.outcome,'done');assert.equal(observed.independent_verified,true);assert.equal(observed.native_actions,0);assert.equal(observed.model_calls,0)
 assert.equal(observed.execution_mode,'deterministic_actuator')
 assert.equal(await clicks(clickLog),1)
})

test('serve attaches host consent: a matching grant submits and no grant does not click',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tarx-serve-host-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const clickLog=join(root,'clicks.log')
 const {built}=await artifacts(t,clickLog)
 const state=join(root,'state'),key=join(root,'cli')
 await writeFile(key,'tarx_cli_'+'f'.repeat(64),{mode:0o600})
 const fetcher=(async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))) as typeof fetch
 const ch:any=await runRuntimeEntry(['challenge','--state-dir',state,'--credential-file',key],{fetcher})
 assert.equal(ch.ok,true)
 assert.deepEqual(await runRuntimeEntry(['approve','--state-dir',state,'--challenge',ch.challenge,'--task',COMPUTER_TASK]),{ok:true})
 const install_id=(await readFile(join(state,'install-id'),'utf8')).trim()
 const consent=createComputerHostConsent()
 const running:any=await runRuntimeEntry(['serve','--state-dir',state,'--worker-url','http://127.0.0.1:9','--port','0'],{clientFactory:()=>({health:async()=>({ok:true,status:'ready'}),sessions:{attach:()=>({async *stream(){}})}}),computerHost:{artifacts:built,consent}})
 try{
  const base='http://127.0.0.1:'+running.address.port
  const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:ch.challenge})})
  assert.equal(claim.status,200)
  const headers={origin,'content-type':'application/json',authorization:'Bearer '+(await claim.json()).pairing_credential}
  const denied=await fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(request)})
  assert.equal(denied.status,403);assert.equal((await denied.json()).error,'computer_session_approval_required')
  assert.equal(await clicks(clickLog),0)
  consent.grant({request_id:request.request_id,actions:[action],session:session(Date.now(),{install_id}),scope:scope()})
  assert.equal((await fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(request)})).status,202)
  let result:any
  for(let i=0;i<100;i++){result=await(await fetch(base+'/computer-tasks/'+request.request_id,{headers})).json();if(['completed','failed','cancelled','uncertain'].includes(result.status))break;await new Promise(r=>setTimeout(r,50))}
  assert.equal(result.status,'completed');assert.equal(result.receipt.native_actions,1);assert.equal(result.receipt.model_calls,0)
  assert.equal(await clicks(clickLog),1)
 }finally{await running.listener.close()}
})

test('a null session id binds the stored host session for the same channel, agent, and request',async t=>{
 const scratch=await realpath(await mkdtemp(join(tmpdir(),'tarx-null-session-')));t.after(()=>rm(scratch,{recursive:true,force:true}))
 const clickLog=join(scratch,'clicks.log')
 const {built}=await artifacts(t,clickLog)
 const open:ComputerRequest={...request,request_id:'host_consent_null1'}
 const consent=createComputerHostConsent()
 const pairs=createFilePairStore(join(scratch,'pairs.json')),owners=createFileOwnerStore(join(scratch,'owners.json'))
 const challenge=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'f'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))})
 assert.ok(challenge.ok);if(!challenge.ok)throw Error('fixture pairing')
 assert.equal(await approvePairingChallenge(challenge.challenge,pairs,Date.now(),COMPUTER_TASK),true)
 const tasks=connectComputerHost({file:join(scratch,'tasks.json'),coreSource:core,artifacts:built,consent})
 const server=createPairedSessionListener({host:'127.0.0.1',port:0,allowedOrigins:new Set([origin]),pairStore:pairs,ownerStore:owners,computerTasks:tasks,eveClient:()=>({attach:()=>({async *stream(){}})}),readiness:async()=>({config_valid:true,worker_reachable:false,model_responsive:false,tools:[],healthy:false})})
 const {port}=await server.listen();const base='http://127.0.0.1:'+port
 t.after(async()=>{await tasks.close();await server.close()})
 const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:challenge.challenge})})
 assert.equal(claim.status,200)
 const headers={origin,'content-type':'application/json',authorization:'Bearer '+(await claim.json()).pairing_credential}
 const body={...open,session_id:null}
 const post=()=>fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(body)})
 assert.equal((await post()).status,403)
 assert.equal(await clicks(clickLog),0)
 const foreign={...open,channel_id:'other-channel'}
 consent.grant({request_id:foreign.request_id,actions:[action],session:{...session(Date.now()),channel_id:foreign.channel_id,intent_sha256:computerIntentHash(foreign)},scope:scope()})
 assert.equal((await post()).status,403)
 assert.equal(await clicks(clickLog),0)
 consent.revoke(open.session_id)
 consent.grant({request_id:open.request_id,actions:[action],session:session(Date.now(),{intent_sha256:computerIntentHash(open)}),scope:scope()})
 const accepted=await post()
 assert.equal(accepted.status,202)
 const reserved=await accepted.json()
 assert.equal(reserved.session_id,open.session_id)
 let result:any
 for(let i=0;i<100;i++){result=await(await fetch(base+'/computer-tasks/'+open.request_id,{headers})).json();if(['completed','failed','cancelled','uncertain'].includes(result.status))break;await new Promise(r=>setTimeout(r,50))}
 assert.equal(result.status,'completed');assert.equal(result.receipt.session_id,open.session_id);assert.equal(result.receipt.native_actions,1);assert.equal(result.receipt.model_calls,0)
 assert.equal(await clicks(clickLog),1)
})

test('native host grant issues a bound session; pairing and missing artifacts do not',async t=>{
 const {built}=await artifacts(t,join(tmpdir(),'tarx-issue-unused'))
 const consent=createComputerHostConsent()
 const asked={request_id:'host_issue_00001',channel_id:'qa-pass',agent_id:'channel-agent:qa-pass',goal:'Open the fixture control'}
 const expires_at=Date.now()+60000
 const scratch=await mkdtemp(join(tmpdir(),'tarx-issue-pair-'));t.after(()=>rm(scratch,{recursive:true,force:true}))
 const pairs=createFilePairStore(join(scratch,'pairs.json'))
 const challenge=await createPairingChallenge({loadCredential:async()=>'tarx_cli_'+'e'.repeat(64),install_id:'fixture_install',store:pairs,fetcher:async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))})
 assert.ok(challenge.ok);if(!challenge.ok)throw Error('fixture pairing')
 assert.equal(await approvePairingChallenge(challenge.challenge,pairs,Date.now(),COMPUTER_TASK),true)
 assert.equal(await consent.authority.bind({task:COMPUTER_TASK,...asked}),null)
 const broken={...built,files:{...built.files,'adapter.js':'0'.repeat(64)}}
 assert.equal(await issueNativeHostGrant({artifacts:broken,consent,request:asked,subject_id:subject,install_id:'fixture_install',actions:[action],scope:scope(),expires_at,max_steps:2,timeout_ms:4000}),null)
 assert.equal(await consent.authority.bind({task:COMPUTER_TASK,...asked}),null)
 const issued=await issueNativeHostGrant({artifacts:built,consent,request:asked,subject_id:subject,install_id:'fixture_install',actions:[action],scope:scope(),expires_at,max_steps:2,timeout_ms:4000})
 assert.ok(issued)
 assert.match(issued.session_id,/^wrun_[0-9A-Z]{26}$/)
 assert.equal(issued.channel_id,asked.channel_id)
 assert.equal(issued.agent_id,asked.agent_id)
 assert.equal(issued.subject_id,subject)
 assert.equal(issued.install_id,'fixture_install')
 assert.equal(issued.expires_at,expires_at)
 assert.equal(issued.intent_sha256,computerIntentHash({task:COMPUTER_TASK,session_id:issued.session_id,...asked}))
 const stored=await consent.authority.resolve(issued.session_id)
 assert.equal(stored?.session_id,issued.session_id)
 assert.equal((await consent.authority.bind({task:COMPUTER_TASK,...asked}))?.session_id,issued.session_id)
 assert.equal(await consent.authority.bind({task:COMPUTER_TASK,...asked,channel_id:'other-channel'}),null)
 assert.deepEqual((await consent.resolveScope(issued,{request_id:asked.request_id}))?.actions,[action])
})

test('paired serve is bound to the stored host session and pairing grants nothing',async t=>{
 const root=await realpath(await mkdtemp(join(tmpdir(),'tarx-serve-bound-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const clickLog=join(root,'clicks.log')
 const {built}=await artifacts(t,clickLog)
 const state=join(root,'state'),key=join(root,'cli')
 await writeFile(key,'tarx_cli_'+'e'.repeat(64),{mode:0o600})
 const fetcher=(async()=>new Response(JSON.stringify({ok:true,subject_id:subject}))) as typeof fetch
 const ch:any=await runRuntimeEntry(['challenge','--state-dir',state,'--credential-file',key],{fetcher})
 assert.equal(ch.ok,true)
 assert.deepEqual(await runRuntimeEntry(['approve','--state-dir',state,'--challenge',ch.challenge,'--task',COMPUTER_TASK]),{ok:true})
 assert.doesNotMatch(await readFile(join(state,'pairs.json'),'utf8'),/wrun_/)
 const install_id=(await readFile(join(state,'install-id'),'utf8')).trim()
 const consent=createComputerHostConsent()
 const asked={request_id:'host_serve_bound1',channel_id:'qa-pass',agent_id:'channel-agent:qa-pass',goal:'Open the fixture control'}
 const fixture=request.session_id
 const open={task:COMPUTER_TASK,session_id:fixture,...asked}
 const expires_at=Date.now()+60000
 const running:any=await runRuntimeEntry(['serve','--state-dir',state,'--worker-url','http://127.0.0.1:9','--port','0'],{clientFactory:()=>({health:async()=>({ok:true,status:'ready'}),sessions:{attach:()=>({async *stream(){}})}}),computerHost:{artifacts:built,consent}})
 try{
  const base='http://127.0.0.1:'+running.address.port
  const claim=await fetch(base+'/pairing/claim',{method:'POST',headers:{origin,'content-type':'application/json'},body:JSON.stringify({challenge:ch.challenge})})
  assert.equal(claim.status,200)
  const headers={origin,'content-type':'application/json',authorization:'Bearer '+(await claim.json()).pairing_credential}
  const body={task:COMPUTER_TASK,...asked,session_id:null}
  const denied=await fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(body)})
  assert.equal(denied.status,403);assert.equal((await denied.json()).error,'computer_session_approval_required')
  assert.equal(await clicks(clickLog),0)
  const foreign={...open,channel_id:'other-channel'}
  consent.grant({request_id:asked.request_id,actions:[action],session:{session_id:fixture,subject_id:subject,install_id,channel_id:'other-channel',agent_id:asked.agent_id,intent_sha256:computerIntentHash(foreign),expires_at,max_steps:2,timeout_ms:4000},scope:scope()})
  assert.equal((await fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(body)})).status,403)
  assert.equal(await clicks(clickLog),0)
  consent.revoke(fixture)
  consent.grant({request_id:asked.request_id,actions:[action],session:{session_id:fixture,subject_id:subject,install_id,channel_id:asked.channel_id,agent_id:asked.agent_id,intent_sha256:computerIntentHash(open),expires_at,max_steps:2,timeout_ms:4000},scope:scope()})
  const stored=await consent.authority.resolve(fixture)
  assert.equal(stored?.channel_id,asked.channel_id)
  assert.equal(stored?.agent_id,asked.agent_id)
  assert.equal(stored?.expires_at,expires_at)
  assert.equal(stored?.intent_sha256,computerIntentHash(open))
  assert.deepEqual((await consent.resolveScope(stored!,{request_id:asked.request_id}))?.actions,[action])
  assert.equal((await fetch(base+'/computer-tasks',{method:'POST',headers,body:JSON.stringify(body)})).status,202)
  let result:any
  for(let i=0;i<100;i++){result=await(await fetch(base+'/computer-tasks/'+asked.request_id,{headers})).json();if(['completed','failed','cancelled','uncertain'].includes(result.status))break;await new Promise(r=>setTimeout(r,50))}
  const readBack=await(await fetch(base+'/computer-tasks/'+asked.request_id,{headers})).json()
  assert.equal(readBack.status,'completed')
  assert.equal(readBack.receipt.session_id,fixture)
  assert.equal(readBack.receipt.channel_id,asked.channel_id)
  assert.equal(readBack.receipt.agent_id,asked.agent_id)
  assert.equal(readBack.receipt.native_actions,1)
  assert.equal(readBack.receipt.model_calls,0)
  assert.equal(await clicks(clickLog),1)
  assert.equal(result.status,'completed')
 }finally{await running.listener.close()}
})
