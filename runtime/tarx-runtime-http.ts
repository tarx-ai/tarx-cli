/** Paired runtime routes. Scope approval stays on the trusted CLI.
 * Private inference is opt-in and never falls back to hosted compute. */
import {createSessionListener,type ListenerDeps} from './tarx-eve-listener.ts'
import type {createBoundedTaskController} from './tarx-bounded-task.ts'
import {claimPairing,pairingIdentityResolver,pairingTaskAccess,type PairStore} from './tarx-browser-pairing.ts'
import {validatePersonalTurn,runPersonalTurn,type PersonalClient} from './tarx-personal-turn.ts'
import {createLearningController,ownerNamespace,type AdapterResolution} from './tarx-local-learning.ts'
import {deliverOwnedPersonalContext} from './tarx-context-consumer.ts'
import type {PersonalContextResolver} from './tarx-context-runtime.ts'
import {buildCapabilityManifest,READ_LAUNCH_NOTE_CAPABILITY,COGNITIVE_ADAPTER_UNKNOWN} from './tarx-capability-manifest.ts'
export function createPairedSessionListener(deps:Omit<ListenerDeps,'resolveIdentity'|'handleRequest'> & {pairStore:PairStore;tasks?:ReturnType<typeof createBoundedTaskController>;taskDiscovery?:()=>Promise<string[]>;personalClient?:PersonalClient;personalContext?:PersonalContextResolver;learning?:ReturnType<typeof createLearningController>}){
 return createSessionListener({...deps,resolveIdentity:pairingIdentityResolver(deps.pairStore),handleRequest:async(req,res,path)=>{
  const reply=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));return true}
  if(path==='/personal-learning'){
   // Owner-isolated local training. Namespace derived server-side from pairing.
   const origin=typeof req.headers.origin==='string'?req.headers.origin:''
   if(!deps.allowedOrigins.has(origin))return reply(403,{error:'untrusted_origin'})
   const identity=await pairingTaskAccess(req,deps.pairStore);if(!identity)return reply(401,{error:'missing_identity'})
   if(req.method!=='POST')return reply(405,{error:'method_not_allowed'})
   if(!deps.learning)return reply(503,{error:'not_configured'})
   if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']??'')))return reply(415,{error:'json_required'})
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>262144)return reply(413,{error:'body_too_large'})}
   let body:any;try{body=JSON.parse(raw)}catch{return reply(400,{error:'invalid_json'})}
   const ns=ownerNamespace(identity.subject_id,identity.install_id)
   const result=await deps.learning.handle(ns,identity.task_scopes,body,{stillAuthorized:async()=>Boolean(await pairingTaskAccess(req,deps.pairStore))})
   return reply(result.code,result.body)
  }
  if(path==='/personal-turn'){
   // Paired browser -> owned local personal model. Private; never hosted/remote.
   const origin=typeof req.headers.origin==='string'?req.headers.origin:''
   if(!deps.allowedOrigins.has(origin))return reply(403,{error:'untrusted_origin'})
   const identity=await pairingTaskAccess(req,deps.pairStore);if(!identity)return reply(401,{error:'missing_identity'})
   if(req.method!=='POST')return reply(405,{error:'method_not_allowed'})
   if(!identity.task_scopes.includes('personal_chat'))return reply(403,{error:'personal_scope_required'})
   if(!deps.personalClient)return reply(503,{error:'personal_runtime_unavailable'})
   if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']??'')))return reply(415,{error:'json_required'})
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>32768)return reply(413,{error:'body_too_large'})}
   let body:any;try{body=JSON.parse(raw)}catch{return reply(400,{error:'invalid_json'})}
   const valid=validatePersonalTurn(body);if(!valid.ok)return reply(400,{error:'invalid_turn'})
   let local:{adapters:string;model:string}|undefined
   if(deps.learning){
    const resolved:AdapterResolution=await deps.learning.resolveAdapter(ownerNamespace(identity.subject_id,identity.install_id))
    if(resolved.kind==='closed')return reply(503,{error:'personal_runtime_unavailable'})
    if(resolved.kind==='adapter')local={adapters:resolved.path,model:resolved.model}
   }
   let context:Awaited<ReturnType<PersonalContextResolver>>=null
   if(deps.personalContext&&identity.task_scopes.includes('personal_context')){
    let timer:ReturnType<typeof setTimeout>|undefined
    try{
     const modelIdentity=local?JSON.stringify([local.model,local.adapters]):deps.personalClient.contextModelId??''
     context=await Promise.race([deps.personalContext(ownerNamespace(identity.subject_id,identity.install_id),modelIdentity),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(Error('context_timeout')),1000)})])
    }catch{return reply(503,{error:'personal_context_unavailable'})}
    finally{if(timer)clearTimeout(timer)}
    const current=await pairingTaskAccess(req,deps.pairStore)
    if(!current||!current.task_scopes.includes('personal_context'))return reply(401,{error:'missing_identity'})
   }
   const result=context
    ?await deliverOwnedPersonalContext({client:(messages)=>deps.personalClient!(messages,local),messages:valid.messages,resolution:context})
    :await runPersonalTurn(deps.personalClient,{messages:valid.messages},local)
   if(!result.ok)return reply(result.error==='personal_runtime_unavailable'?503:502,{error:result.error})
   if(!await pairingTaskAccess(req,deps.pairStore))return reply(401,{error:'missing_identity'})
   return reply(200,{role:'assistant',content:result.content})
  }
  if(path==='/task-capabilities'){
   if(req.method!=='GET')return reply(405,{error:'method_not_allowed'})
   if(!deps.allowedOrigins.has(String(req.headers.origin??'')))return reply(403,{error:'untrusted_origin'})
   const identity=await pairingTaskAccess(req,deps.pairStore);if(!identity)return reply(401,{error:'missing_identity'})
   let discovered:string[]=[];try{discovered=deps.tasks&&deps.taskDiscovery?await deps.taskDiscovery():[]}catch{return reply(503,{error:'task_discovery_unavailable'})}
   const available=discovered.filter(name=>name==='read_launch_note')
   return reply(200,{available_tasks:available,permitted_tasks:available.filter(name=>identity.task_scopes.includes(name))})
  }
  if(path==='/capability-manifest'){
   // Bounded, versioned, read-only capability metadata for channel/web
   // consumers. Same auth/origin/pairing gate as the other authorized routes;
   // only already-authorized metadata is exposed. No secrets/paths/private
   // context. Built from REAL discovery + granted scopes + the injected
   // readiness probe; an unreachable runtime yields `unavailable`, and the
   // cognitive adapter stays `unknown` (never probed here).
   if(req.method!=='GET')return reply(405,{error:'method_not_allowed'})
   if(!deps.allowedOrigins.has(String(req.headers.origin??'')))return reply(403,{error:'untrusted_origin'})
   const identity=await pairingTaskAccess(req,deps.pairStore);if(!identity)return reply(401,{error:'missing_identity'})
   // Discovery is the capability authority; a discovery failure is reported as
   // an unreachable runtime, not an empty success.
   let discovered:string[]
   try{discovered=deps.tasks&&deps.taskDiscovery?await deps.taskDiscovery():[]}catch{return reply(503,{error:'capability_discovery_unavailable'})}
   // Readiness is a real probe; its failure => runtime treated as unreachable
   // (nothing inferred healthy from an open port).
   let readiness
   try{readiness=await deps.readiness()}catch{readiness={config_valid:false,worker_reachable:false,model_responsive:false,tools:[] as string[],healthy:false}}
   const manifest=buildCapabilityManifest({
    discovered_tools:discovered,
    granted_scopes:identity.task_scopes,
    readiness:{config_valid:readiness.config_valid,worker_reachable:readiness.worker_reachable,model_responsive:readiness.model_responsive,healthy:readiness.healthy},
    declared:[READ_LAUNCH_NOTE_CAPABILITY],
    declared_unknown_adapters:[COGNITIVE_ADAPTER_UNKNOWN],
   })
   return reply(200,manifest)
  }
  if(path==='/tasks'||path.startsWith('/tasks/')){
   const origin=typeof req.headers.origin==='string'?req.headers.origin:''
   if(!deps.allowedOrigins.has(origin))return reply(403,{error:'untrusted_origin'})
   const identity=await pairingTaskAccess(req,deps.pairStore)
   if(!identity)return reply(401,{error:'missing_identity'})
   if(!deps.tasks)return reply(503,{error:'task_executor_unavailable'})
   if(req.method==='GET'&&path.startsWith('/tasks/')){const result=await deps.tasks.read(identity,path.slice('/tasks/'.length));return reply(result.code,result.body)}
   if(req.method!=='POST'||path!=='/tasks')return reply(405,{error:'method_not_allowed'})
   if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']??'')))return reply(415,{error:'json_required'})
   let raw='';for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2048)return reply(413,{error:'body_too_large'})}
   let body:any;try{body=JSON.parse(raw)}catch{return reply(400,{error:'invalid_json'})}
   const result=await deps.tasks.submit(identity,body);return reply(result.code,result.body)
  }
  if(path!=='/pairing/claim')return false
  if(req.method!=='POST')return reply(405,{error:'method_not_allowed'})
  const origin=typeof req.headers.origin==='string'?req.headers.origin:''
  if(!deps.allowedOrigins.has(origin))return reply(403,{error:'untrusted_origin'})
  if(!/^application\/json(?:;|$)/i.test(String(req.headers['content-type']??'')))return reply(415,{error:'json_required'})
  let raw=''
  for await(const chunk of req){raw+=chunk;if(Buffer.byteLength(raw)>2048)return reply(413,{error:'body_too_large'})}
  let body:any
  try{body=JSON.parse(raw)}catch{return reply(400,{error:'invalid_json'})}
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>k!=='challenge')||typeof body.challenge!=='string'||!/^[0-9a-f]{64}$/.test(body.challenge))return reply(400,{error:'invalid_request'})
  const result=await claimPairing({challenge:body.challenge,origin,allowedOrigins:deps.allowedOrigins,store:deps.pairStore})
  return reply(result.ok?200:403,result)
 }})
}
