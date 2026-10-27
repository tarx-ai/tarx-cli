/** Operator-owned configuration only; never a browser URL, model or credential. */
import {access,lstat,readFile,stat,realpath} from 'node:fs/promises'
import {constants} from 'node:fs'
import {homedir} from 'node:os'
import {join,resolve,relative,isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createLoopbackPersonalClient,type PersonalClient} from './tarx-personal-turn.ts'
import {createLearningController,denyNetworkArgv,trustedInstalledRunner,type LearningConfig} from './tarx-local-learning.ts'

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

async function trustedInterpreter(value:unknown):Promise<string|undefined>{
 if(typeof value!=='string'||!isAbsolute(value)||/\s|\0/.test(value))return undefined
 try{
  const info=await lstat(value)
  if(info.isSymbolicLink()){
   const linked=await realpath(value)
   const target=await lstat(linked)
   if(!target.isFile()||(target.mode&0o111)===0)return undefined
  }else if(!info.isFile()||(info.mode&0o111)===0)return undefined
  // Keep the venv path. realpath would drop pyvenv.cfg.
  return value
 }catch{return undefined}
}

/** Operator learning config. The runner path is the packaged script, never a
 * profile-selected file. Darwin require sandbox-exec; any other case leaves
 * learning off instead of launching raw Python. State paths follow `home`. */
export async function loadLearningController(home=homedir()){
 const fileStore=join(home,'.tarx','state','learning.json')
 const stateRoot=join(home,'.tarx','state','learning')
 const runnerScript=fileURLToPath(new URL('./personal_learning_mlx.py',import.meta.url))
 let config:LearningConfig|undefined
 try{
  if(process.platform!=='darwin')throw Error('sandbox_required')
  await access('/usr/bin/sandbox-exec',constants.X_OK)
  const profile=JSON.parse(await ownerFile(join(home,'.tarx','state','personal-learning.json')))
  if(!profile||typeof profile!=='object'||Array.isArray(profile))throw Error('unsafe_personal_config')
  const interpreter=await trustedInterpreter(profile.interpreter)
  if(!interpreter||typeof profile.base_path!=='string'||!isAbsolute(profile.base_path))throw Error('unsafe_personal_config')
  const base=await stat(profile.base_path)
  if(!base.isDirectory())throw Error('unsafe_personal_config')
  if(!await trustedInstalledRunner(runnerScript))throw Error('unsafe_runner')
  config={interpreter,runnerScript,basePath:resolve(profile.base_path),sandboxWrap:denyNetworkArgv}
 }catch{config=undefined}
 return createLearningController({file:fileStore,stateRoot,config})
}
