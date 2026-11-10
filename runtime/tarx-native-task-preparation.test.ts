/** Native preparation fixtures: no real principal, native action, model or listener. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,readFile,writeFile,realpath,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createFilePairStore,pairingCredentialTaskAccess,type PairRecord} from './tarx-browser-pairing.ts'
import {prepareNativeHostTask,issueNativeHostGrant,createComputerHostConsent} from './tarx-computer-consent.ts'
import {COMPUTER_TASK,computerIntentHash} from './tarx-computer-task.ts'
import type {ComputerArtifacts,NativeScope} from './tarx-computer-executor.ts'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const credential='tpc_'+'b'.repeat(64),subject='tvs_'+'a'.repeat(32)
const task={task:COMPUTER_TASK,request_id:'browser_task_0001',channel_id:'fixture-channel',agent_id:'channel-agent:fixture-channel',goal:'Fixture task',context:'c'.repeat(64)}
function scope():NativeScope{
 const action={command:'click' as const,role:'button',name:'Fixture action'},check={kind:'enabled' as const,role:'button',name:'Fixture result'}
 return {app:'Fixture',window:{id:'w-1',pid:123,title_sha256:'d'.repeat(64)},actions:[action],success:[check],mode:'deterministic_actuator',steps:[{action,expect:[check]}]}
}
async function fixture(t:any){
 const root=await realpath(await mkdtemp(join(tmpdir(),'tarx-native-prepare-')));t.after(()=>rm(root,{recursive:true,force:true}))
 const directory=join(root,'core');await mkdir(directory)
 const files:Record<string,string>={}
 for(const name of ['package.json','adapter.js','refs.js','policy.js','loop.js','model.js']){
  files[name]=name==='package.json'?'{}':'throw Error("preparation must not import or execute this fixture")'
  await writeFile(join(directory,name),files[name])
 }
 const node=await realpath(process.execPath),adapter=join(root,'adapter')
 await writeFile(adapter,'fixture only; never executed',{mode:0o700})
 const artifacts:ComputerArtifacts={coreSource:'e'.repeat(40),coreDirectory:directory,files:Object.fromEntries(Object.entries(files).map(([k,v])=>[k,hash(v)])),node:{path:node,sha256:hash(await readFile(node))},adapter:{path:adapter,sha256:hash('fixture only; never executed')}}
 const clock={value:Date.now()},file=join(root,'pairs.json'),pairStore=createFilePairStore(file)
 const record:PairRecord={challenge_hash:'f'.repeat(64),subject_id:subject,install_id:'fixture_install',created_at:clock.value,expires_at:clock.value+120000,approved:true,claimed:true,revoked:false,pairing_hash:hash(credential),pairing_expires_at:clock.value+120000,task_scopes:[COMPUTER_TASK]}
 await pairStore.put(record)
 const input={pairStore,pairingCredential:credential,task:{...task},artifacts,resolveScope:async()=>scope(),expires_at:clock.value+60000,max_steps:2,timeout_ms:4000,now:()=>clock.value}
 return {input,record,clock,file}
}
test('native preparation resolves existing scoped principal, creates only a host request, and writes no grant',async t=>{
 const f=await fixture(t),before=await readFile(f.file,'utf8')
 const prepared=await prepareNativeHostTask(f.input);assert.ok(prepared)
 assert.equal(prepared.state,'prepared');assert.equal(prepared.execution_authorized,false)
 assert.equal(prepared.grant.subject_id,subject);assert.equal(prepared.grant.install_id,'fixture_install')
 assert.match(prepared.grant.request.request_id,/^nhr_[a-f0-9]{32}$/)
 assert.notEqual(prepared.grant.request.request_id,task.request_id)
 assert.equal('session_id' in prepared.grant,false)
 assert.equal(JSON.stringify(prepared).includes(credential),false)
 assert.equal(await readFile(f.file,'utf8'),before)
 assert.equal(await prepared.grant.stillAuthorized!(),true)
})
test('missing, malformed, revoked, unclaimed, expired and unscoped pairs never invoke scope discovery',async t=>{
 const f=await fixture(t);let calls=0
 for(const patch of [{revoked:true},{approved:false},{claimed:false},{pairing_expires_at:f.clock.value},{task_scopes:[]},{subject_id:'unverified'},{install_id:'../foreign'},{pairing_hash:'0'.repeat(64)}]){
  await f.input.pairStore.put({...f.record,...patch})
  assert.equal(await prepareNativeHostTask({...f.input,resolveScope:async()=>{calls++;return scope()}}),null)
 }
 assert.equal(await prepareNativeHostTask({...f.input,pairingCredential:'invalid'}),null)
 assert.equal(calls,0)
})
test('canonical task fields and native limits are enforced without accepting caller authority',async t=>{
 const f=await fixture(t)
 const badTasks=[{...task,request_id:'short'},{...task,goal:' '},{...task,goal:'x'.repeat(2001)},{...task,context:'x'.repeat(4001)},
  {...task,subject_id:subject},{...task,install_id:'injected'},{...task,session_id:null},{...task,actions:[]},{...task,task:'other'}]
 for(const bad of badTasks)assert.equal(await prepareNativeHostTask({...f.input,task:bad}),null)
 for(const patch of [{max_steps:0},{max_steps:9},{timeout_ms:0},{timeout_ms:45001},{expires_at:f.clock.value},{expires_at:f.clock.value+600001}])
  assert.equal(await prepareNativeHostTask({...f.input,...patch}),null)
})
test('revocation and expiry during asynchronous scope or store reads cannot produce a prepared task',async t=>{
 const f=await fixture(t)
 const revoked=await prepareNativeHostTask({...f.input,resolveScope:async()=>{await f.input.pairStore.put({...f.record,revoked:true});return scope()}})
 assert.equal(revoked,null)
 await f.input.pairStore.put(f.record)
 const slow={...f.input.pairStore,byPairingHash:async(value:string)=>{const record=await f.input.pairStore.byPairingHash(value);f.clock.value=record!.pairing_expires_at!;return record}}
 assert.equal(await pairingCredentialTaskAccess(credential,slow,()=>f.clock.value),null)
})
test('artifacts, tasks, limits and discovered scope are captured rather than read again after an await',async t=>{
 const f=await fixture(t),nativeScope=scope(),originalNode=f.input.artifacts.node.sha256
 const prepared=await prepareNativeHostTask({...f.input,resolveScope:async request=>{
  assert.equal(Object.isFrozen(request),true)
  f.input.task.goal='changed later';f.input.max_steps=99;f.input.artifacts.node.sha256='0'.repeat(64)
  return nativeScope
 }})
 assert.ok(prepared);nativeScope.actions[0]!.name='changed later'
 assert.equal(prepared.grant.request.goal,task.goal);assert.equal(prepared.grant.max_steps,2)
 assert.equal(prepared.grant.artifacts.node.sha256,originalNode);assert.equal(prepared.grant.actions[0]!.name,'Fixture action')
})
test('pending native approval cannot issue after principal, installation, scope, expiry or revocation changes',async t=>{
 const f=await fixture(t)
 for(const patch of [{revoked:true},{subject_id:'tvs_'+'b'.repeat(32)},{install_id:'another_install'},{task_scopes:[]}]){
  await f.input.pairStore.put(f.record)
  const prepared=await prepareNativeHostTask(f.input);assert.ok(prepared)
  await f.input.pairStore.put({...f.record,...patch})
  const consent=createComputerHostConsent(),grant=consent.grant;let issued=0
  consent.grant=value=>{issued++;grant(value)}
  assert.equal(await issueNativeHostGrant({...prepared.grant,consent}),null)
  assert.equal(issued,0)
 }
})
test('issuer rechecks authorization after artifact verification and rejects callback failures or non-booleans',async t=>{
 const f=await fixture(t),prepared=await prepareNativeHostTask(f.input);assert.ok(prepared)
 for(const kind of ['second-false','throws','truthy']){
  const consent=createComputerHostConsent();let calls=0,issued=0
  consent.grant=()=>{issued++}
  const stillAuthorized=async()=>{calls++;if(kind==='throws')throw Error('fixture denial');if(kind==='truthy')return 'yes' as unknown as boolean;return calls===1}
  assert.equal(await issueNativeHostGrant({...prepared.grant,consent,stillAuthorized}),null)
  assert.equal(issued,0);assert.equal(calls,kind==='second-false'?2:1)
 }
})
test('Stop cancels pending preparation; late discovery cannot produce a prepared task',async t=>{
 const f=await fixture(t),controller=new AbortController()
 let entered!:()=>void,release!:(value:NativeScope)=>void
 const discovering=new Promise<void>(resolve=>{entered=resolve})
 const result=prepareNativeHostTask({...f.input,signal:controller.signal,resolveScope:()=>{entered();return new Promise<NativeScope>(resolve=>{release=resolve})}})
 await discovering;controller.abort();assert.equal(await result,null)
 release(scope())
 assert.equal(await prepareNativeHostTask({...f.input,signal:controller.signal}),null)
})
test('an unresponsive host authority cannot hang grant issuance or issue consent',async t=>{
 const f=await fixture(t),prepared=await prepareNativeHostTask(f.input);assert.ok(prepared)
 let issued=0;const consent=createComputerHostConsent();consent.grant=()=>{issued++}
 assert.equal(await issueNativeHostGrant({...prepared.grant,consent,stillAuthorized:()=>new Promise<boolean>(()=>{})}),null)
 assert.equal(issued,0)
})
test('only the native issuer chooses the session and task fields of an approved fixture grant',async t=>{
 const f=await fixture(t),prepared=await prepareNativeHostTask(f.input);assert.ok(prepared)
 const consent=createComputerHostConsent(),injected='wrun_'+'Z'.repeat(26)
 const request={...prepared.grant.request,session_id:injected,task:'foreign'}
 const issued=await issueNativeHostGrant({...prepared.grant,request,consent});assert.ok(issued)
 assert.notEqual(issued.session_id,injected)
 assert.equal(issued.intent_sha256,computerIntentHash({...prepared.grant.request,task:COMPUTER_TASK,session_id:issued.session_id}))
 consent.revoke(issued.session_id)
})
