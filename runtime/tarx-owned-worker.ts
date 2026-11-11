/** Legacy worker supervisor. The daemon supervisor is daemon/src/supervisor.ts; this owns the Eve check-worker only. */
/** Explicit owned child only; never install/page-load startup or arbitrary attach. */
import {spawn,type ChildProcess} from 'node:child_process'
import {mkdir,symlink,readFile,readlink,writeFile,lstat,readdir,unlink,rmdir} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
import {createPublicWorkerProfile} from './tarx-public-worker-profile.ts'
type OwnedStopOptions={graceMs?:number;exitMs?:number;signalGroup?:(pid:number,signal:NodeJS.Signals)=>void}
const childStops=new WeakMap<ChildProcess,Promise<void>>()
/** Only a live owned leader authorizes a group signal. Exit is leader proof,
 * not proof that escaped/reaped-leader descendants were terminated. */
export function stopOwnedWorkerChild(child:ChildProcess,options:OwnedStopOptions={}):Promise<void>{
 const prior=childStops.get(child);if(prior)return prior
 const stopping=(async()=>{
  let exited=child.exitCode!==null||child.signalCode!==null||!child.pid
  let wake:(()=>void)|undefined
  const onExit=()=>{exited=true;wake?.()}
  const live=()=>!exited&&child.pid!==undefined&&child.exitCode===null&&child.signalCode===null
  if(!live())return
  child.once('exit',onExit);child.once('close',onExit)
  const waitForExit=(milliseconds:number)=>new Promise<void>(resolve=>{
   if(!live()){resolve();return}
   const timer=setTimeout(done,milliseconds)
   function done(){clearTimeout(timer);wake=undefined;resolve()}
   wake=done
  })
  const signal=(name:NodeJS.Signals)=>{
   if(!live())return
   try{(options.signalGroup??((pid,kind)=>process.kill(-pid,kind)))(child.pid!,name)}
   catch{if(live())try{child.kill(name)}catch{/* The exit deadline decides success. */}}
  }
  try{
   signal('SIGTERM')
   await waitForExit(options.graceMs??1200)
   if(live())signal('SIGKILL')
   await waitForExit(options.exitMs??3000)
   if(live())throw Error('owned_worker_stop_timeout')
  }finally{child.removeListener('exit',onExit);child.removeListener('close',onExit)}
 })()
 childStops.set(child,stopping)
 void stopping.then(()=>childStops.delete(child),()=>childStops.delete(child))
 return stopping
}
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
 let buildChild:ChildProcess|undefined,startFlight:Promise<void>|undefined,stopping:Promise<void>|undefined,cleaning:Promise<void>|undefined,generation=0
 async function build(){
  if(built)return
  const processChild=spawn(process.execPath,[join(base,'node_modules/eve/bin/eve.js'),'build','--skip-sandbox-prewarm'],{cwd:input.root,detached:true,env:environment,stdio:'ignore'})
  buildChild=processChild
  try{
   await new Promise<void>((resolve,reject)=>{
    const finish=(error?:Error)=>{clearTimeout(timer);processChild.removeListener('error',onError);processChild.removeListener('exit',onExit);error?reject(error):resolve()}
    const onError=()=>finish(Error('owned_worker_build_failed'))
    const onExit=(code:number|null)=>finish(code===0?undefined:Error('owned_worker_build_failed'))
    const timer=setTimeout(()=>{void stopOwnedWorkerChild(processChild).then(()=>finish(Error('owned_worker_build_timeout')),()=>finish(Error('owned_worker_stop_timeout')))},90000)
    processChild.once('error',onError);processChild.once('exit',onExit)
   })
   built=true
  }finally{if(buildChild===processChild&&(processChild.exitCode!==null||processChild.signalCode!==null||!processChild.pid))buildChild=undefined}
 }
 type Reservation={marker:string;dev?:number;ino?:number;markerDev?:number;markerIno?:number;ready:boolean;markerRemoved:boolean}
 let reservation:Reservation|undefined,acquiring:Promise<void>|undefined
 const lockPath=join(input.root,'.runtime.lock')
 function reserve(){
  const claim:Reservation={marker:'.owner-'+randomBytes(16).toString('hex'),ready:false,markerRemoved:false}
  const flight=(async()=>{
   await mkdir(lockPath,{mode:0o700});locked=true;reservation=claim
   const directory=await lstat(lockPath);claim.dev=directory.dev;claim.ino=directory.ino
   if(!directory.isDirectory()||directory.isSymbolicLink())throw Error('owned_worker_lock_changed')
   await writeFile(join(lockPath,claim.marker),'',{flag:'wx',mode:0o600})
   const marker=await lstat(join(lockPath,claim.marker));claim.markerDev=marker.dev;claim.markerIno=marker.ino;claim.ready=true
  })()
  acquiring=flight
  void flight.then(()=>{if(acquiring===flight)acquiring=undefined},()=>{if(acquiring===flight)acquiring=undefined})
  return flight
 }
 async function releaseReservation(){
  if(acquiring)await acquiring.catch(()=>{})
  if(!locked)return
  const claim=reservation
  let directory
  try{directory=await lstat(lockPath)}catch(error:any){if(error.code==='ENOENT'){locked=false;reservation=undefined;return}throw error}
  if(!claim?.ready||!directory.isDirectory()||directory.isSymbolicLink()||directory.dev!==claim.dev||directory.ino!==claim.ino)throw Error('owned_worker_lock_changed')
  const entries=await readdir(lockPath)
  if(claim.markerRemoved?entries.length!==0:entries.length!==1||entries[0]!==claim.marker)throw Error('owned_worker_lock_changed')
  if(!claim.markerRemoved){
   const marker=await lstat(join(lockPath,claim.marker))
   if(!marker.isFile()||marker.isSymbolicLink()||marker.size!==0||marker.dev!==claim.markerDev||marker.ino!==claim.markerIno)throw Error('owned_worker_lock_changed')
   await unlink(join(lockPath,claim.marker));claim.markerRemoved=true
  }
  // Re-check before a non-recursive removal. Never erase a replacement's contents.
  try{directory=await lstat(lockPath)}catch(error:any){if(error.code==='ENOENT'){locked=false;reservation=undefined;return}throw error}
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.dev!==claim.dev||directory.ino!==claim.ino)throw Error('owned_worker_lock_changed')
  await rmdir(lockPath);locked=false;reservation=undefined
 }
 function cleanup(){
  if(cleaning)return cleaning
  const flight=(async()=>{
   const builder=buildChild
   if(builder){await stopOwnedWorkerChild(builder);if(buildChild===builder)buildChild=undefined}
   verified=false;const old=child
   if(old){await stopOwnedWorkerChild(old);if(child===old)child=undefined}
   await releaseReservation()
  })()
  cleaning=flight
  void flight.then(()=>{if(cleaning===flight)cleaning=undefined},()=>{if(cleaning===flight)cleaning=undefined})
  return flight
 }
 function stop(){
  if(stopping)return stopping
  generation++;verified=false
  const starting=startFlight
  const flight=(async()=>{
   await cleanup()
   // A pending mkdir/build/readiness continuation must settle before Stop succeeds.
   if(starting)await starting.catch(()=>{})
   await cleanup()
  })()
  stopping=flight
  void flight.then(()=>{if(stopping===flight)stopping=undefined},()=>{if(stopping===flight)stopping=undefined})
  return flight
 }
 async function verify(){return verified&&child?.exitCode===null&&child?.signalCode===null&&await profile.verify()}
 function start(){
  if(stopping)return Promise.reject(Error('worker_stopping'))
  if(startFlight||child)return Promise.reject(Error('worker_already_owned'))
  const epoch=generation
  const current=()=>{if(generation!==epoch)throw Error('owned_worker_start_cancelled')}
  const flight=(async()=>{
   try{
    if(!await profile.verify())throw Error('profile_changed');current()
    try{await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(250)});throw Error('worker_port_in_use')}catch(e:any){if(e.message==='worker_port_in_use')throw e}
    current();await reserve();current()
    await build();current()
    if(!await profile.verify())throw Error('profile_changed');current()
    child=spawn(process.execPath,[join(base,'node_modules/eve/bin/eve.js'),'start','--no-schedules','--host','127.0.0.1','--port',String(input.port)],{cwd:input.root,detached:true,env:environment,stdio:['ignore','pipe','pipe']})
    child.stdout?.resume();child.stderr?.resume();let spawnError=false;child.once('error',()=>{spawnError=true})
    for(let i=0;i<160;i++){
     current()
     if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('owned_worker_exited')
     try{if((await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(500)})).ok){
      current()
      const denied=await fetch(host+'/eve/v1/info',{redirect:'error',signal:AbortSignal.timeout(1000)})
      current()
      if(denied.status===401){const info=await client.info({signal:AbortSignal.timeout(1500)});current();const names=info.tools.static.map((tool:any)=>tool.name);if(info.tools.dynamic.length||names.length!==1||names[0]!=='read_launch_note')throw Error('unexpected_worker_inventory');verified=true;const ready=await verify();current();if(ready)return}
     }}catch{/* The outer generation check also fences failed readiness requests. */}
     current();await wait(300)
    }
    throw Error('owned_worker_start_timeout')
   }catch(error){await cleanup();throw error}
  })()
  startFlight=flight
  void flight.then(()=>{if(startFlight===flight)startFlight=undefined},()=>{if(startFlight===flight)startFlight=undefined})
  return flight
 }
 async function tools(){if(!await verify())return [];const info=await client.info({signal:AbortSignal.timeout(1500)});const names=info.tools.static.map((tool:any)=>tool.name);return info.tools.dynamic.length===0&&names.length===1&&names[0]==='read_launch_note'?names:[]}
 return {client,start,stop,verify,host,tools}
}
