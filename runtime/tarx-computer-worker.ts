/** Owned subprocess only. No stdio diagnostics, stored context, screenshots or
 * ambient model/profile configuration. Parent enforces lifetime and authority. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {verifyComputerArtifacts,validateNativeScope,approvedNativeScopedClick,type ComputerArtifacts,type NativeScope} from './tarx-computer-executor.ts'
import {createScopedComputerPlanner,scopeNativeObservation,createLoopbackPlannerClient,createSupercomputerPlannerClient} from './tarx-computer-planner.ts'
type Job={artifacts:ComputerArtifacts;scope:NativeScope;request:{goal:string;context?:string};maxSteps:number;observe?:boolean;accountToken?:string}
let started=false,serial=0
let phase='artifacts'
const pending=new Map<number,(allowed:boolean)=>void>()
function authorize() {return new Promise<boolean>(resolve=>{const id=++serial;pending.set(id,resolve);process.send?.({kind:'authorize',id})})}
process.on('message',message=>{
 if(!message||typeof message!=='object')return
 const m=message as Job&{kind:string;id:number;allowed:boolean}
 if(m.kind==='authorization'){pending.get(m.id)?.(m.allowed===true);pending.delete(m.id);return}
 if(m.kind!=='start'||started)process.exit(1)
 started=true
 void run(m).then(result=>process.send?.({kind:'result',result},()=>process.exit(0)),error=>{
  const code=typeof error?.info?.code==='string'&&/^[A-Z_]{1,64}$/.test(error.info.code)?error.info.code:'NATIVE_TASK_FAILED'
  process.send?.({kind:'failure',phase,stage:['scope','identity','observation','target','action','verification'].includes(phase)?phase:'preflight',code},()=>process.exit(1))
 })
})
process.on('disconnect',()=>process.exit(1))
async function run(job:Job) {
 const {artifacts,scope}=job
 await verifyComputerArtifacts(artifacts);validateNativeScope(scope,job.maxSteps)
 const load=(name:string)=>import(pathToFileURL(join(artifacts.coreDirectory,name)).href)
 const [{AgentDesktop},{indexRefs},{buildActionArgv},{verifyAll,runTask}]=await Promise.all(['adapter.js','refs.js','policy.js','loop.js'].map(load))
 phase='scope'
 let latest:any,latestSurface:string|undefined,actions=0,modelCalls=scope.preparation_model_calls??0,plannerStatus:string|undefined
 const hash=(s:string)=>createHash('sha256').update(s).digest('hex')
 const rows=(data:any)=>Array.isArray(data)?data:data?.windows??[]
 class ScopedDesktop extends AgentDesktop {
  constructor(options:unknown){super(options)}
  async guard() {
   phase='identity'
   const current=rows((await super.exec(['list-windows','--app',scope.app])).data).filter((r:any)=>r.id===scope.window.id)
   if(current.length!==1||current[0].pid!==scope.window.pid||hash(String(current[0].title??''))!==scope.window.title_sha256||!await authorize())throw Error('native_identity_or_approval_changed')
  }
  async exec(argv:string[],opts:unknown) {
   if(['snapshot','find'].includes(argv[0])){await this.guard();phase='observation';return super.exec([...argv,...(argv[0]==='find'&&argv.includes('--name')&&!argv.includes('--exact')?['--exact']:[]),'--window-id',scope.window.id],opts)}
   if(argv[0]==='list-surfaces'){await this.guard();return super.exec(argv,opts)}
   throw Error('native_command_out_of_scope')
  }
  async snapshot(app:string,opts:{surface?:string;maxDepth?:number}={}) {
   if(app!==scope.app)throw Error('native_app_out_of_scope')
   latest=await super.snapshot(app,{maxDepth:30,...opts})
   latestSurface=opts.surface
   if(scope.mode!=='deterministic_actuator'&&!opts.surface)latest={...latest,tree:scopeNativeObservation(latest.tree,scope.actions)}
   return latest
  }
  async act(argv:string[]) {
   if(job.observe===true)throw Error('native_observation_is_read_only')
   const node=latest&&indexRefs(latest.tree).get(argv[1])
   if(argv.length!==2||argv[0]!=='click'||!node||!scope.actions.some(a=>a.command===argv[0]&&a.role===node.role&&a.name===node.name)||actions>=job.maxSteps)throw Error('native_action_out_of_scope')
   await this.guard();latest=undefined;phase='action'
   const result=await super.exec(argv,{timeoutMs:5000});actions++;return result.data
  }
 }
 if(job.observe===true){
  const ad=new ScopedDesktop({bin:artifacts.adapter.path,defaultTimeoutMs:5000})
  phase='observation'
  const passed=(await verifyAll(ad,scope.app,scope.success)).passed
  await ad.guard()
  // A recovery observation makes no model request, but cannot reconstruct the
  // interrupted planner's total generations. Do not turn unknown into zero.
  return {outcome:passed?'done':'unverified',independent_verified:passed,native_actions:0,model_calls:scope.mode==='deterministic_actuator'?0:null,core_source:artifacts.coreSource,execution_mode:scope.mode}
 }
 const localClient=scope.mode==='local_model'?createLoopbackPlannerClient(scope.model!):scope.mode==='supercomputer'?createSupercomputerPlannerClient({token:job.accountToken!}):undefined
 // The per-run credential remains only in the transport closure while needed.
 delete job.accountToken
 if(localClient&&!await localClient.ready())return {outcome:'error',independent_verified:false,native_actions:0,model_calls:modelCalls,core_source:artifacts.coreSource,execution_mode:scope.mode,planner_status:'unavailable'}
 let nativeSession:string|undefined
 const bootstrap=new AgentDesktop({bin:artifacts.adapter.path,defaultTimeoutMs:5000})
 if(artifacts.cursor){
  const created=await bootstrap.exec(['session','start','--name','TARX','--no-trace'])
  nativeSession=created.data?.session_id
  if(typeof nativeSession!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(nativeSession))throw Error('native_session_unavailable')
  process.send?.({kind:'native_session',session:nativeSession})
 }
 try{
 if(nativeSession){
  const shown=await bootstrap.exec(['cursor-overlay','enable','--session',nativeSession,'--image',artifacts.cursor!.path,'--pointer-image',artifacts.cursor!.path,'--hotspot','16,16','--pointer-hotspot','16,16','--accent','#38ADFA','--travel-ms','90,320','--tremor','0','--overshoot','0','--no-highlight'])
  if(shown.data?.rendered!==true)throw Error('native_cursor_unavailable')
  process.send?.({kind:'native_cursor',rendered:true})
 }
 const ad=new ScopedDesktop({bin:artifacts.adapter.path,defaultTimeoutMs:5000,...(nativeSession?{session:nativeSession}:{})})
 const approve=async(r:unknown)=>approvedNativeScopedClick(scope,r)
 let done=false
 if(scope.mode==='deterministic_actuator'){
  for(const step of scope.steps!){
   const snapshot=await ad.snapshot(scope.app,{maxDepth:30})
   const nodes=[...indexRefs(snapshot.tree).values()].filter((n:any)=>n.role===step.action.role&&n.name===step.action.name) as any[]
   phase='target'
   if(nodes.length!==1)throw Error('native_target_ambiguous')
   const action={command:'click',ref:nodes[0].ref_id}
   const plan=buildActionArgv(action,snapshot,scope.app)
   if(!plan.ok||plan.risk.level==='high'&&!await approve({app:scope.app,action,risk:plan.risk,targetRole:plan.node?.role,targetName:plan.node?.name}))throw Error('native_policy_denied')
   await ad.act(plan.argv);phase='verification'
   if(!(await verifyAll(ad,scope.app,step.expect)).passed)throw Error('native_step_unverified')
  }
  done=(await verifyAll(ad,scope.app,scope.success)).passed
 }else {
  const client=localClient!
  const authorizedClient={modelId:client.modelId,endpoint:client.endpoint,async complete(messages:any,opts:unknown){
   if(!await authorize())return null
   if(scope.mode==='supercomputer'){
    // Core history can contain native dialog titles. This data consent covers
    // only the explicit goal and current approved control labels, not history.
    if(!Array.isArray(messages)||messages.length!==2||messages[0]?.role!=='system'||messages[1]?.role!=='user'||typeof messages[1].content!=='string')return null
    const separator='\nObservation:\n',at=messages[1].content.lastIndexOf(separator)
    if(at<0)return null
    return client.complete([messages[0],{role:'user',content:'Goal: '+job.request.goal+separator+messages[1].content.slice(at+separator.length)}],opts)
   }
   return client.complete(messages,opts)
  }}
  const {renderObservation}=await load('observe.js')
  const model=createScopedComputerPlanner(authorizedClient,scope.actions,scope.mode==='supercomputer'?undefined:job.request.context,()=>modelCalls++,()=>{
   if(!latest)return null
   const rendered=renderObservation(latest),nodes=indexRefs(latest.tree)
   // Use the same checked renderer and snapshot as the core loop. Its menu
   // advisory changes presentation only; handles still resolve to fresh refs.
   const text=(latestSurface==='menu'?'(a menu is open; only its items are shown. press escape to close it)\n':'')+rendered.text
   const controls=[...rendered.handles].map(([handle,ref])=>{
    const node=nodes.get(ref)
    return {handle,role:node?.role??'',name:node?.name??''}
   })
   return {text,controls}
  },()=>actions)
  const result=await runTask(ad,model,{app:scope.app,goal:job.request.goal,maxSteps:job.maxSteps,success:scope.success},{approve})
  plannerStatus=model.decisionStatus
  done=result.outcome==='done'&&result.finalCheck?.passed===true&&actions>0
 }
 await ad.guard()
 return {outcome:done?'done':'unverified',independent_verified:done,native_actions:actions,model_calls:modelCalls,core_source:artifacts.coreSource,execution_mode:scope.mode,...(plannerStatus?{planner_status:plannerStatus}:{})}
 }finally{if(nativeSession)await bootstrap.exec(['session','end',nativeSession])}
}
