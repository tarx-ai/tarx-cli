/** Channel-owned computer execution. Pairing, native consent and verified outcome
 * are separate authorities. Raw goals/context never enter the durable ledger. */
import {createHash} from 'node:crypto'
import {createLocalJsonStore} from './local-json-store.ts'
import type {TaskIdentity} from './tarx-bounded-task.ts'

export const COMPUTER_TASK = 'computer_use' as const
export type ComputerRequest = {request_id:string;task:typeof COMPUTER_TASK;session_id:string;channel_id:string;agent_id:string;goal:string;context?:string}
export type ComputerSession = {
 session_id:string;subject_id:string;install_id:string;channel_id:string;agent_id:string
 intent_sha256:string;expires_at:number;max_steps:number;timeout_ms:number
}
export type ComputerOutcome = {
 outcome:'done'|'unverified'|'denied'|'error'|'cancelled';independent_verified:boolean
 native_actions:number|null;model_calls:number|null;core_source:string
 execution_mode:'local_model'|'supercomputer'|'deterministic_actuator'
 planner_status?:string
  failure_stage?:'preflight'|'scope'|'identity'|'observation'|'target'|'action'|'adapter'|'verification'|'worker'
  failure_code?:string
  /** Local diagnostics only. Never part of a receipt, grant or ledger proof. */
  diagnostics?:{
   control?:string;delivery?:string;mechanism?:string;verification?:string;focused?:boolean
   before?:{open:number;close:number};after?:{open:number;close:number}
  }
}
export type ComputerRun = {request:ComputerRequest;session:ComputerSession;signal:AbortSignal;stillAuthorized:()=>Promise<boolean>}
export type ComputerExecutor = {
 /** Trusted executor cleanup budget; never supplied by a browser request. */
 shutdownGraceMs?:number
 ready:()=>Promise<boolean>
 /** Fulfill only after owned execution and native cleanup are confirmed ended. */
 run:(input:ComputerRun)=>Promise<ComputerOutcome>
 /** Fresh observation after a crash. Must not repeat a delivered action. */
 observe?:(input:ComputerRun)=>Promise<ComputerOutcome>
}
export type ComputerSubmission = Omit<ComputerRequest,'session_id'> & {session_id?:string}
export type ComputerAuthority = {
 // Supplied only by the trusted native host after its explicit session approval.
 resolve:(sessionId:string)=>Promise<ComputerSession|null>
 /** Find the host grant for this channel, agent, and request. Never mints a session. */
 bind?:(request:ComputerSubmission)=>Promise<ComputerSession|null>
}
export type PrepareBrowserTask = (input: {
 identity:TaskIdentity; request:ComputerSubmission; paired:()=>Promise<boolean>; signal:AbortSignal
})=>Promise<{session:ComputerSession; release:(status?:Status)=>void}|null>
type Status='reserved'|'running'|'completed'|'failed'|'cancelling'|'cancelled'|'uncertain'
type ExecutionExitProof={kind:'computer_execution_exit';version:1;request_id:string;session_id:string;channel_id:string;agent_id:string;subject_id:string;install_id:string;intent_sha256:string;core_source:string}
type Record = {task:typeof COMPUTER_TASK;request_id:string;session_id:string;channel_id:string;agent_id:string;subject_id:string;install_id:string;intent_sha256:string;status:Status;execution_exit?:ExecutionExitProof;receipt?:{
 kind:'computer_use';session_id:string;channel_id:string;agent_id:string;independent_verified:true;native_actions:number;model_calls:number;core_source:string;execution_mode:ComputerOutcome['execution_mode'];billing_truth:'not_a_charge'
}}
type Reply={code:number;body:{error?:string;request_id?:string;session_id?:string;channel_id?:string;agent_id?:string;task?:typeof COMPUTER_TASK;status?:Status;receipt?:Record['receipt']|null}}
const opaque=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)
const agentId=(s:unknown)=>typeof s==='string'&&(s.includes(':')?/^channel-agent:[A-Za-z0-9-]{1,128}$/.test(s):opaque(s))
const sessionId=(s:unknown)=>typeof s==='string'&&/^wrun_[0-9A-Z]{20,32}$/.test(s)
const requestId=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(s)
const terminal=(s:Status)=>['completed','failed','cancelled'].includes(s)
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function parseComputerRequest(value:unknown):ComputerSubmission|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const r=value as {[key:string]:unknown}
 if(Object.keys(r).some(k=>!['request_id','task','session_id','channel_id','agent_id','goal','context'].includes(k))||
   r.task!==COMPUTER_TASK||!requestId(r.request_id)||!opaque(r.channel_id)||!agentId(r.agent_id)||
   typeof r.goal!=='string'||!r.goal.trim()||r.goal.length>2000||r.context!==undefined&&(typeof r.context!=='string'||r.context.length>4000)||
   r.session_id!=null&&!sessionId(r.session_id))return null
 const parsed:ComputerSubmission={request_id:r.request_id as string,task:COMPUTER_TASK,channel_id:r.channel_id as string,agent_id:r.agent_id as string,goal:r.goal as string}
 if(typeof r.context==='string')parsed.context=r.context
 if(typeof r.session_id==='string'&&sessionId(r.session_id))parsed.session_id=r.session_id
 return parsed
}
export function computerIntentHash(r:ComputerRequest) {return hash([r.request_id,r.session_id,r.channel_id,r.agent_id,r.goal,r.context??''])}
function validExecutionExitProof(value:unknown,r:Record,source:string):value is ExecutionExitProof {
 if(!value||typeof value!=='object'||Array.isArray(value))return false
 const proof=value as {[key:string]:unknown}
 return Object.keys(proof).sort().join(',')==='agent_id,channel_id,core_source,install_id,intent_sha256,kind,request_id,session_id,subject_id,version'&&
  proof.kind==='computer_execution_exit'&&proof.version===1&&proof.core_source===source&&
  ['request_id','session_id','channel_id','agent_id','subject_id','install_id','intent_sha256'].every(key=>proof[key]===r[key as keyof Record])
}
function validRecord(r:Record,source:string):boolean {
 if(!r||r.task!==COMPUTER_TASK||!requestId(r.request_id)||!sessionId(r.session_id)||!opaque(r.channel_id)||!agentId(r.agent_id)||
  typeof r.subject_id!=='string'||!/^tvs_[a-f0-9]{32}$/.test(r.subject_id)||!opaque(r.install_id)||!/^[a-f0-9]{64}$/.test(r.intent_sha256)||
  !['reserved','running','completed','failed','cancelling','cancelled','uncertain'].includes(r.status))return false
 if(r.execution_exit!==undefined&&!validExecutionExitProof(r.execution_exit,r,source))return false
 const receipt=r.receipt
 if(r.status!=='completed')return receipt===undefined
 return Boolean(receipt&&Object.keys(receipt).sort().join(',')==='agent_id,billing_truth,channel_id,core_source,execution_mode,independent_verified,kind,model_calls,native_actions,session_id'&&
  receipt.kind===COMPUTER_TASK&&receipt.session_id===r.session_id&&receipt.channel_id===r.channel_id&&receipt.agent_id===r.agent_id&&receipt.independent_verified===true&&
  receipt.core_source===source&&receipt.billing_truth==='not_a_charge'&&['local_model','supercomputer','deterministic_actuator'].includes(receipt.execution_mode)&&
  [receipt.model_calls,receipt.native_actions].every(n=>Number.isInteger(n)&&n>=0&&n<=50))
}

function validOutcome(r:ComputerOutcome,source:string) {
 return r&&['done','unverified','denied','error','cancelled'].includes(r.outcome)&&typeof r.independent_verified==='boolean'&&
  (r.planner_status===undefined||['idle','no_controls','requested','unavailable','invalid_json','invalid_action','false_done','blocked','act','done'].includes(r.planner_status))&&
  (r.failure_stage===undefined||['preflight','scope','identity','observation','target','action','adapter','verification','worker'].includes(r.failure_stage))&&
  (r.failure_code===undefined||typeof r.failure_code==='string'&&/^[A-Za-z_][A-Za-z0-9_]{1,63}$/.test(r.failure_code))&&
  ['local_model','supercomputer','deterministic_actuator'].includes(r.execution_mode)&&r.core_source===source&&
  [r.native_actions,r.model_calls].every(n=>n===null||Number.isInteger(n)&&n>=0&&n<=50)
}

async function bounded<T>(operation:()=>Promise<T>,ms:number):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([Promise.resolve().then(operation),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('computer_deadline')),ms)})])}
 finally{if(timer)clearTimeout(timer)}
}
async function abortable<T>(operation:()=>Promise<T>,signal:AbortSignal,graceMs=0):Promise<T> {
 let timer:ReturnType<typeof setTimeout>|undefined
 let onAbort=()=>{}
 try{return await Promise.race([Promise.resolve().then(()=>{if(signal.aborted)throw Error('computer_cancelled');return operation()}),new Promise<never>((_,reject)=>{
  onAbort=()=>{timer=setTimeout(()=>reject(Error('computer_cancelled')),graceMs)}
  if(signal.aborted)onAbort();else signal.addEventListener('abort',onAbort,{once:true})
 })])}finally{signal.removeEventListener('abort',onAbort);if(timer)clearTimeout(timer)}
}

export function createComputerTaskController(input:{file:string;authority:ComputerAuthority;executor:ComputerExecutor;coreSource:string;now?:()=>number;prepareBrowser?:PrepareBrowserTask}) {
 if(!/^[a-f0-9]{40}$/.test(input.coreSource))throw Error('invalid_core_source')
 const shutdownGraceMs=input.executor.shutdownGraceMs??1500
 if(!Number.isInteger(shutdownGraceMs)||shutdownGraceMs<0||shutdownGraceMs>6000)throw Error('invalid_computer_shutdown_budget')
 // Shares the existing private task ledger; no parallel database/collection.
 const store=createLocalJsonStore<Record>(input.file)
 const now=input.now??Date.now
 let closed=false
 const active=new Map<string,{abort:AbortController;finished:Promise<void>}>()
 type RequestBinding=Pick<ComputerSubmission,'request_id'|'channel_id'|'agent_id'>
 const preparing=new Map<string,{abort:AbortController; finished:Promise<Reply>; request:RequestBinding}>()
 let cancelledPreparation:{key:string;request:RequestBinding;until:number}|null=null
 const settling=new Set<string>()
 const key=(id:TaskIdentity,request:string)=>'computer:'+hash([id.subject_id,id.install_id,request])
 const safe=(r:Record)=>{if(!validRecord(r,input.coreSource))throw Error('invalid_computer_record');return {task:r.task,request_id:r.request_id,session_id:r.session_id,channel_id:r.channel_id,agent_id:r.agent_id,status:r.status,receipt:r.receipt??null}}
 async function bindRequest(parsed:ComputerSubmission):Promise<ComputerRequest|null> {
  if(parsed.session_id)return parsed as ComputerRequest
  if(!input.authority.bind)return null
  const bound=await bounded(()=>input.authority.bind!(parsed),1000).catch(()=>null)
  if(!bound||bound.channel_id!==parsed.channel_id||bound.agent_id!==parsed.agent_id||!sessionId(bound.session_id))return null
  const request:ComputerRequest={...parsed,session_id:bound.session_id}
  if(bound.intent_sha256!==computerIntentHash(request))return null
  return request
 }
 async function authorized(id:TaskIdentity,r:ComputerRequest,paired:()=>Promise<boolean>) {
  if(closed||!id.task_scopes.includes(COMPUTER_TASK)||!await bounded(paired,1000).catch(()=>false))return null
  const s=await bounded(()=>input.authority.resolve(r.session_id),1000).catch(()=>null)
  if(!s||s.session_id!==r.session_id||s.subject_id!==id.subject_id||s.install_id!==id.install_id||s.channel_id!==r.channel_id||s.agent_id!==r.agent_id||
    s.intent_sha256!==computerIntentHash(r)||!Number.isFinite(s.expires_at)||now()>=s.expires_at||
    !Number.isInteger(s.max_steps)||s.max_steps<1||s.max_steps>8||!Number.isInteger(s.timeout_ms)||s.timeout_ms<1||s.timeout_ms>45000)return null
  return s
 }
 async function transition(k:string,status:Status,receipt?:Record['receipt'],options:{signal?:AbortSignal;ownership?:'execution'|'observation'}={}) {
  return store.transact(all=>{
   const r=all[k];if(!r)throw Error('unknown_computer_task')
   if(!validRecord(r,input.coreSource))throw Error('invalid_computer_record')
   if(terminal(r.status))return {result:r}
   const {signal,ownership='execution'}=options
   const interruptedStatus=ownership==='execution'?'cancelled':'uncertain'
   // Losing cleanup confirmation cannot erase a previously persisted Stop.
   const interrupted=(signal?.aborted&&terminal(status))||(status==='completed'&&r.status==='cancelling')
   const missingExit=status==='completed'&&!validExecutionExitProof(r.execution_exit,r,input.coreSource)
   const proposed:Status=interrupted?interruptedStatus:missingExit?'uncertain':status
   const next:Status=r.status==='cancelling'
    ?proposed==='cancelled'?'cancelled':'cancelling'
    :proposed
   const saved=next==='completed'?receipt:undefined
   all[k]={...r,status:next,...(saved?{receipt:saved}:{})}
   if(next!=='completed')delete all[k].receipt
   return {result:all[k],write:true}
  })
 }
 async function persistExecutionExit(k:string,id:TaskIdentity,request:ComputerRequest) {
  await store.transact(all=>{
   const r=all[k]
   if(!r||!validRecord(r,input.coreSource)||r.subject_id!==id.subject_id||r.install_id!==id.install_id||
    r.request_id!==request.request_id||r.session_id!==request.session_id||r.channel_id!==request.channel_id||r.agent_id!==request.agent_id||r.intent_sha256!==computerIntentHash(request))throw Error('computer_execution_identity_changed')
   if(terminal(r.status))return {result:undefined}
   const proof:ExecutionExitProof={kind:'computer_execution_exit',version:1,request_id:r.request_id,session_id:r.session_id,
    channel_id:r.channel_id,agent_id:r.agent_id,subject_id:r.subject_id,install_id:r.install_id,intent_sha256:r.intent_sha256,core_source:input.coreSource}
   const next:Status=r.status==='cancelling'?'cancelled':r.status
   all[k]={...r,status:next,execution_exit:proof}
   if(next!=='completed')delete all[k].receipt
   return {result:undefined,write:true}
  })
 }
 async function stoppedExecutionReply(k:string,mode:'existing_stop'|'new_stop'):Promise<Reply> {
  const r=await store.transact(all=>{
   const current=all[k]
   if(!current||!validRecord(current,input.coreSource))throw Error('invalid_computer_record')
   if(!terminal(current.status)&&(current.status==='cancelling'||mode==='new_stop')&&validExecutionExitProof(current.execution_exit,current,input.coreSource)){
    all[k]={...current,status:'cancelled'};delete all[k].receipt
    return {result:all[k],write:true}
   }
   return {result:current}
  })
  return terminal(r.status)?{code:200,body:safe(r)}:{code:409,body:{...safe(r),error:'computer_outcome_uncertain'}}
 }
 function sameGrant(current:ComputerSession,session:ComputerSession) {
  return current.expires_at===session.expires_at&&current.max_steps===session.max_steps&&current.timeout_ms===session.timeout_ms
 }
 async function settle(k:string,request:ComputerRequest,outcome:ComputerOutcome,signal:AbortSignal,still:()=>Promise<boolean>,ownership:'execution'|'observation') {
  const interruptedStatus=ownership==='execution'?'cancelled':'uncertain'
  const authorized=await still()
  // An observer settling proves only its own cleanup, not the old execution's exit.
  if(signal.aborted||!authorized){await transition(k,interruptedStatus);return}
  if(!validOutcome(outcome,input.coreSource)){await transition(k,ownership==='observation'?'uncertain':'failed',undefined,{signal,ownership});return}
  if(outcome.outcome==='done'&&outcome.independent_verified&&(outcome.native_actions===null||outcome.model_calls===null)){await transition(k,'uncertain');return}
  if(outcome.outcome==='done'&&outcome.independent_verified&&outcome.native_actions!==null&&outcome.model_calls!==null) {
   await transition(k,'completed',{kind:'computer_use',session_id:request.session_id,channel_id:request.channel_id,agent_id:request.agent_id,
    independent_verified:true,native_actions:outcome.native_actions,model_calls:outcome.model_calls,core_source:outcome.core_source,execution_mode:outcome.execution_mode,billing_truth:'not_a_charge'},{signal,ownership})
  } else await transition(k,ownership==='observation'?'uncertain':outcome.outcome==='cancelled'?'cancelled':'failed',undefined,{signal,ownership})
 }
 async function execute(k:string,id:TaskIdentity,request:ComputerRequest,session:ComputerSession,paired:()=>Promise<boolean>,abort:AbortController) {
  let checking=false
  const stillAuthorized=async()=>{
   if(abort.signal.aborted)return false
   const current=await authorized(id,request,paired)
   return Boolean(current&&sameGrant(current,session))
  }
  const watch=setInterval(()=>{
   if(checking||abort.signal.aborted)return
   checking=true
   void stillAuthorized().then(ok=>{if(!ok)abort.abort()},()=>abort.abort()).finally(()=>{checking=false})
  },250)
  const deadline=setTimeout(()=>abort.abort(),Math.min(session.timeout_ms,Math.max(1,session.expires_at-now())))
  let dispatched=false
  try {
   if(!await abortable(stillAuthorized,abort.signal)) {await transition(k,'cancelled');return}
   await transition(k,'running')
   if(abort.signal.aborted) {await transition(k,'cancelled');return}
   const outcome=await abortable(async()=>{
    dispatched=true
    const value=await input.executor.run({request,session,signal:abort.signal,stillAuthorized})
    // Retain this continuation after grace expiry; a late owned exit is evidence,
    // while a rejected run or an observer can never manufacture this proof.
    await persistExecutionExit(k,id,request)
    return value
   },abort.signal,shutdownGraceMs)
   await settle(k,request,outcome,abort.signal,stillAuthorized,'execution')
  } catch {
   settling.add(k)
   try{await transition(k,dispatched?'uncertain':abort.signal.aborted?'cancelled':'failed').catch(()=>{})}
   finally{settling.delete(k)}
  } finally {clearTimeout(deadline);clearInterval(watch);active.delete(k)}
 }
 async function recover(k:string,id:TaskIdentity,request:ComputerRequest,paired:()=>Promise<boolean>):Promise<Reply> {
  if(active.has(k)||settling.has(k)){const r=await store.get(k);return {code:200,body:safe(r!)}}
  const abort=new AbortController()
  let release=()=>{}
  const finished=new Promise<void>(resolve=>{release=resolve})
  active.set(k,{abort,finished})
  try {
   const current=await store.get(k)
   if(!current)return {code:404,body:{error:'unknown_computer_task'}}
   if(!validRecord(current,input.coreSource))throw Error('invalid_computer_record')
   if(terminal(current.status))return {code:200,body:safe(current)}
   // A durable Stop request does not prove that a previous owner's worker exited.
   // Preserve its intent and installation lease until owned cleanup is confirmed.
   if(current.status==='cancelling')return stoppedExecutionReply(k,'existing_stop')
   const session=await authorized(id,request,paired)
   if(!session){await transition(k,'uncertain');const r=await store.get(k);return {code:403,body:{...safe(r!),error:'computer_session_approval_required'}}}
   if(!input.executor.observe)return {code:200,body:safe(current)}
   const still=async()=>{
    if(abort.signal.aborted)return false
    const live=await authorized(id,request,paired)
    return Boolean(live&&sameGrant(live,session))
   }
   let checking=false
   const watch=setInterval(()=>{
    if(checking||abort.signal.aborted)return
    checking=true
    void still().then(ok=>{if(!ok)abort.abort()},()=>abort.abort()).finally(()=>{checking=false})
   },250)
   const timer=setTimeout(()=>abort.abort(),Math.min(session.timeout_ms,Math.max(1,session.expires_at-now())))
   try {
    if(!await still())await transition(k,'uncertain')
    else {
     const outcome=await abortable(()=>input.executor.observe!({request,session,signal:abort.signal,stillAuthorized:still}),abort.signal,shutdownGraceMs)
     await settle(k,request,outcome,abort.signal,still,'observation')
    }
   // A read-only worker still owns native resources. If its bounded shutdown
   // cannot be confirmed, preserve uncertainty instead of acknowledging Stop.
   } catch {await transition(k,'uncertain').catch(()=>{})}
   finally {clearTimeout(timer);clearInterval(watch)}
   const r=await store.get(k)
   return {code:200,body:safe(r!)}
  } finally {active.delete(k);release()}
 }
 function cancelled(request:RequestBinding):Reply {
  return {code:200,body:{task:COMPUTER_TASK,request_id:request.request_id,channel_id:request.channel_id,agent_id:request.agent_id,status:'cancelled'}}
 }
 async function prepareSubmission(id:TaskIdentity,request:ComputerSubmission,paired:()=>Promise<boolean>,transport?:AbortSignal):Promise<Reply>{
  if(!input.prepareBrowser||closed||transport?.aborted)return {code:403,body:{error:'computer_session_approval_required'}}
  const k=key(id,request.request_id)
  if(cancelledPreparation?.key===k&&now()<cancelledPreparation.until)return cancelled(cancelledPreparation.request)
  if(preparing.size)return {code:409,body:{error:'computer_task_in_progress'}}
  const abort=new AbortController()
  const signal=AbortSignal.any([abort.signal,AbortSignal.timeout(65_000),...(transport?[transport]:[])])
  const binding={request_id:request.request_id,channel_id:request.channel_id,agent_id:request.agent_id}
  let submitted=false
  const stillPaired=async()=>(submitted||!signal.aborted)&&await paired()
  const finished=Promise.resolve().then(async():Promise<Reply>=>{
   let grant:Awaited<ReturnType<PrepareBrowserTask>>=null
   try{
    grant=await input.prepareBrowser!({identity:id,request,paired:stillPaired,signal})
    if(signal.aborted)return cancelled(request)
    if(!grant||!await stillPaired())return {code:403,body:{error:'computer_session_approval_required'}}
    // Once accepted, ordinary Stop controls the worker. A closed submit socket
    // during approval can never authorize work.
    const reply=await controller.submit(id,{...request,session_id:grant.session.session_id},stillPaired)
    submitted=reply.code===202
    const running=submitted?active.get(k):undefined
    if(running){
     const release=grant.release;grant=null
     void running.finished.then(()=>controller.read(id,request.request_id))
      .then(result=>release(result.body.status),()=>release()).catch(()=>{})
    }
    return reply
   }catch{
    return signal.aborted?cancelled(request):{code:403,body:{error:'computer_session_approval_required'}}
   }finally{
    if(signal.aborted)cancelledPreparation={key:k,request:binding,until:now()+60_000}
    try{grant?.release()}finally{preparing.delete(k)}
   }
  })
  preparing.set(k,{abort,finished,request:binding})
  return finished
 }
 const controller = {
  async available(){return !closed&&await bounded(()=>input.executor.ready(),1000).catch(()=>false)},
  async submit(id:TaskIdentity,body:unknown,paired:()=>Promise<boolean>,transport?:AbortSignal):Promise<Reply> {
   if(closed)return {code:503,body:{error:'computer_runtime_unavailable'}}
   const parsed=parseComputerRequest(body);if(!parsed)return {code:400,body:{error:'invalid_computer_task'}}
   if(!id.task_scopes.includes(COMPUTER_TASK)||!await bounded(paired,1000).catch(()=>false))return {code:403,body:{error:'computer_session_approval_required'}}
   if(!parsed.session_id&&input.prepareBrowser){
    const k=key(id,parsed.request_id),prior=await store.get(k)
    if(prior){
     if(!validRecord(prior,input.coreSource))throw Error('invalid_computer_record')
     if(prior.intent_sha256!==computerIntentHash({...parsed,session_id:prior.session_id}))return {code:409,body:{error:'request_conflict'}}
     if(['reserved','running'].includes(prior.status)&&!preparing.has(k)&&!active.has(k)&&!settling.has(k)){
      return {code:200,body:safe(await transition(k,'uncertain',undefined,{ownership:'observation'}))}
     }
     return {code:200,body:safe(prior)}
    }
   }
   const request=await bindRequest(parsed);if(!request)return prepareSubmission(id,parsed,paired,transport)
   const kExisting=key(id,request.request_id)
   const existing=await store.get(kExisting)
   if(existing){
    if(!validRecord(existing,input.coreSource))throw Error('invalid_computer_record')
    if(existing.intent_sha256!==computerIntentHash(request))return {code:409,body:{error:'request_conflict'}}
    if(terminal(existing.status)||active.has(kExisting)||settling.has(kExisting))return {code:200,body:safe(existing)}
    if(existing.status==='cancelling')return stoppedExecutionReply(kExisting,'existing_stop')
    return recover(kExisting,id,request,paired)
   }
   const session=await authorized(id,request,paired)
   if(!session)return {code:403,body:{error:'computer_session_approval_required'}}
   if(!await bounded(()=>input.executor.ready(),1000).catch(()=>false))return {code:503,body:{error:'computer_runtime_unavailable'}}
   const k=key(id,request.request_id),intent=computerIntentHash(request)
   const reservation=await store.transact<{kind:'new';record:Record}|{kind:'existing';record:Record}|{kind:'busy'}|{kind:'full'}>(all=>{
    if(Object.values(all).some(r=>r?.task===COMPUTER_TASK&&!validRecord(r,input.coreSource)))throw Error('invalid_computer_record')
    if(all[k])return {result:{kind:'existing' as const,record:all[k]}}
    if(Object.values(all).some(r=>r?.task===COMPUTER_TASK&&r.install_id===id.install_id&&!terminal(r.status)))return {result:{kind:'busy' as const}}
    if(Object.values(all).filter(r=>r?.task===COMPUTER_TASK).length>=512)return {result:{kind:'full' as const}}
    const record:Record={task:COMPUTER_TASK,request_id:request.request_id,session_id:request.session_id,channel_id:request.channel_id,agent_id:request.agent_id,
      subject_id:id.subject_id,install_id:id.install_id,intent_sha256:intent,status:'reserved'}
    all[k]=record;return {result:{kind:'new' as const,record},write:true}
   })
   if(reservation.kind==='busy')return {code:409,body:{error:'computer_task_in_progress'}}
   if(reservation.kind==='full')return {code:409,body:{error:'computer_task_history_full'}}
   if(reservation.kind==='existing')return reservation.record.intent_sha256===intent?{code:200,body:safe(reservation.record)}:{code:409,body:{error:'request_conflict'}}
   const abort=new AbortController()
   // Reserve the in-memory lease before the first asynchronous execution phase.
   const finished=Promise.resolve().then(()=>execute(k,id,request,session,paired,abort))
   active.set(k,{abort,finished})
   void finished.catch(()=>{})
   return {code:202,body:safe(reservation.record)}
  },
  async read(id:TaskIdentity,idValue:string):Promise<Reply> {
   if(!id.task_scopes.includes(COMPUTER_TASK))return {code:403,body:{error:'computer_scope_required'}}
   if(!requestId(idValue))return {code:400,body:{error:'invalid_computer_task'}}
   const r=await store.get(key(id,idValue));return r&&r.task===COMPUTER_TASK?{code:200,body:safe(r)}:{code:404,body:{error:'unknown_computer_task'}}
  },
  async cancel(id:TaskIdentity,idValue:string):Promise<Reply> {
   if(!id.task_scopes.includes(COMPUTER_TASK))return {code:403,body:{error:'computer_scope_required'}}
   if(!requestId(idValue))return {code:400,body:{error:'invalid_computer_task'}}
   const k=key(id,idValue),pending=preparing.get(k)
   if(pending){pending.abort.abort();await pending.finished}
   const r=await store.get(k)
   if(!r&&pending)return cancelled(pending.request)
   if(!r&&cancelledPreparation?.key===k&&now()<cancelledPreparation.until)return cancelled(cancelledPreparation.request)
   if(!r||r.task!==COMPUTER_TASK)return {code:404,body:{error:'unknown_computer_task'}}
   if(terminal(r.status))return {code:200,body:safe(r)}
   const owned=active.get(k)
   if(!owned)return stoppedExecutionReply(k,'new_stop')
   await transition(k,'cancelling');owned.abort.abort()
   return {code:202,body:{...safe(r),status:'cancelling'}}
  },
  async close() {
   closed=true
   for(const pending of preparing.values())pending.abort.abort()
   for(const owned of active.values())owned.abort.abort()
   await Promise.allSettled([...preparing.values()].map(pending=>pending.finished))
   await Promise.allSettled([...active.values()].map(owned=>owned.finished))
  },
 }
 return controller
}
