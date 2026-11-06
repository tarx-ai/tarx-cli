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
 execution_mode:'local_model'|'deterministic_actuator'
}
export type ComputerExecutor = {
 ready:()=>Promise<boolean>
 run:(input:{request:ComputerRequest;session:ComputerSession;signal:AbortSignal;stillAuthorized:()=>Promise<boolean>})=>Promise<ComputerOutcome>
}
export type ComputerAuthority = {
 // Supplied only by the trusted native host after its explicit session approval.
 resolve:(sessionId:string)=>Promise<ComputerSession|null>
}
type Status='reserved'|'running'|'completed'|'failed'|'cancelling'|'cancelled'|'uncertain'
type Record = {task:typeof COMPUTER_TASK;request_id:string;session_id:string;channel_id:string;agent_id:string;subject_id:string;install_id:string;intent_sha256:string;status:Status;receipt?:{
 kind:'computer_use';session_id:string;channel_id:string;agent_id:string;independent_verified:true;native_actions:number;model_calls:number;core_source:string;execution_mode:ComputerOutcome['execution_mode'];billing_truth:'not_a_charge'
}}
type Reply={code:number;body:{error?:string;request_id?:string;session_id?:string;channel_id?:string;agent_id?:string;task?:typeof COMPUTER_TASK;status?:Status;receipt?:Record['receipt']|null}}
const opaque=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)
const sessionId=(s:unknown)=>typeof s==='string'&&/^wrun_[0-9A-Z]{20,32}$/.test(s)
const requestId=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9_-]{8,80}$/.test(s)
const terminal=(s:Status)=>['completed','failed','cancelled'].includes(s)
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex')
export function parseComputerRequest(value:unknown):ComputerRequest|null {
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const r=value as ComputerRequest
 if(Object.keys(r).some(k=>!['request_id','task','session_id','channel_id','agent_id','goal','context'].includes(k))||
   r.task!==COMPUTER_TASK||!requestId(r.request_id)||!sessionId(r.session_id)||!opaque(r.channel_id)||!opaque(r.agent_id)||
   typeof r.goal!=='string'||!r.goal.trim()||r.goal.length>2000||r.context!==undefined&&(typeof r.context!=='string'||r.context.length>4000))return null
 return {...r}
}
export function computerIntentHash(r:ComputerRequest) {return hash([r.request_id,r.session_id,r.channel_id,r.agent_id,r.goal,r.context??''])}
function validRecord(r:Record,source:string):boolean {
 if(!r||r.task!==COMPUTER_TASK||!requestId(r.request_id)||!sessionId(r.session_id)||!opaque(r.channel_id)||!opaque(r.agent_id)||
  typeof r.subject_id!=='string'||!/^tvs_[a-f0-9]{32}$/.test(r.subject_id)||!opaque(r.install_id)||!/^[a-f0-9]{64}$/.test(r.intent_sha256)||
  !['reserved','running','completed','failed','cancelling','cancelled','uncertain'].includes(r.status))return false
 const receipt=r.receipt
 if(r.status!=='completed')return receipt===undefined
 return Boolean(receipt&&Object.keys(receipt).sort().join(',')==='agent_id,billing_truth,channel_id,core_source,execution_mode,independent_verified,kind,model_calls,native_actions,session_id'&&
  receipt.kind===COMPUTER_TASK&&receipt.session_id===r.session_id&&receipt.channel_id===r.channel_id&&receipt.agent_id===r.agent_id&&receipt.independent_verified===true&&
  receipt.core_source===source&&receipt.billing_truth==='not_a_charge'&&['local_model','deterministic_actuator'].includes(receipt.execution_mode)&&
  [receipt.model_calls,receipt.native_actions].every(n=>Number.isInteger(n)&&n>=0&&n<=50))
}

function validOutcome(r:ComputerOutcome,source:string) {
 return r&&['done','unverified','denied','error','cancelled'].includes(r.outcome)&&typeof r.independent_verified==='boolean'&&
  ['local_model','deterministic_actuator'].includes(r.execution_mode)&&r.core_source===source&&
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

export function createComputerTaskController(input:{file:string;authority:ComputerAuthority;executor:ComputerExecutor;coreSource:string;now?:()=>number}) {
 if(!/^[a-f0-9]{40}$/.test(input.coreSource))throw Error('invalid_core_source')
 // Shares the existing private task ledger; no parallel database/collection.
 const store=createLocalJsonStore<Record>(input.file)
 const now=input.now??Date.now
 let closed=false
 const active=new Map<string,{abort:AbortController;finished:Promise<void>}>
 const key=(id:TaskIdentity,request:string)=>'computer:'+hash([id.subject_id,id.install_id,request])
 const safe=(r:Record)=>{if(!validRecord(r,input.coreSource))throw Error('invalid_computer_record');return {task:r.task,request_id:r.request_id,session_id:r.session_id,channel_id:r.channel_id,agent_id:r.agent_id,status:r.status,receipt:r.receipt??null}}
 async function authorized(id:TaskIdentity,r:ComputerRequest,paired:()=>Promise<boolean>) {
  if(closed||!id.task_scopes.includes(COMPUTER_TASK)||!await bounded(paired,1000).catch(()=>false))return null
  const s=await bounded(()=>input.authority.resolve(r.session_id),1000).catch(()=>null)
  if(!s||s.session_id!==r.session_id||s.subject_id!==id.subject_id||s.install_id!==id.install_id||s.channel_id!==r.channel_id||s.agent_id!==r.agent_id||
    s.intent_sha256!==computerIntentHash(r)||!Number.isFinite(s.expires_at)||now()>=s.expires_at||
    !Number.isInteger(s.max_steps)||s.max_steps<1||s.max_steps>8||!Number.isInteger(s.timeout_ms)||s.timeout_ms<1||s.timeout_ms>45000)return null
  return s
 }
 async function transition(k:string,status:Status,receipt?:Record['receipt']) {
  return store.transact(all=>{
   const r=all[k];if(!r)throw Error('unknown_computer_task')
   if(terminal(r.status))return {result:r}
   all[k]={...r,status,...(receipt?{receipt}:{})};return {result:all[k],write:true}
  })
 }
 async function execute(k:string,id:TaskIdentity,request:ComputerRequest,session:ComputerSession,paired:()=>Promise<boolean>,abort:AbortController) {
  let checking=false
  const stillAuthorized=async()=>{
   if(abort.signal.aborted)return false
   const current=await authorized(id,request,paired)
   return Boolean(current&&current.expires_at===session.expires_at&&current.max_steps===session.max_steps&&current.timeout_ms===session.timeout_ms)
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
   dispatched=true
   const outcome=await abortable(()=>input.executor.run({request,session,signal:abort.signal,stillAuthorized}),abort.signal,1500)
   if(abort.signal.aborted||!await stillAuthorized()) {await transition(k,'cancelled');return}
   if(!validOutcome(outcome,input.coreSource)) {await transition(k,'failed');return}
   if(outcome.outcome==='done'&&outcome.independent_verified&&outcome.native_actions!==null&&outcome.model_calls!==null) {
    await transition(k,'completed',{kind:'computer_use',session_id:request.session_id,channel_id:request.channel_id,agent_id:request.agent_id,
      independent_verified:true,native_actions:outcome.native_actions,model_calls:outcome.model_calls,core_source:outcome.core_source,execution_mode:outcome.execution_mode,billing_truth:'not_a_charge'})
   } else await transition(k,outcome.outcome==='cancelled'?'cancelled':'failed')
  } catch {await transition(k,dispatched?'uncertain':abort.signal.aborted?'cancelled':'failed').catch(()=>{})}
  finally {clearTimeout(deadline);clearInterval(watch);active.delete(k)}
 }
 return {
  async available(){return !closed&&await bounded(()=>input.executor.ready(),1000).catch(()=>false)},
  async submit(id:TaskIdentity,body:unknown,paired:()=>Promise<boolean>):Promise<Reply> {
   if(closed)return {code:503,body:{error:'computer_runtime_unavailable'}}
   const request=parseComputerRequest(body);if(!request)return {code:400,body:{error:'invalid_computer_task'}}
   if(!id.task_scopes.includes(COMPUTER_TASK)||!await bounded(paired,1000).catch(()=>false))return {code:403,body:{error:'computer_session_approval_required'}}
   const existing=await store.get(key(id,request.request_id))
   if(existing)return existing.intent_sha256===computerIntentHash(request)?{code:200,body:safe(existing)}:{code:409,body:{error:'request_conflict'}}
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
   const k=key(id,idValue),r=await store.get(k)
   if(!r||r.task!==COMPUTER_TASK)return {code:404,body:{error:'unknown_computer_task'}}
   if(terminal(r.status))return {code:200,body:safe(r)}
   const owned=active.get(k)
   if(!owned)return {code:409,body:{...safe(r),error:'computer_outcome_uncertain'}}
   await transition(k,'cancelling');owned.abort.abort()
   return {code:202,body:{...safe(r),status:'cancelling'}}
  },
  async close() {
   closed=true
   for(const owned of active.values())owned.abort.abort()
   await Promise.allSettled([...active.values()].map(owned=>owned.finished))
  },
 }
}
