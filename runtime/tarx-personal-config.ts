/** Operator-owned configuration only; never a browser URL, model or credential. */
import {readFile,stat,realpath} from 'node:fs/promises'
import {homedir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {createLoopbackPersonalClient,type PersonalClient} from './tarx-personal-turn.ts'

async function ownerFile(path:string):Promise<string>{
 const info=await stat(path)
 if(!info.isFile()||info.size>8192||(info.mode&0o077)||(process.getuid&&info.uid!==process.getuid()))throw Error('unsafe_personal_config')
 return readFile(path,'utf8')
}
export async function loadPersonalClient(home=homedir(),env:NodeJS.ProcessEnv=process.env):Promise<PersonalClient|undefined>{
 try{
  let profile:Record<string,unknown>={}
  const file=join(home,'.tarx','state','personal-runtime.json')
  try{profile=JSON.parse(await ownerFile(file));if(!profile||typeof profile!=='object'||Array.isArray(profile))return undefined}
  catch(e:any){if(e.code!=='ENOENT')return undefined}
  const url=env.TARX_PERSONAL_RUNTIME_URL??profile.url??''
  const model=env.TARX_PERSONAL_RUNTIME_MODEL??profile.model??'tarx-personal'
  let key:unknown=env.TARX_PERSONAL_RUNTIME_KEY??''
  if(!key&&profile.key_file){
   if(typeof profile.key_file!=='string')return undefined
   const base=await realpath(home),file=await realpath(resolve(home,profile.key_file)),rel=relative(base,file)
   if(rel==='..'||rel.startsWith('../')||isAbsolute(rel))return undefined
   key=(await ownerFile(file)).trim()
  }
  if(typeof url!=='string'||typeof model!=='string'||typeof key!=='string'||!url)return undefined
  return createLoopbackPersonalClient({baseURL:url,model,apiKey:key})
 }catch{return undefined}
}
