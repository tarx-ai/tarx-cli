/** Paired runtime routes. Scope approval stays on the trusted CLI.
 * Private inference is opt-in and never falls back to hosted compute. */
import {createSessionListener,type ListenerDeps} from './tarx-eve-listener.ts'
import type {createBoundedTaskController} from './tarx-bounded-task.ts'
import {claimPairing,pairingIdentityResolver,pairingTaskAccess,type PairStore} from './tarx-browser-pairing.ts'
import {validatePersonalTurn,runPersonalTurn,type PersonalClient} from './tarx-personal-turn.ts'
export function createPairedSessionListener(deps:Omit<ListenerDeps,'resolveIdentity'|'handleRequest'> & {pairStore:PairStore;tasks?:ReturnType<typeof createBoundedTaskController>;taskDiscovery?:()=>Promise<string[]>;personalClient?:PersonalClient}){
 return createSessionListener({...deps,resolveIdentity:pairingIdentityResolver(deps.pairStore),handleRequest:async(req,res,path)=>{
  const reply=(status:number,body:unknown)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));return true}
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
   const result=await runPersonalTurn(deps.personalClient,{messages:valid.messages})
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
