/** Opt-in, server-owned context policy. No browser input, remote route or key creation. */
import {open,lstat} from 'node:fs/promises'
import {constants} from 'node:fs'
import {join} from 'node:path'
import {createHash} from 'node:crypto'
import {createContextCache,type PackResult,type PackRequest} from './tarx-context-cache.ts'

export type PersonalContextResolver=(ownerNamespace:string,modelIdentity:string)=>Promise<PackResult|null>
const NAME=/^[A-Za-z0-9_-]{1,80}$/
async function privateDirectory(path:string){
 const s=await lstat(path)
 if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw Error('context_policy_unavailable')
}
async function privateFile(path:string,max:number){
 const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW)
 try{const s=await f.stat();if(!s.isFile()||s.size>max||(s.mode&0o077)||(process.getuid&&s.uid!==process.getuid()))throw Error('context_policy_unavailable');return await f.readFile('utf8')}
 finally{await f.close()}
}
export function createPersonalContextResolver(home:string):PersonalContextResolver{
 const state=join(home,'.tarx','state'),root=join(state,'context')
 return async(owner,modelIdentity)=>{
  let raw:string
  try{await privateDirectory(state);raw=await privateFile(join(state,'context-runtime.json'),32768)}
  catch(e:any){if(e.code==='ENOENT')return null;throw Error('context_policy_unavailable')}
  const policy=JSON.parse(raw)
  if(!policy||policy.version!==1||!Array.isArray(policy.bindings)||policy.bindings.length>64||!NAME.test(policy.key_name)||!NAME.test(policy.cache_name))throw Error('context_policy_unavailable')
  const bindings=policy.bindings.filter((b:any)=>b?.scope?.owner_namespace===owner)
  if(bindings.length!==1)throw Error('context_owner_unbound')
  const binding=bindings[0]
  if(binding.enabled!==true)throw Error('context_owner_disabled')
  // This route is personal chat, not an authenticated channel selector.
  if(binding.scope.channel_id!=='personal')throw Error('context_channel_unbound')
  if(!modelIdentity)throw Error('context_model_unbound')
  await privateDirectory(root)
  const text=(await privateFile(join(root,policy.key_name+'.key'),128)).trim()
  if(!/^[a-f0-9]{64}$/.test(text))throw Error('context_key_unavailable')
  const request:PackRequest={schema_version:1,scope:binding.scope,recipient:{location:'this_computer',provider_id:'owned-local',model_id:'local_'+createHash('sha256').update(modelIdentity).digest('hex')},policy_version:binding.policy_version,prompt_version:binding.prompt_version,fact_ids:binding.fact_ids,max_bytes:binding.max_bytes}
  // Identity is the current paired principal, not a field supplied by the browser.
  return createContextCache({file:join(root,policy.cache_name+'.json'),key:Buffer.from(text,'hex')}).pack(owner,request)
 }
}
