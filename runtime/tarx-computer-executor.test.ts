import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,writeFile,readFile,rm,realpath} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {createHash} from 'node:crypto'
import {createNativeComputerExecutor,verifyComputerArtifacts,validateNativeScope,type ComputerArtifacts,type NativeScope} from './tarx-computer-executor.ts'
import {COMPUTER_TASK,computerIntentHash,type ComputerRequest,type ComputerSession} from './tarx-computer-task.ts'
const hash=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
const core='b'.repeat(40)
const request:ComputerRequest={request_id:'executor_fixture_01',task:COMPUTER_TASK,session_id:'wrun_'+'C'.repeat(26),channel_id:'fixture-channel',agent_id:'fixture-agent',goal:'Synthetic fixture only'}
const session:ComputerSession={session_id:request.session_id,subject_id:'tvs_'+'a'.repeat(32),install_id:'fixture-install',channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:Date.now()+45000,max_steps:2,timeout_ms:4000}
const action={command:'click' as const,role:'button',name:'Fixture action'}
const check={kind:'enabled' as const,role:'button',name:'Fixture result'}
const scope:NativeScope={app:'Fixture',window:{id:'w-1',pid:123,title_sha256:hash('Fixture')},actions:[action],success:[check],mode:'deterministic_actuator',steps:[{action,expect:[check]}]}
async function fixture(t:any,hang=false){
 const dir=await realpath(await mkdtemp(join(tmpdir(),'tarx-core-executor-test-')));t.after(()=>rm(dir,{recursive:true,force:true}))
 const pidFile=join(dir,'descendant-pid')
 const files:Record<string,string>={
  'package.json':JSON.stringify({type:'module'}),
  'adapter.js':`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';export class AgentDesktop {constructor(){if(!process.env.HOME.includes('tarx-cu-'))throw Error('ambient home')}async exec(argv){if(argv[0]==='list-windows')return {data:[{id:'w-1',pid:123,title:'Fixture'}]};if(argv[0]==='click'){${hang?`const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidFile)},String(c.pid));return new Promise(()=>{})`:`return {data:{}}`}}throw Error('unexpected native command')}async snapshot(){return {tree:{ref_id:'@fixture:e1',role:'button',name:'Fixture action'}}}}`,
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
test('cancellation confirms owned worker exit and kills its native descendant before acknowledging',async t=>{
 const f=await fixture(t,true),abort=new AbortController()
 const executor=createNativeComputerExecutor({artifacts:f.artifacts,resolveScope:async()=>scope})
 const result=executor.run({request,session:{...session,expires_at:Date.now()+10000},signal:abort.signal,stillAuthorized:async()=>!abort.signal.aborted})
 let pid=0
 for(let i=0;i<100;i++){try{pid=Number(await readFile(f.pidFile,'utf8'));break}catch{}await new Promise(r=>setTimeout(r,10))}
 assert.ok(pid>0);abort.abort()
 assert.equal((await result).outcome,'cancelled')
 let alive=true
 for(let i=0;i<100;i++){try{process.kill(pid,0)}catch{alive=false;break}await new Promise(r=>setTimeout(r,10))}
 assert.equal(alive,false,'native descendant must be gone')
})
test('browser/model-like scope substitutions and additional artifact files fail closed',async t=>{
 const f=await fixture(t)
 for(const change of [{mode:'remote_model'},{model:{baseURL:'https://foreign.test',model:'x'},mode:'local_model',steps:undefined},{window:{...scope.window,title_sha256:'unverified'}},{steps:[{action:{...action,name:'Send'},expect:[check]}]}])
  assert.throws(()=>validateNativeScope({...scope,...change} as NativeScope,2))
 await writeFile(join(f.artifacts.coreDirectory,'extra.js'),'export {}')
 await assert.rejects(verifyComputerArtifacts(f.artifacts),/inventory_mismatch/)
})
