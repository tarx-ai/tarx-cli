/** Native-host transport only. A caller must obtain task/data consent separately.
 * No service-key lookup, provider fallback, model startup or renderer access. */
import https from 'node:https'
type Message={role:string;content:string}
type Options={signal?:AbortSignal;maxTokens?:number;jsonSchema?:unknown}
const ORIGIN='https://compute.tarx.com',MODEL='tarx/t-supercomputer'
const RESPONSE_LIMIT=65536,REQUEST_LIMIT=65536

export function createSupercomputerPlannerClient(input:{token:string;tokenLimit?:256|1024}) {
 const limit=input.tokenLimit??256
 // Existing revocable CLI account credential only. Never distribute or accept
 // the gateway service credential in this client contract.
 if(typeof input.token!=='string'||!/^tarx_cli_[0-9a-f]{64}$/.test(input.token)||![256,1024].includes(limit))throw Error('invalid_supercomputer_planner')
 const token=input.token
 function request(path:'/health'|'/v1/chat/completions',body:string|undefined,signal?:AbortSignal):Promise<unknown|null> {
  if(signal?.aborted)return Promise.resolve(null)
  return new Promise(resolve=>{
   let settled=false,timer:ReturnType<typeof setTimeout>|undefined,req:ReturnType<typeof https.request>|undefined
   const abort=()=>{finish(null);req?.destroy()}
   const finish=(result:unknown|null)=>{if(settled)return;settled=true;if(timer)clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(result)}
   try {
    req=https.request(ORIGIN+path,{method:body===undefined?'GET':'POST',agent:false,headers:{accept:'application/json',...(body===undefined?{}:{authorization:`Bearer ${token}`,'content-type':'application/json','content-length':String(Buffer.byteLength(body))})}},res=>{
     if(res.statusCode!==200){res.destroy();finish(null);return}
     const chunks:Buffer[]=[];let bytes=0
     res.on('data',chunk=>{bytes+=chunk.length;if(bytes>RESPONSE_LIMIT){finish(null);res.destroy();req?.destroy()}else chunks.push(Buffer.from(chunk))})
     res.on('aborted',()=>finish(null));res.on('error',()=>finish(null))
     res.on('end',()=>{try{finish(JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{finish(null)}})
     res.on('close',()=>finish(null))
    })
    req.on('error',()=>finish(null));req.on('close',()=>finish(null))
    timer=setTimeout(abort,body===undefined?2000:10000)
    signal?.addEventListener('abort',abort,{once:true})
    if(signal?.aborted)abort();else req.end(body)
   }catch{finish(null);req?.destroy()}
  })
 }
 return {modelId:MODEL,endpoint:ORIGIN+'/v1/chat/completions',
  /** Availability only. Account tokens may chat but cannot GET /v1/models.
   * Auth, revocation and quota are checked by the gateway on each completion. */
  async ready(){const data:any=await request('/health',undefined);return data?.status==='ok'&&data?.upstream_healthy===true},
  async complete(messages:Message[],options:unknown={}) {
   if(!options||typeof options!=='object'||Array.isArray(options))return null
   const opts=options as Options
   if(opts.signal!==undefined&&!(opts.signal instanceof AbortSignal))return null
   if(opts.signal?.aborted||!Array.isArray(messages)||messages.length<1||messages.length>32)return null
   let body:string
   try {
    if(!opts.jsonSchema||typeof opts.jsonSchema!=='object'||Array.isArray(opts.jsonSchema)||![Object.prototype,null].includes(Object.getPrototypeOf(opts.jsonSchema))||Buffer.byteLength(JSON.stringify(opts.jsonSchema))>8192)return null
    const selected=messages.map(m=>{
     if(!m||!['system','user','assistant'].includes(m.role)||typeof m.content!=='string'||m.content.length>32768)throw Error('invalid_messages')
     return {role:m.role,content:m.content}
    })
    const max=opts.maxTokens??limit
    if(!Number.isInteger(max)||max<1)return null
    body=JSON.stringify({model:MODEL,messages:selected,stream:false,max_tokens:Math.min(max,limit),temperature:0,
     chat_template_kwargs:{enable_thinking:false},response_format:{type:'json_schema',json_schema:{name:'computer_use_step',strict:true,schema:opts.jsonSchema}}})
    if(Buffer.byteLength(body)>REQUEST_LIMIT)return null
   }catch{return null}
   const data:any=await request('/v1/chat/completions',body,opts.signal)
   // Independent action/selector parsing still belongs to the core planner.
   const content=data?.choices?.[0]?.message?.content
   return data?.model===MODEL&&typeof content==='string'&&content.trim()?content:null
  },
 }
}
