/** Trusted desktop-host integration. No browser/HTTP input chooses executables,
 * models, windows, success checks or approvals. Each run owns one process group. */
import {fork,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstat,readFile,readdir,realpath,mkdtemp,rm} from 'node:fs/promises'
import {isAbsolute,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'
import type {ComputerExecutor,ComputerOutcome,ComputerSession} from './tarx-computer-task.ts'

export type CheckedFile={path:string;sha256:string}
export type ComputerArtifacts={coreSource:string;coreDirectory:string;files:Record<string,string>;node:CheckedFile;adapter:CheckedFile}
export type NativeCheck={kind:'enabled'|'count';role:string;name:string;count?:number}
export type NativeAction={command:'click';role:string;name:string}
export type NativeScope={
 app:string;window:{id:string;pid:number;title_sha256:string};actions:NativeAction[];success:NativeCheck[]
 mode:'local_model'|'deterministic_actuator';steps?:Array<{action:NativeAction;expect:NativeCheck[]}>
 model?:{baseURL:string;model:string}
}
const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex')
const digest=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)
const exec=promisify(execFile)
/** macOS agent-desktop detaches a command host from the caller's process group.
 * Only discover it through a socket in THIS run's private TMPDIR. Never search
 * or stop the user's shared adapter host, daemon or other application. */
export async function closeOwnedComputerHosts(home:string,adapterPath:string) {
 if(process.platform!=='darwin')return
 const files=await readdir(home,{recursive:true})
 for(const name of files){
  if(!/^agent-desktop-host-[0-9]+\/[a-f0-9]+\.sock$/.test(name))continue
  const socket=join(home,name),info=await lstat(socket)
  if(!info.isSocket()||info.uid!==process.getuid?.())throw Error('unverified_native_host_socket')
  let pids:string
  try{pids=(await exec('/usr/sbin/lsof',['-t','--',socket],{timeout:400,maxBuffer:4096})).stdout.trim()}
  catch(error:any){if(error.code===1)continue;throw Error('native_host_exit_unconfirmed')}
  for(const value of new Set(pids.split(/\s+/))){
   if(!/^[1-9][0-9]{0,8}$/.test(value))throw Error('unverified_native_host_pid')
   const pid=Number(value)
   const row=(await exec('/bin/ps',['-ww','-p',value,'-o','uid=','-o','command='],{timeout:400,maxBuffer:4096})).stdout.trim()
   const match=row.match(/^([0-9]+)\s+(.*?)$/)
   if(!match||match[2]!==adapterPath||Number(match[1])!==process.getuid?.())throw Error('unverified_native_host_identity')
   const alive=()=>{try{process.kill(pid,0);return true}catch(e:any){if(e.code==='ESRCH')return false;throw e}}
   if(alive())process.kill(pid,'SIGTERM')
   for(let i=0;i<5&&alive();i++)await new Promise(r=>setTimeout(r,20))
   if(alive())process.kill(pid,'SIGKILL')
   for(let i=0;i<10&&alive();i++)await new Promise(r=>setTimeout(r,20))
   if(alive())throw Error('native_host_exit_unconfirmed')
  }
 }
}
async function checkedFile(file:CheckedFile) {
 if(!isAbsolute(file.path)||!digest(file.sha256))throw Error('invalid_computer_artifact')
 const info=await lstat(file.path)
 if(!info.isFile()||info.isSymbolicLink()||info.size>128*1024*1024||sha(await readFile(file.path))!==file.sha256)throw Error('computer_artifact_mismatch')
}
export async function verifyComputerArtifacts(a:ComputerArtifacts) {
 if(!/^[a-f0-9]{40}$/.test(a.coreSource)||!isAbsolute(a.coreDirectory)||await realpath(a.coreDirectory)!==a.coreDirectory)throw Error('invalid_computer_artifact')
 const names=Object.keys(a.files).sort()
 if(!['adapter.js','refs.js','policy.js','loop.js','model.js','package.json'].every(n=>names.includes(n))||names.length>32||names.some(n=>!/^[-a-z]+\.(js|json)$/.test(n)))throw Error('invalid_computer_artifact')
 const actual=(await readdir(a.coreDirectory)).sort()
 if(JSON.stringify(actual)!==JSON.stringify(names))throw Error('computer_artifact_inventory_mismatch')
 for(const name of names)await checkedFile({path:join(a.coreDirectory,name),sha256:a.files[name]})
 await checkedFile(a.node);await checkedFile(a.adapter)
}
function validCheck(c:NativeCheck) {return c&&['enabled','count'].includes(c.kind)&&typeof c.role==='string'&&c.role.length<80&&typeof c.name==='string'&&c.name.length<200&&(c.kind!=='count'||Number.isInteger(c.count)&&c.count!>=0&&c.count!<=10)}
function validAction(a:NativeAction) {return a&&a.command==='click'&&typeof a.role==='string'&&a.role.length<80&&typeof a.name==='string'&&a.name.length<200}
export function validateNativeScope(s:NativeScope,maxSteps:number) {
 if(!s||typeof s.app!=='string'||!s.app||s.app.length>100||!/^w-[0-9]+$/.test(s.window?.id)||!Number.isInteger(s.window.pid)||s.window.pid<=0||!digest(s.window.title_sha256)||
  !Array.isArray(s.actions)||!s.actions.length||s.actions.length>16||!s.actions.every(validAction)||!Array.isArray(s.success)||!s.success.length||s.success.length>8||!s.success.every(validCheck))throw Error('invalid_native_scope')
 if(s.mode==='deterministic_actuator'){
  if(s.model||!Array.isArray(s.steps)||!s.steps.length||s.steps.length>maxSteps||s.steps.some(step=>!validAction(step.action)||!s.actions.some(a=>JSON.stringify(a)===JSON.stringify(step.action))||!Array.isArray(step.expect)||!step.expect.length||step.expect.length>8||!step.expect.every(validCheck)))throw Error('invalid_native_scope')
 }else if(s.mode==='local_model'){
  if(s.steps||!s.model||typeof s.model.model!=='string'||!s.model.model||s.model.model.length>200)throw Error('invalid_native_scope')
  const url=new URL(s.model.baseURL)
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/','/v1','/v1/','/v1/chat/completions'].includes(url.pathname))throw Error('invalid_native_scope')
 }else throw Error('invalid_native_scope')
}
export function createNativeComputerExecutor(input:{artifacts:ComputerArtifacts;resolveScope:(session:ComputerSession)=>Promise<NativeScope|null>}):ComputerExecutor {
 const artifacts=structuredClone(input.artifacts)
 return {
  async ready(){if(process.platform==='win32')return false;try{await verifyComputerArtifacts(artifacts);return true}catch{return false}},
  async run({request,session,signal,stillAuthorized}) {
   if(signal.aborted||!await stillAuthorized())throw Error('computer_cancelled')
   await verifyComputerArtifacts(artifacts)
   const resolved=await input.resolveScope(session)
   if(!resolved)throw Error('native_scope_required')
   const scope=structuredClone(resolved);validateNativeScope(scope,session.max_steps)
   if(signal.aborted||!await stillAuthorized())throw Error('computer_cancelled')
   // Darwin sockaddr_un is short; the normal per-user TMPDIR can exceed it.
   const home=await mkdtemp(join(await realpath(process.platform==='darwin'?'/tmp':tmpdir()),'tarx-cu-'))
   try {
    return await new Promise<ComputerOutcome>((resolve,reject)=>{
     const child=fork(new URL('./tarx-computer-worker.ts',import.meta.url),[],{execPath:artifacts.node.path,execArgv:['--experimental-strip-types'],detached:true,
      cwd:home,env:{HOME:home,TMPDIR:home,PATH:[dirname(artifacts.adapter.path),dirname(artifacts.node.path),'/usr/bin','/bin'].join(':'),LANG:'en_US.UTF-8'},stdio:['ignore','ignore','ignore','ipc']})
     let result:ComputerOutcome|undefined,failure:Error|undefined,failed=false,finished=false,stopping=false,checks=0
     let killTimer:ReturnType<typeof setTimeout>|undefined
     const kill=(signal:NodeJS.Signals)=>{if(child.pid)try{process.kill(-child.pid,signal)}catch(e:any){if(e.code!=='ESRCH')failed=true}}
     const stop=()=>{if(stopping)return;stopping=true;kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),250)}
     const onAbort=()=>stop()
     signal.addEventListener('abort',onAbort,{once:true})
     const deadline=setTimeout(stop,Math.min(session.timeout_ms,Math.max(1,session.expires_at-Date.now())))
     const hard=setTimeout(()=>{stop();kill('SIGKILL');finish(Error('computer_child_exit_unconfirmed'))},Math.min(session.timeout_ms,Math.max(1,session.expires_at-Date.now()))+1000)
     function finish(error?:Error) {
      if(finished)return;finished=true
      clearTimeout(deadline);clearTimeout(hard);if(killTimer)clearTimeout(killTimer)
      signal.removeEventListener('abort',onAbort)
      if(error||failed||!result||stopping)reject(error??failure??Error('computer_child_failed'))
      else resolve(result)
     }
     child.on('error',()=>{failed=true;stop()})
     child.on('message',message=>{
      if(finished||!message||typeof message!=='object')return
      const m=message as {kind?:string;id?:number;result?:ComputerOutcome;phase?:string;code?:string}
      if(m.kind==='authorize'&&Number.isInteger(m.id)&&++checks<=32){
       void stillAuthorized().then(ok=>{if(!ok||signal.aborted){stop();return}if(child.connected)child.send({kind:'authorization',id:m.id,allowed:true})},stop)
      }else if(m.kind==='failure'&&typeof m.phase==='string'&&/^[a-z]{1,20}$/.test(m.phase)&&typeof m.code==='string'&&/^[A-Z_]{1,64}$/.test(m.code)){
       failure=Error('computer_'+m.phase+'_'+m.code);failed=true;stop()
      }else if(m.kind==='result'&&!result){
       // Strictly bounded metadata; core/model/native output never crosses IPC.
       if(JSON.stringify(message).length>1024){failed=true;stop();return}
       result=m.result
      }else {failed=true;stop()}
     })
     child.on('close',(code)=>{
      // Even a successful worker cannot leave a native adapter descendant alive.
      kill('SIGKILL')
      if(code!==0&&!signal.aborted)failed=true
      if(signal.aborted&&!failed){result={outcome:'cancelled',independent_verified:false,native_actions:null,model_calls:null,core_source:artifacts.coreSource,execution_mode:scope.mode};stopping=false}
      finish()
     })
     if(signal.aborted)stop()
     else child.send({kind:'start',artifacts,scope,request:{goal:request.goal,context:request.context},maxSteps:session.max_steps},error=>{if(error){failed=true;stop()}})
    })
   }finally{
    // Preserve the private state if host ownership/exit cannot be confirmed.
    await closeOwnedComputerHosts(home,artifacts.adapter.path)
    await rm(home,{recursive:true,force:true})
   }
  },
 }
}
