import {createHash} from 'node:crypto'
import {createLocalJsonStore} from './local-json-store.ts'
import type {OwnerStore} from './tarx-eve-listener.ts'

export const TASK_NAME='read_launch_note'
export const PUBLIC_NOTE='TARX local tool check.\n'
export const TASK_MESSAGE='Use read_launch_note exactly once to read the scoped public fixture. Return its single sentence. Do not use any other tool.'
export type TaskIdentity={subject_id:string;install_id:string;task_scopes:string[]}
export type Status='reserved'|'prepared'|'dispatching'|'running'|'completed'|'failed'|'uncertain'
type TaskRecord={request_id:string;task:typeof TASK_NAME;subject_id:string;install_id:string;status:Status;session_id?:string;receipt?:{kind:'local_eve_tool';tool:typeof TASK_NAME;session_id:string;status:'completed';result:string;billing_truth:'not_a_charge'}}
/** Only trusted, separately accepted runtime wiring may provide this executor.
 * The caller must enforce a dedicated public-fixture profile with no other
 * tools, delegation or private context. The public entrypoint supplies none. */
export type ScopedExecutor={profile:typeof TASK_NAME;prepare:()=>Promise<string>;start:(sessionId:string,message:string)=>Promise<void>;events:(sessionId:string)=>AsyncIterable<any>}
type TaskResponse={code:number;body:{error?:string;request_id?:string;task?:typeof TASK_NAME;status?:Status;session_id?:string|null;receipt?:TaskRecord['receipt']|null}}
type Reservation={kind:'new'|'existing';record:TaskRecord}|{kind:'busy'}
const validRequest=(value:string)=>/^[a-zA-Z0-9_-]{8,80}$/.test(value)
const sessionPattern=/^wrun_[0-9A-Z]{20,32}$/
const terminal=(status:Status)=>status==='completed'||status==='failed'

export function createBoundedTaskController(input:{file:string;owners:OwnerStore;executor:ScopedExecutor}){
 const store=createLocalJsonStore<TaskRecord>(input.file)
 const key=(id:TaskIdentity,request:string)=>createHash('sha256').update(JSON.stringify([id.subject_id,id.install_id,request])).digest('hex')
 function safe(record:TaskRecord){return {request_id:record.request_id,task:record.task,status:record.status,session_id:record.session_id??null,receipt:record.receipt??null}}
 async function transition(k:string,change:Partial<TaskRecord>){
  return store.transact(all=>{const rec=all[k];if(!rec)throw Error('unknown_task');if(terminal(rec.status))return {result:rec};all[k]={...rec,...change};return {result:all[k],write:true}})
 }
 async function refresh(k:string){
  const rec=await store.get(k);if(!rec||!rec.session_id||terminal(rec.status))return rec
  let completed=false,failed=false,resultCount=0,validResult=false
  for await(const event of input.executor.events(rec.session_id)){
   if(event.type==='turn.failed'||event.type==='turn.cancelled')failed=true
   if(event.type==='turn.completed')completed=true
   if(event.type==='action.result'){
    resultCount++
    const result=event.data?.result,output=result?.output
    validResult=event.data?.status==='completed'&&result?.kind==='tool-result'&&result?.toolName===TASK_NAME&&output?.source==='fixture'&&output?.privateContext===false&&output?.text===PUBLIC_NOTE
    if(!validResult)failed=true
   }
  }
  if(failed||completed&&(!validResult||resultCount!==1))return transition(k,{status:'failed'})
  if(completed)return transition(k,{status:'completed',receipt:{kind:'local_eve_tool',tool:TASK_NAME,session_id:rec.session_id,status:'completed',result:PUBLIC_NOTE,billing_truth:'not_a_charge'}})
  return rec
 }
 return {
  async submit(identity:TaskIdentity,body:any):Promise<TaskResponse>{
   if(!identity.task_scopes.includes(TASK_NAME))return {code:403,body:{error:'task_approval_required'}}
   if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['request_id','task'].includes(k))||body.task!==TASK_NAME||typeof body.request_id!=='string'||!validRequest(body.request_id))return {code:400,body:{error:'invalid_task'}}
   if(input.executor.profile!==TASK_NAME)return {code:503,body:{error:'trusted_profile_required'}}
   const k=key(identity,body.request_id)
   const reservation=await store.transact<Reservation>(all=>{
    if(all[k])return {result:{kind:'existing',record:all[k]}}
    const active=Object.values(all).some(r=>r.subject_id===identity.subject_id&&r.install_id===identity.install_id&&!terminal(r.status))
    if(active)return {result:{kind:'busy'}}
    const record:TaskRecord={request_id:body.request_id,task:TASK_NAME,subject_id:identity.subject_id,install_id:identity.install_id,status:'reserved'}
    all[k]=record;return {result:{kind:'new',record},write:true}
   })
   if(reservation.kind==='busy')return {code:409,body:{error:'task_in_progress'}}
   if(reservation.kind==='existing')return {code:200,body:safe(reservation.record)}
   try{
    const session_id=await input.executor.prepare()
    if(!sessionPattern.test(session_id))throw Error('invalid_session')
    await input.owners.put({session_id,subject_id:identity.subject_id,install_id:identity.install_id,cursor:0})
    await transition(k,{status:'prepared',session_id})
    // Record intent before crossing the execution boundary. Uncertain work is
    // never automatically dispatched again after a crash or lost response.
    await transition(k,{status:'dispatching'})
    await input.executor.start(session_id,TASK_MESSAGE)
    const rec=await transition(k,{status:'running'})
    return {code:202,body:safe(rec)}
   }catch{
    const rec=await transition(k,{status:'uncertain'});return {code:502,body:{...safe(rec),error:'task_outcome_uncertain'}}
   }
  },
  async read(identity:TaskIdentity,requestId:string):Promise<TaskResponse>{
   if(!validRequest(requestId))return {code:400,body:{error:'invalid_task'}}
   const k=key(identity,requestId)
   try{const record=await refresh(k);return record?{code:200,body:safe(record)}:{code:404,body:{error:'unknown_task'}}}
   catch{return {code:502,body:{error:'task_read_unavailable'}}}
  },
 }
}

/** SDK adapter, intentionally NOT registered by the public entrypoint yet.
 * A trusted local profile verifier must attest the exact fixture tool, no
 * private instructions/context, no default tools and no delegation. A browser
 * flag or a tool name alone is not such evidence. */
export function createEveReadNoteExecutor(client:{sessions:{create:()=>Promise<{session:{state:{sessionId:string}}}>;attach:(id:string)=>{send:(message:string,options:{turnPolicy:'queue'})=>Promise<{result:()=>Promise<unknown>}>;stream:(options:{follow:false})=>AsyncIterable<any>}}},verifyProfile:()=>Promise<boolean>):ScopedExecutor{
 async function verify(){if(!await verifyProfile())throw Error('trusted_profile_required')}
 return {
  profile:TASK_NAME,
  async prepare(){await verify();return (await client.sessions.create()).session.state.sessionId},
  async start(id,message){await verify();if(message!==TASK_MESSAGE)throw Error('invalid_task_message');const response=await client.sessions.attach(id).send(message,{turnPolicy:'queue'});void response.result().catch(()=>{/* outcome is read from durable events, never invented here */})},
  async *events(id){yield*client.sessions.attach(id).stream({follow:false})},
 }
}
