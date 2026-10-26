/** Explicit owned child only; never install/page-load startup or arbitrary attach. */
import {spawn,type ChildProcess} from 'node:child_process'
import {mkdir,symlink,readFile,readlink,rm} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
import {createPublicWorkerProfile} from './tarx-public-worker-profile.ts'
export async function createOwnedPublicWorker(input:{root:string;home:string;eveRoot:string;modelBaseURL:string;modelId:string;port:number;resume?:boolean}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('invalid_worker_port')
 const base=resolve(input.eveRoot),require=createRequire(join(base,'package.json'))
 if(JSON.parse(await readFile(require.resolve('eve/package.json'),'utf8')).version!=='0.83.2')throw Error('eve_version_mismatch')
 const profile=await createPublicWorkerProfile(input.root,input.modelBaseURL,input.modelId,input.resume)
 await mkdir(input.home,{mode:0o700,recursive:true});if(input.resume){if(await readlink(join(input.root,'node_modules'))!==join(base,'node_modules'))throw Error('runtime_dependency_changed')}else await symlink(join(base,'node_modules'),join(input.root,'node_modules'))
 const token=randomBytes(32).toString('hex'),host=`http://127.0.0.1:${input.port}`
 const {Client}=await import(pathToFileURL(require.resolve('eve/client')).href)
 const client=new Client({host,auth:{bearer:token},redirect:'error'});let child:ChildProcess|undefined,verified=false,built=false,locked=false
 const environment={PATH:process.env.PATH,HOME:input.home,TMPDIR:input.home,EVE_TELEMETRY_DISABLED:'1',EVE_SCHEDULES_DISABLED:'1',TARX_WORKER_TOKEN:token}
 async function build(){
  if(built)return
  const processChild=spawn(process.execPath,[join(base,'node_modules/eve/bin/eve.js'),'build','--skip-sandbox-prewarm'],{cwd:input.root,detached:true,env:environment,stdio:'ignore'})
  try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>{try{if(processChild.pid)process.kill(-processChild.pid,'SIGKILL')}catch{}reject(Error('owned_worker_build_timeout'))},90000);processChild.once('error',()=>{clearTimeout(timer);reject(Error('owned_worker_build_failed'))});processChild.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(Error('owned_worker_build_failed'))})});built=true}catch(e){throw e}
 }
 async function stop(){try{await stopChild()}finally{if(locked){locked=false;await rm(join(input.root,'.runtime.lock'),{recursive:true})}}}
 async function stopChild(){verified=false;const old=child;child=undefined;if(old?.pid){try{process.kill(-old.pid,'SIGTERM');await wait(1200);try{process.kill(-old.pid,'SIGKILL')}catch{}}catch{}for(let i=0;i<30;i++){await wait(100);try{await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(150)})}catch{return}}throw Error('owned_worker_stop_timeout')}}
 async function verify(){return verified&&child?.exitCode===null&&child?.signalCode===null&&await profile.verify()}
 async function start(){
  if(child)throw Error('worker_already_owned');if(!await profile.verify())throw Error('profile_changed')
  try{await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(250)});throw Error('worker_port_in_use')}catch(e:any){if(e.message==='worker_port_in_use')throw e}
  await mkdir(join(input.root,'.runtime.lock'));locked=true
  try{await build()}catch(e){await stop();throw e}
  if(!await profile.verify()){await stop();throw Error('profile_changed')}
  child=spawn(process.execPath,[join(base,'node_modules/eve/bin/eve.js'),'start','--no-schedules','--host','127.0.0.1','--port',String(input.port)],{cwd:input.root,detached:true,env:environment,stdio:['ignore','pipe','pipe']})
  child.stdout?.resume();child.stderr?.resume();let spawnError=false;child.once('error',()=>{spawnError=true})
  try{for(let i=0;i<160;i++){
   if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('owned_worker_exited')
   try{if((await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(500)})).ok){
    const denied=await fetch(host+'/eve/v1/info',{redirect:'error',signal:AbortSignal.timeout(1000)})
    if(denied.status===401){const info=await client.info({signal:AbortSignal.timeout(1500)});const names=info.tools.static.map((tool:any)=>tool.name);if(info.tools.dynamic.length||names.length!==1||names[0]!=='read_launch_note')throw Error('unexpected_worker_inventory');verified=true;if(await verify())return}
   }}catch{}
   await wait(300)
  }throw Error('owned_worker_start_timeout')}catch(e){await stop();throw e}
 }
 async function tools(){if(!await verify())return [];const info=await client.info({signal:AbortSignal.timeout(1500)});const names=info.tools.static.map((tool:any)=>tool.name);return info.tools.dynamic.length===0&&names.length===1&&names[0]==='read_launch_note'?names:[]}
 return {client,start,stop,verify,host,tools}
}
