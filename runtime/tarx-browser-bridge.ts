/** Explicit local-window transport for browsers that block HTTPS -> HTTP loopback fetch.
 * No model or credentials live here. Only approved claim/personal requests reach the
 * existing paired listener. The hosted page exchanges messages with its own window.
 */
import {createServer,request as httpRequest,type IncomingMessage,type ServerResponse} from 'node:http'
import {createHash,randomBytes} from 'node:crypto'
import {validatePersonalTurn} from './tarx-personal-turn.ts'

const PARENTS=new Set(['https://www.tarx.com','https://tarx.com'])
const MAX_BODY=270336
const NONCE_TTL=24*60*60*1000
type Rpc={id:string;kind:'claim';challenge:string}|{id:string;kind:'personal';bearer:string;messages:unknown}|{id:string;kind:'learning';bearer:string;request:unknown}
function rpc(value:unknown):Rpc|null{
 if(!value||typeof value!=='object'||Array.isArray(value))return null
 const row=value as Record<string,unknown>
 if(typeof row.id!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(row.id))return null
 if(row.kind==='claim'){
  if(Object.keys(row).some(k=>!['id','kind','challenge'].includes(k))||typeof row.challenge!=='string'||!/^[a-f0-9]{64}$/.test(row.challenge))return null
  return row as Rpc
 }
 if(row.kind==='personal'){
  if(Object.keys(row).some(k=>!['id','kind','bearer','messages'].includes(k))||typeof row.bearer!=='string'||!/^tpc_[a-f0-9]{64}$/.test(row.bearer))return null
  if(!validatePersonalTurn({messages:row.messages}).ok||Buffer.byteLength(JSON.stringify({messages:row.messages}))>32768)return null
  return row as Rpc
 }
 if(row.kind==='learning'){
  if(Object.keys(row).some(k=>!['id','kind','bearer','request'].includes(k))||typeof row.bearer!=='string'||!/^tpc_[a-f0-9]{64}$/.test(row.bearer))return null
  // Strict: request must be a plain object with a known action and only its
  // allowed keys. Reject null, arrays, unknown actions, and extra fields.
  const req=row.request
  if(!req||typeof req!=='object'||Array.isArray(req))return null
  const r=req as Record<string,unknown>
  const allowed:Record<string,string[]>={status:['action'],pause:['action'],add_example:['action','example_id','prompt','response'],train:['action','request_id'],activate:['action','version']}
  const keys=allowed[typeof r.action==='string'?r.action:'']
  const present=Object.keys(r)
  if(!keys||present.length!==keys.length||present.some(k=>!keys.includes(k)))return null
  if(Buffer.byteLength(JSON.stringify(req))>262144)return null
  return row as Rpc
 }
 return null
}

/** Serialized as a static inline script. No challenge/prompt is in the page or URL. */
function bridgeClient(config:{parent:string;nonce:string;returnName?:string}){
 const owner=window.opener
 const active=new Map<string,AbortController>()
 let connected:MessagePort|null=null
 window.addEventListener('message',event=>{
  if(event.origin!==config.parent||event.source!==owner||!owner)return
  if(event.data?.type!=='tarx.local-bridge.connect'||event.data?.version!==1||event.ports.length!==1)return
  connected?.close()
  for(const c of active.values())c.abort()
  active.clear()
  const port=event.ports[0];connected=port
  port.onmessage=async e=>{
   const m=e.data
   if(!m||typeof m!=='object'||typeof m.id!=='string')return
   if(m.kind==='abort'){active.get(m.id)?.abort();return}
   if((m.kind!=='claim'&&m.kind!=='personal'&&m.kind!=='learning')||active.has(m.id)||active.size>=2)return
   const controller=new AbortController();active.set(m.id,controller)
   try{
    const response=await fetch('/rpc',{method:'POST',credentials:'omit',cache:'no-store',redirect:'error',
     headers:{'content-type':'application/json','x-tarx-local-bridge':config.nonce},
     body:JSON.stringify(m),signal:controller.signal})
    const text=await response.text()
    const body=text.length<=65536?JSON.parse(text):{error:'response_too_large'}
    port.postMessage({id:m.id,status:response.status,body})
   }catch{port.postMessage({id:m.id,status:503,body:{error:'unreachable'}})}
   finally{active.delete(m.id)}
  }
  port.start()
 })
 document.getElementById('return')?.addEventListener('click',()=>{
  if(!owner)return
  // Safari ignores cross-origin opener.focus(). An explicit named-context open
  // selects the existing parent without navigating it or closing the transport.
  if(config.returnName)window.open('',config.returnName)?.focus()
  else owner.focus()
 })
 owner?.postMessage({type:'tarx.local-bridge.ready',version:1},config.parent)
}

function send(res:ServerResponse,status:number,body:unknown){
 if(res.destroyed)return
 res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'})
 res.end(JSON.stringify(body))
}
async function readBody(req:IncomingMessage):Promise<unknown>{
 const chunks:Buffer[]=[];let size=0
 for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw Error('body_too_large');chunks.push(Buffer.from(chunk))}
 return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}
export function createBrowserBridge(options:{port?:number;corePort?:number}={}){
 const port=options.port??3271,corePort=options.corePort??3270
 if(!Number.isInteger(port)||port<0||port>65535||!Number.isInteger(corePort)||corePort<1||corePort>65535)throw Error('invalid_port')
 const sessions=new Map<string,{parent:string;expires:number}>()
 const server=createServer(async(req,res)=>{
  const address=server.address()
  if(!address||typeof address==='string')return send(res,503,{error:'unavailable'})
  const own='http://127.0.0.1:'+address.port
  if(req.headers.host!=='127.0.0.1:'+address.port)return send(res,403,{error:'untrusted_host'})
  const url=new URL(req.url??'/',own)
  if(url.origin!==own)return send(res,403,{error:'untrusted_host'})
  if(req.method==='GET'&&url.pathname==='/bridge'){
   const parent=url.searchParams.get('origin')??'https://www.tarx.com'
   const returnName=url.searchParams.get('return')??undefined
   if(!PARENTS.has(parent)||[...url.searchParams.keys()].some(k=>!['origin','return'].includes(k))||
      (returnName!==undefined&&!/^tarx-return-[a-f0-9-]{32,64}$/.test(returnName)))return send(res,403,{error:'untrusted_parent'})
   for(const [key,s] of sessions)if(s.expires<=Date.now())sessions.delete(key)
   if(sessions.size>=32)return send(res,429,{error:'too_many_bridges'})
   const existing=[...sessions].find(([,s])=>s.parent===parent)
   const nonce=existing?.[0]??randomBytes(32).toString('hex')
   if(!existing)sessions.set(nonce,{parent,expires:Date.now()+NONCE_TTL})
   const script='('+bridgeClient.toString()+')('+JSON.stringify({parent,nonce,returnName})+')'
   const hash=createHash('sha256').update(script).digest('base64')
   res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff',
    'referrer-policy':'no-referrer','x-frame-options':'DENY',
    'content-security-policy':"default-src 'none'; script-src 'sha256-"+hash+"'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"})
   return res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>TARX private connection</title><h1>Private connection</h1><p>This window connects TARX to the local model on this Mac. Keep it open while using private chat.</p><p>Approvals and conversation stay in your TARX conversation.</p><button id="return">Return to TARX</button><script>'+script+'</script>')
  }
  if(req.method!=='POST'||url.pathname!=='/rpc')return send(res,404,{error:'not_found'})
  const nonce=req.headers['x-tarx-local-bridge']
  const session=typeof nonce==='string'?sessions.get(nonce):undefined
  if(req.headers.origin!==own||!session||session.expires<=Date.now())return send(res,403,{error:'untrusted_bridge'})
  if(!/^application\/json(?:;|$)/i.test(req.headers['content-type']??''))return send(res,415,{error:'content_type'})
  let input:Rpc|null
  try{input=rpc(await readBody(req))}catch{return send(res,400,{error:'invalid_request'})}
  if(!input)return send(res,400,{error:'invalid_request'})
  const payload=input.kind==='claim'?{challenge:input.challenge}:input.kind==='learning'?input.request:{messages:input.messages}
  const body=JSON.stringify(payload)
  const headers:Record<string,string>={'origin':session.parent,'content-type':'application/json','content-length':String(Buffer.byteLength(body))}
  if(input.kind==='personal'||input.kind==='learning')headers.authorization='Bearer '+input.bearer
  const upstream=httpRequest({hostname:'127.0.0.1',port:corePort,path:input.kind==='claim'?'/pairing/claim':input.kind==='learning'?'/personal-learning':'/personal-turn',method:'POST',headers,agent:false},response=>{
   const chunks:Buffer[]=[];let size=0
   response.on('data',chunk=>{size+=chunk.length;if(size>65536){upstream.destroy();return}chunks.push(Buffer.from(chunk))})
   response.on('end',()=>{try{send(res,response.statusCode??503,JSON.parse(Buffer.concat(chunks).toString('utf8')))}catch{send(res,503,{error:'unreachable'})}})
  })
  upstream.setTimeout(71000,()=>upstream.destroy(Error('timeout')))
  upstream.on('error',()=>send(res,503,{error:'unreachable'}))
  res.on('close',()=>{if(!res.writableEnded)upstream.destroy()})
  upstream.end(body)
 })
 return {server,
  listen:()=>new Promise<{host:string;port:number}>((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);const a=server.address();if(a&&typeof a!=='string')resolve({host:'127.0.0.1',port:a.port})})}),
  close:()=>new Promise<void>((resolve,reject)=>server.close(e=>e?reject(e):resolve()))}
}
