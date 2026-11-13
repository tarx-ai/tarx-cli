import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createNativeComputerExecutor,verifyComputerArtifacts,validateNativeScope,resolveNativeAccountAccess,approvedNativeScopedClick,type ComputerArtifacts,type NativeScope} from './tarx-computer-executor.ts'
import {COMPUTER_TASK,computerIntentHash,type ComputerRequest,type ComputerSession} from './tarx-computer-task.ts'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const core='b'.repeat(40)
const request:ComputerRequest={request_id:'executor_fixture_01',task:COMPUTER_TASK,session_id:'wrun_'+'C'.repeat(26),channel_id:'fixture-channel',agent_id:'fixture-agent',goal:'Synthetic fixture only'}
const session:ComputerSession={session_id:request.session_id,subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture-install',channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+45000,max_steps:2,timeout_ms:4000}
const action={command:'click' as const,role:'button',name:'Fixture action'}
const check={kind:'enabled' as const,role:'button',name:'Fixture result'}
const scope:NativeScope={app:'Fixture',window:{id:'w-1',pid:123,title_sha256:hash('Fixture')},actions:[action],success:[check],mode:'deterministic_actuator',steps:[{action,expect:[check]}]}
test('an exact native plan satisfies only its generic click-effect or existing settings approval',()=>{
 const approved={app:scope.app,action:{command:'click',ref:'@fixture:e1'},risk:{level:'high',category:'external',why:'action effect requires approval'},targetRole:action.role,targetName:action.name}
 assert.equal(approvedNativeScopedClick(scope,approved),true)
 assert.equal(approvedNativeScopedClick(scope,{...approved,risk:{level:'high',category:'settings'}}),true)
 for(const category of ['credential','send','delete','submit','purchase','keystroke'])assert.equal(approvedNativeScopedClick(scope,{...approved,risk:{...approved.risk,category}}),false)
 for(const why of [undefined,'network or service access requires approval','action effect requires approval '])assert.equal(approvedNativeScopedClick(scope,{...approved,risk:{...approved.risk,why}}),false)
 for(const delta of [{app:'Foreign'},{targetRole:'menuitem'},{targetName:'Fixture action '},{action:{command:'press'}},{risk:{...approved.risk,level:'low'}},{risk:null},{action:null}])assert.equal(approvedNativeScopedClick(scope,{...approved,...delta}),false)
 for(const request of [null,undefined,[],{},'click'])assert.equal(approvedNativeScopedClick(scope,request),false)
 for(const malformed of [null,{}, {app:scope.app,actions:[null]}, {app:scope.app,actions:[]}])assert.equal(approvedNativeScopedClick(malformed as any,approved),false)
})
async function waitForFixtureAction(file:string,outcome:Promise<unknown>){
 // Artifact hashing and worker startup compete with other test files in CI.
 // Wait for actual action delivery, fail early on worker exit, and retain a deadline.
 let settled=false,error:unknown
 void outcome.then(()=>{settled=true},failure=>{settled=true;error=failure})
 const deadline=Date.now()+5000
 while(Date.now()<deadline){
  try{const pid=Number(await readFile(file,'utf8'));if(Number.isSafeInteger(pid)&&pid>0)return pid}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  if(settled)throw error??Error('fixture worker exited before action delivery')
  await new Promise(r=>setTimeout(r,10))
 }
 throw Error('fixture action delivery deadline exceeded')
}
async function fixture(t:any,hang=false,cursor=false,interruptOnStop=false,failClick=false){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'tarx-core-executor-test-')));t.after(()=>rm(dir,{recursive:true,force:true}))
 const pidFile=join(dir,'descendant-pid')
 const files:Record<string,string>={
  'package.json':JSON.stringify({type:'module'}),
  'adapter.js':`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';export class AgentDesktop {constructor(){if(!process.env.HOME.includes('tarx-cu-'))throw Error('ambient home')}async exec(argv){if(argv[0]==='session')return {data:{session_id:'cursor_fixture_session'}};if(argv[0]==='cursor-overlay')return {data:{rendered:true}};if(argv[0]==='list-windows')return {data:[{id:'w-1',pid:123,title:'Fixture'}]};if(argv[0]==='click'){${failClick?`throw Error('fixture click failure')` : hang?`const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});return new Promise((_,reject)=>{${interruptOnStop?`process.once('SIGTERM',()=>reject(Error('fixture action interrupted during Stop')));` : ''}writeFileSync(${JSON.stringify(pidFile)},String(c.pid))})`:`return {data:{}}`}}throw Error('unexpected native command')}async snapshot(){return {tree:{ref_id:'@fixture:e1',role:'button',name:'Fixture action'}}}}`,
  'refs.js':`export const indexRefs=tree=>new Map([[tree.ref_id,tree]])`,
  'policy.js':`export const buildActionArgv=(action)=>({ok:true,argv:['click',action.ref],risk:{level:'low'}})`,
  'loop.js':`export const verifyAll=async()=>({passed:true});export const runTask=async()=>{throw Error('fixture is not a planner')}`,
  'model.js':`export const createLoopbackClient=()=>{throw Error('no model in fixture')}`,
 }
 for(const [name,body] of Object.entries(files))await writeFile(join(dir,name),body)
 // Keep pid output outside the immutable artifact inventory.
 const coreDir=join(dir,'core');await (await import('node:fs/promises')).mkdir(coreDir)
 for(const name of Object.keys(files))await (await import('node:fs/promises')).rename(join(dir,name),join(coreDir,name))
 const node=await realpath(process.execPath),sha256=hash(await readFile(node))
 const artifacts:ComputerArtifacts={coreSource:core,coreDirectory:coreDir,files:Object.fromEntries(Object.entries(files).map(([n,b])=>[n,hash(b)])),node:{path:node,sha256},adapter:{path:node,sha256}}
 if(cursor){
  const adapter=join(dir,'fixture-adapter'),ended=join(dir,'cursor-ended')
  const source='#!'+node+'\n'+`require('node:fs').writeFileSync(${JSON.stringify(ended)},JSON.stringify(process.argv.slice(2)));process.stdout.write(JSON.stringify({ok:true,data:{}}))`
  await writeFile(adapter,source,{mode:0o700});artifacts.adapter={path:adapter,sha256:hash(source)}
  const path=await realpath(new URL('./tarx-cursor.png',import.meta.url));artifacts.cursor={path,sha256:hash(await readFile(path))}
 }
 return {dir,pidFile,artifacts}
}
test('isolated worker rechecks exact artifacts and approved scope; deterministic native fixture is labeled separately',async t=>{
 const f=await fixture(t);let checks=0
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope})
 assert.equal(await executor.ready(),true)
 const result=await executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>{checks++;return true}})
 assert.deepEqual(result,{outcome:'done',independent_verified:true,native_actions:1,model_calls:0,core_source:core,execution_mode:'deterministic_actuator'})
 assert.ok(checks>=4)
 await writeFile(join(f.artifacts.coreDirectory,'adapter.js'),'tampered')
 assert.equal(await executor.ready(),false)
 await assert.rejects(verifyComputerArtifacts(f.artifacts),/mismatch/)
})
test('an adapter click failure emits an allowlisted deterministic failure',async t=>{
 const f=await fixture(t,false,false,false,true),outcomes:any[]=[]
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope,onOutcome:(outcome,requestId)=>outcomes.push({outcome,requestId})})
 await assert.rejects(executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true}))
 assert.equal(outcomes.length,1);assert.equal(outcomes[0].requestId,request.request_id)
 assert.equal(outcomes[0].outcome.failure_stage,'action');assert.equal(outcomes[0].outcome.failure_code,'NATIVE_TASK_FAILED')
})

test('read-only local-planner recovery does not invent a zero model total',async t=>{
 const f=await fixture(t),{steps,...rest}=scope
 const modelScope:NativeScope={...rest,mode:'local_model',model:{baseURL:'http://127.0.0.1:9',model:'uncontacted-fixture'},preparation_model_calls:1}
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>modelScope})
 const result=await executor.observe!({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(result.independent_verified,true);assert.equal(result.native_actions,0);assert.equal(result.model_calls,null)
})
test('cancellation confirms owned worker exit and kills its native descendant before acknowledging',async t=>{
 const f=await fixture(t,true),abort=new AbortController()
 t.after(()=>abort.abort())
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope})
 const result=executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:abort.signal,stillAuthorized:async()=>!abort.signal.aborted})
 const pid=await waitForFixtureAction(f.pidFile,result)
 assert.ok(pid>0);abort.abort()
 assert.equal((await result).outcome,'cancelled')
 let alive=true
 for(let i=0;i<100;i++){try{process.kill(pid,0)}catch{alive=false;break}await new Promise(r=>setTimeout(r,10))}
 assert.equal(alive,false,'native descendant must be gone')
})
test('late interrupted-worker errors do not replace an acknowledged Stop after owned exit',async t=>{
 const f=await fixture(t,true,false,true),abort=new AbortController()
 t.after(()=>abort.abort())
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope})
 const result=executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:abort.signal,stillAuthorized:async()=>!abort.signal.aborted})
 // Attach the rejection handler before triggering the deliberate worker error.
 const outcome=result.then(value=>({value}),error=>({error}))
 const pid=await waitForFixtureAction(f.pidFile,result)
 assert.ok(pid>0);abort.abort()
 const settled=await outcome
 assert.ok('value' in settled,'late worker interruption must remain cancellation')
 assert.equal(settled.value.outcome,'cancelled');assert.equal(settled.value.independent_verified,false)
 let alive=true
 for(let i=0;i<100;i++){try{process.kill(pid,0)}catch{alive=false;break}await new Promise(r=>setTimeout(r,10))}
 assert.equal(alive,false)
})
test('browser/model-like scope substitutions and additional artifact files fail closed',async t=>{
 const f=await fixture(t)
 for(const change of [{mode:'remote_model'},{model:{baseURL:'https://foreign.test',model:'x'},mode:'local_model',steps:undefined},{window:{...scope.window,title_sha256:'unverified'}},{steps:[{action:{...action,name:'Send'},expect:[check]}]}])
  assert.throws(()=>validateNativeScope({...scope,...change} as NativeScope,2))
 await writeFile(join(f.artifacts.coreDirectory,'extra.js'),'export {}')
 await assert.rejects(verifyComputerArtifacts(f.artifacts),/inventory_mismatch/)
})

test('late cursor ownership is retained for cleanup without reactivating presentation after Stop',async t=>{
 const f=await fixture(t,false,true),abort=new AbortController(),states:boolean[]=[]
 const marker=join(f.dir,'pending-native-session')
 const source=`import {writeFileSync} from 'node:fs';export class AgentDesktop {async exec(argv){if(argv[0]==='session'){return new Promise(resolve=>{process.once('SIGTERM',()=>resolve({data:{session_id:'cursor_fixture_session'}}));writeFileSync(${JSON.stringify(marker)},'waiting')})}if(argv[0]==='cursor-overlay')return {data:{rendered:true}};throw Error('unexpected fixture command')}}`
 await writeFile(join(f.artifacts.coreDirectory,'adapter.js'),source);f.artifacts.files['adapter.js']=hash(source)
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope,onCursorState:shown=>states.push(shown)})
 const result=executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:abort.signal,stillAuthorized:async()=>!abort.signal.aborted})
 for(let i=0;i<100;i++){try{await readFile(marker);break}catch{}await new Promise(r=>setTimeout(r,10))}
 assert.equal(await readFile(marker,'utf8'),'waiting');abort.abort()
 assert.equal((await result).outcome,'cancelled')
 assert.deepEqual(states,[false])
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'cursor-ended'),'utf8')),['session','end','cursor_fixture_session'])
})

test('cursor is session-owned, uses the canonical checked TARX asset and is ended by the parent on cancellation',async t=>{
 const f=await fixture(t,true,true),abort=new AbortController(),states:boolean[]=[]
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope,onCursorState:shown=>states.push(shown)})
 const result=executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:abort.signal,stillAuthorized:async()=>!abort.signal.aborted})
 for(let i=0;i<100;i++){try{await readFile(f.pidFile);break}catch{}await new Promise(r=>setTimeout(r,10))}
 abort.abort();assert.equal((await result).outcome,'cancelled')
 assert.deepEqual(states,[true,false])
 assert.deepEqual(JSON.parse(await readFile(join(f.dir,'cursor-ended'),'utf8')),['session','end','cursor_fixture_session'])
 const changed=join(f.dir,'changed-cursor.png');await writeFile(changed,'not the TARX asset')
 await assert.rejects(verifyComputerArtifacts({...f.artifacts,cursor:{path:changed,sha256:hash('not the TARX asset')}}),/unapproved_native_cursor/)
})

test('an unavailable local model fails before native session/cursor creation and preserves diagnostic outcome',async t=>{
 const f=await fixture(t,false,true),states:boolean[]=[],outcomes:any[]=[]
 const localScope:NativeScope={...scope,mode:'local_model',steps:undefined,model:{baseURL:'http://127.0.0.1:1',model:'fixture-unavailable'}}
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>localScope,onCursorState:s=>states.push(s),onOutcome:(o,id)=>outcomes.push({outcome:o,requestId:id})})
 const result=await executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(result.outcome,'error');assert.equal(result.planner_status,'unavailable');assert.equal(result.native_actions,0);assert.equal(result.model_calls,0)
 assert.equal(states.includes(true),false);assert.equal(outcomes.length,1);assert.equal(outcomes[0].requestId,request.request_id);assert.equal(outcomes[0].outcome.outcome,'error');assert.equal(outcomes[0].outcome.planner_status,'unavailable')
 await assert.rejects(readFile(join(f.dir,'cursor-ended')),/ENOENT/)
})

const remoteScope=():NativeScope=>({app:scope.app,window:scope.window,actions:scope.actions,success:scope.success,mode:'supercomputer',data_consent:'goal_and_scoped_controls',preparation_model_calls:1})
test('Supercomputer scope cannot carry a credential, override route or omit native data consent',()=>{
 validateNativeScope(remoteScope(),2)
 for(const change of [{data_consent:undefined},{token:'private'},{model:{baseURL:'https://foreign.invalid',model:'other'}},{steps:scope.steps},{endpoint:'https://foreign.invalid'},{window:{...scope.window,token:'private'}},{actions:[{...action,token:'private'}]},{success:[{...check,token:'private'}]}])assert.throws(()=>validateNativeScope({...remoteScope(),...change} as NativeScope,2),/invalid_native_scope/)
})
test('Supercomputer requires host-owned account access and rechecks authority after credential loading',async t=>{
 const f=await fixture(t),run={request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true}
 const absent=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope()})
 await assert.rejects(absent.run(run),/native_account_access_required/)
 const wrong=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope(),resolveAccountAccess:async()=> ({token:'service-key',subject_id:session.subject_id})})
 await assert.rejects(wrong.run(run),/native_account_access_required/)
 const foreign=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope(),resolveAccountAccess:async()=>({token:'tarx_cli_'+'1'.repeat(64),subject_id:'tvs_'+'f'.repeat(32)})})
 await assert.rejects(foreign.run(run),/native_account_access_required/)
 let allowed=true
 const revoked=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope(),resolveAccountAccess:async input=>{assert.equal(input.session.subject_id,session.subject_id);allowed=false;return {token:'tarx_cli_'+'1'.repeat(64),subject_id:session.subject_id}}})
 await assert.rejects(revoked.run({...run,stillAuthorized:async()=>allowed}),/computer_cancelled/)
})
test('Supercomputer crash recovery observes only and never reads account access or calls a planner',async t=>{
 const f=await fixture(t);let reads=0
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope(),resolveAccountAccess:async()=>{reads++;throw Error('must not read account in recovery')}})
 const result=await executor.observe!({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(reads,0);assert.equal(result.execution_mode,'supercomputer');assert.equal(result.native_actions,0);assert.equal(result.model_calls,null);assert.equal(result.independent_verified,true)
})
test('actual isolated worker honors native generic-effect approval, bounded account latency and private context',async t=>{
 const f=await fixture(t),account='tarx_cli_'+'1'.repeat(64)
 const observe=`export const renderObservation=tree=>({text:'[7] button "Fixture action"',handles:new Map([[7,'@fixture:e1']])})`
 const loop=`export const verifyAll=async()=>({passed:true});export const runTask=async(ad,model,_task,{approve})=>{await ad.snapshot('Fixture');const input=[{role:'user',content:'Goal: Fixture task\\nHistory:\\nPRIVATE_HISTORY_MUST_NOT_LEAVE_HOST\\nObservation:\\n[7] button "Fixture action"'}];const step=JSON.parse(await model.complete(input));if(step.action.target!==7)throw Error('fixture scope');if(!await approve({app:'Fixture',action:{command:'click',ref:'@fixture:e1'},risk:{level:'high',category:'external',why:'action effect requires approval'},targetRole:'button',targetName:'Fixture action'}))throw Error('fixture native approval denied');await ad.act(['click','@fixture:e1']);await ad.snapshot('Fixture');if(JSON.parse(await model.complete(input)).status!=='done')throw Error('fixture done');return {outcome:'done',finalCheck:{passed:true}}}`
 for(const [name,source] of [['observe.js',observe],['loop.js',loop]]){await writeFile(join(f.artifacts.coreDirectory,name),source);f.artifacts.files[name]=hash(source)}
 const preload=join(f.dir,'fixture-https.mjs'),calls=join(f.dir,'canonical-calls')
 const mock=`process.on('message',message=>{if(message?.kind==='start'&&message.request?.context!==undefined)throw Error('fixture private context in IPC')});import https from 'node:https';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';import {writeFileSync} from 'node:fs';let posts=0;https.request=(url,options,cb)=>{const req=new EventEmitter();req.destroy=()=>{req.emit('close');return req};req.end=body=>queueMicrotask(()=>{if(!String(url).startsWith('https://compute.tarx.com/'))throw Error('foreign fixture route');const res=new PassThrough();res.statusCode=200;cb(res);if(String(url).endsWith('/health')){if(options.headers.authorization)throw Error('fixture health credential');res.end(JSON.stringify({status:'ok',upstream_healthy:true}));return}if(String(url)!=='https://compute.tarx.com/v1/chat/completions'||options.headers.authorization!=='Bearer '+${JSON.stringify(account)}||(body.includes('PRIVATE_CONTEXT_MUST_NOT_LEAVE_HOST')||body.includes('PRIVATE_HISTORY_MUST_NOT_LEAVE_HOST')))throw Error('fixture credential/context mismatch');const data=JSON.parse(body);if(!data.response_format?.json_schema?.strict)throw Error('fixture schema missing');posts++;writeFileSync(${JSON.stringify(calls)},String(posts));res.end(JSON.stringify({model:'tarx/t-supercomputer',choices:[{message:{content:JSON.stringify(posts===1?{status:'act',action:{command:'click',target:7},expect:{kind:'none'}}:{status:'done'})}}]}))});return req}`
 await writeFile(preload,mock)
 const shell=(value:string)=>"'"+value.replace(/'/g,"'\\''")+"'"
 const wrapper=join(f.dir,'fixture-node');const command='#!/bin/sh\nexec '+shell(process.execPath)+' --import '+shell(preload)+' "$@"\n';await writeFile(wrapper,command,{mode:0o700});f.artifacts.node={path:wrapper,sha256:hash(command)}
 const selected=remoteScope();let tokenReads=0
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>selected,resolveAccountAccess:async run=>{tokenReads++;await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,2200);run.signal.addEventListener('abort',()=>{clearTimeout(timer);reject(Error('fixture account verification aborted'))},{once:true})});return {token:account,subject_id:session.subject_id}}})
 const result=await executor.run({request:{...request,context:'PRIVATE_CONTEXT_MUST_NOT_LEAVE_HOST'},session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>true})
 assert.equal(result.outcome,'done');assert.equal(result.execution_mode,'supercomputer');assert.equal(result.native_actions,1);assert.equal(result.model_calls,3);assert.equal(tokenReads,1);assert.equal(await readFile(calls,'utf8'),'2');assert.equal(JSON.stringify(result).includes(account),false);assert.equal(JSON.stringify(selected).includes(account),false)
})

test('native account access introspects one stable token and rejects a foreign or revoked subject',async()=>{
 const token='tarx_cli_'+'2'.repeat(64);let reads=0,calls=0
 const access=await resolveNativeAccountAccess({subject_id:session.subject_id,signal:new AbortController().signal,loadCredential:async()=>{reads++;return token},fetcher:(async(url,options)=>{calls++;assert.equal(url,'https://tarx.com/api/auth/cli/introspect');assert.deepEqual(JSON.parse(String(options?.body)),{token,spend:false});assert.equal(options?.redirect,'error');return new Response(JSON.stringify({ok:true,subject_id:session.subject_id}))}) as typeof fetch})
 assert.deepEqual(access,{token,subject_id:session.subject_id});assert.equal(reads,1);assert.equal(calls,1)
 for(const principal of [{ok:false},{ok:true,subject_id:'tvs_'+'f'.repeat(32)}])assert.equal(await resolveNativeAccountAccess({subject_id:session.subject_id,signal:new AbortController().signal,loadCredential:async()=>token,fetcher:(async()=>new Response(JSON.stringify(principal))) as typeof fetch}),null)
})

test('recovery rejects revoked worker authorization before reading native controls',async t=>{
 const f=await fixture(t),marker=join(f.dir,'recovery-observed')
 const adapter=`import {writeFileSync} from 'node:fs';export class AgentDesktop{async exec(argv){if(argv[0]==='list-windows')return {data:[{id:'w-1',pid:123,title:'Fixture'}]};if(argv[0]==='find'){writeFileSync(${JSON.stringify(marker)},'observed');return {data:{count:1}}}throw Error('unexpected fixture command')}async find(){return (await this.exec(['find'])).data}}`
 const loop=`export const runTask=async()=>{throw Error('observation only')};export const verifyAll=async ad=>({passed:(await ad.find()).count===1})`
 for(const [name,source] of [['adapter.js',adapter],['loop.js',loop]]){await writeFile(join(f.artifacts.coreDirectory,name),source);f.artifacts.files[name]=hash(source)}
 let checks=0
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>remoteScope()})
 await assert.rejects(executor.observe!({request,session:{...session,expires_at:Date.now()+10000},signal:new AbortController().signal,stillAuthorized:async()=>++checks<=2}),/computer_child_failed/)
 assert.equal(checks,3);await assert.rejects(readFile(marker),/ENOENT/)
})
