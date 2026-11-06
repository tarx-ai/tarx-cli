/** Owned subprocess only. No stdio diagnostics, stored context, screenshots or
 * ambient model/profile configuration. Parent enforces lifetime and authority. */
import {createHash} from 'node:crypto'
import {join} from 'node:path'
import {pathToFileURL} from 'node:url'
import {verifyComputerArtifacts,validateNativeScope,type ComputerArtifacts,type NativeScope} from './tarx-computer-executor.ts'
type Job={artifacts:ComputerArtifacts;scope:NativeScope;request:{goal:string;context?:string};maxSteps:number}
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
  process.send?.({kind:'failure',phase,code},()=>process.exit(1))
 })
})
process.on('disconnect',()=>process.exit(1))
async function run(job:Job) {
 const {artifacts,scope}=job
 await verifyComputerArtifacts(artifacts);validateNativeScope(scope,job.maxSteps)
 const load=(name:string)=>import(pathToFileURL(join(artifacts.coreDirectory,name)).href)
 const [{AgentDesktop},{indexRefs},{buildActionArgv},{verifyAll,runTask},{createLoopbackClient}]=await Promise.all(['adapter.js','refs.js','policy.js','loop.js','model.js'].map(load))
 phase='scope'
 let latest:any,actions=0,modelCalls=0
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
   if(['snapshot','find'].includes(argv[0])){await this.guard();phase='observation';return super.exec([...argv,'--window-id',scope.window.id],opts)}
   if(argv[0]==='list-surfaces'){await this.guard();return super.exec(argv,opts)}
   throw Error('native_command_out_of_scope')
  }
  async snapshot(app:string,opts:unknown={}) {if(app!==scope.app)throw Error('native_app_out_of_scope');latest=await super.snapshot(app,opts);return latest}
  async act(argv:string[]) {
   const node=latest&&indexRefs(latest.tree).get(argv[1])
   if(argv.length!==2||argv[0]!=='click'||!node||!scope.actions.some(a=>a.command===argv[0]&&a.role===node.role&&a.name===node.name)||actions>=job.maxSteps)throw Error('native_action_out_of_scope')
   await this.guard();latest=undefined;phase='action'
   const result=await super.exec(argv,{timeoutMs:5000});actions++;return result.data
  }
 }
 const ad=new ScopedDesktop({bin:artifacts.adapter.path,defaultTimeoutMs:5000})
 const approve=async(r:any)=>r.app===scope.app&&r.action.command==='click'&&r.risk.category==='settings'&&scope.actions.some(a=>a.command===r.action.command&&a.role===r.targetRole&&a.name===r.targetName)
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
  const client=createLoopbackClient({...scope.model,timeoutMs:10000})
  const model={modelId:client.modelId,endpoint:client.endpoint,async complete(messages:unknown,opts:unknown){if(!await authorize())return null;modelCalls++;return client.complete(messages,opts)}}
  const result=await runTask(ad,model,{app:scope.app,goal:job.request.goal,maxSteps:job.maxSteps,success:scope.success,hints:job.request.context},{approve})
  done=result.outcome==='done'&&result.finalCheck?.passed===true
 }
 await ad.guard()
 return {outcome:done?'done':'unverified',independent_verified:done,native_actions:actions,model_calls:modelCalls,core_source:artifacts.coreSource,execution_mode:scope.mode}
}
