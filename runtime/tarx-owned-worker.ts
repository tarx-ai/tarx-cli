/** Explicit owned child only; never install/page-load startup or arbitrary attach. */
import {spawn,type ChildProcess} from 'node:child_process'
import {mkdir,symlink,readFile} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {randomBytes} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {setTimeout as wait} from 'node:timers/promises'
import {createPublicWorkerProfile} from './tarx-public-worker-profile.ts'
export async function createOwnedPublicWorker(input:{root:string;home:string;eveRoot:string;modelBaseURL:string;modelId:string;port:number}){
 if(!Number.isInteger(input.port)||input.port<1024||input.port>65535)throw Error('invalid_worker_port')
 const base=resolve(input.eveRoot),require=createRequire(join(base,'package.json'))
 if(JSON.parse(await readFile(require.resolve('eve/package.json'),'utf8')).version!=='0.83.2')throw Error('eve_version_mismatch')
 const profile=await createPublicWorkerProfile(input.root,input.modelBaseURL,input.modelId)
 await mkdir(input.home,{mode:0o700});await symlink(join(base,'node_modules'),join(input.root,'node_modules'))
 const token=randomBytes(32).toString('hex'),host=`http://127.0.0.1:${input.port}`
 const {Client}=await import(pathToFileURL(require.resolve('eve/client')).href)
 const client=new Client({host,auth:{bearer:token},redirect:'error'});let child:ChildProcess|undefined,verified=false
 async function stop(){verified=false;const old=child;child=undefined;if(old?.pid){try{process.kill(-old.pid,'SIGTERM');await wait(1200);try{process.kill(-old.pid,'SIGKILL')}catch{}}catch{}for(let i=0;i<30;i++){await wait(100);try{await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(150)})}catch{return}}throw Error('owned_worker_stop_timeout')}}
 async function verify(){return verified&&child?.exitCode===null&&child?.signalCode===null&&await profile.verify()}
 async function start(){
  if(child)throw Error('worker_already_owned');if(!await profile.verify())throw Error('profile_changed')
  try{await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(250)});throw Error('worker_port_in_use')}catch(e:any){if(e.message==='worker_port_in_use')throw e}
  child=spawn(process.execPath,[join(base,'node_modules/eve/bin/eve.js'),'dev','--no-ui','--no-default-extensions','--resume','--host','127.0.0.1','--port',String(input.port)],{cwd:input.root,detached:true,env:{PATH:process.env.PATH,HOME:input.home,TMPDIR:input.home,EVE_TELEMETRY_DISABLED:'1',EVE_SCHEDULES_DISABLED:'1',TARX_WORKER_TOKEN:token},stdio:['ignore','pipe','pipe']})
  child.stdout?.resume();child.stderr?.resume();let spawnError=false;child.once('error',()=>{spawnError=true})
  try{for(let i=0;i<160;i++){
   if(spawnError||child.exitCode!==null||child.signalCode!==null)throw Error('owned_worker_exited')
   try{if((await fetch(host+'/eve/v1/health',{signal:AbortSignal.timeout(500)})).ok){
    const denied=await fetch(host+'/eve/v1/info',{redirect:'error',signal:AbortSignal.timeout(1000)})
    if(denied.status===401){await client.info({signal:AbortSignal.timeout(1500)});verified=true;if(await verify())return}
   }}catch{}
   await wait(300)
  }throw Error('owned_worker_start_timeout')}catch(e){await stop();throw e}
 }
 return {client,start,stop,verify,host}
}
