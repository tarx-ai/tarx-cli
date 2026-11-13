/** Trusted desktop-host integration. No browser/HTTP input chooses executables,
 * models, windows, success checks or approvals. Each run owns one process group. */
import {resolveCliPrincipal} from './cli-principal.ts'
import {fork,execFile} from 'node:child_process'
import {createHash} from 'node:crypto'
import {lstat,readFile,readdir,realpath,mkdtemp,rm,open} from 'node:fs/promises'
import {constants,type Stats} from 'node:fs'
import {isAbsolute,join,dirname} from 'node:path'
import {tmpdir} from 'node:os'
import {promisify} from 'node:util'
import type {ComputerExecutor,ComputerOutcome,ComputerRequest,ComputerRun,ComputerSession} from './tarx-computer-task.ts'

export type CheckedFile={path:string;sha256:string}
export type ComputerArtifacts={coreSource:string;coreDirectory:string;files:Record<string,string>;node:CheckedFile;adapter:CheckedFile;cursor?:CheckedFile}
export type NativeCheck={kind:'enabled'|'count';role:string;name:string;count?:number}
export type NativeAction={command:'click';role:string;name:string}
export type NativeScope={
 app:string;window:{id:string;pid:number;title_sha256:string};actions:NativeAction[];success:NativeCheck[]
 mode:'local_model'|'supercomputer'|'deterministic_actuator';steps?:Array<{action:NativeAction;expect:NativeCheck[]}>
 model?:{baseURL:string;model:string}
 data_consent?:'goal_and_scoped_controls'
 preparation_model_calls?:number
}
/** An exact native plan approval can satisfy the core's generic click-effect
 * question. Other external effects and consequential risk categories still
 * require their own authority; matching a label alone does not approve them. */
export function approvedNativeScopedClick(scope:Pick<NativeScope,'app'|'actions'>,request:unknown):boolean {
 if(!scope||typeof scope.app!=='string'||!scope.app||!Array.isArray(scope.actions)||!request||typeof request!=='object'||Array.isArray(request))return false
 const r=request as {app?:unknown;action?:{command?:unknown};risk?:{level?:unknown;category?:unknown;why?:unknown};targetRole?:unknown;targetName?:unknown}
 if(r.app!==scope.app||r.action?.command!=='click'||r.risk?.level!=='high'||typeof r.targetRole!=='string'||!r.targetRole||typeof r.targetName!=='string'||!r.targetName||
  !scope.actions.some(action=>action&&action.command==='click'&&action.role===r.targetRole&&action.name===r.targetName))return false
 return r.risk.category==='settings'||r.risk.category==='external'&&r.risk.why==='action effect requires approval'
}
const digest=(s:unknown)=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s)
const TARX_CURSOR_SHA256='1ee0717a18e54e525682077e3f9a8128da08aab2b1059a1f4365cea85769133b'
const exec=promisify(execFile)
const workerEnv=(home:string,a:ComputerArtifacts)=>({HOME:home,TMPDIR:home,PATH:[dirname(a.adapter.path),dirname(a.node.path),'/usr/bin','/bin'].join(':'),LANG:'en_US.UTF-8'})
async function endOwnedCursorSession(home:string,a:ComputerArtifacts,session:string) {
 const {stdout}=await exec(a.adapter.path,['session','end',session],{cwd:home,env:workerEnv(home,a),timeout:1000,maxBuffer:8192})
 if(JSON.parse(stdout).ok!==true)throw Error('native_cursor_exit_unconfirmed')
}
/** macOS agent-desktop detaches a command host from the caller's process group.
 * Only discover it through a socket in THIS run's private TMPDIR. Never search
 * or stop the user's shared adapter host, daemon or other application. */
export async function closeOwnedComputerHosts(home:string,adapterPath:string) {
 if(process.platform!=='darwin')return
 const deadline=Date.now()+4500,closedPids=new Set<number>()
 const remaining=(limit:number)=>{const left=deadline-Date.now();if(left<=0)throw Error('native_host_cleanup_deadline');return Math.min(limit,left)}
 const files=await readdir(home,{recursive:true})
 for(const name of files){
  if(!/^agent-desktop-host-[0-9]+\/[a-f0-9]+\.sock$/.test(name))continue
  const socket=join(home,name),info=await lstat(socket)
  if(!info.isSocket()||info.uid!==process.getuid?.())throw Error('unverified_native_host_socket')
  let pids:string
  try{pids=(await exec('/usr/sbin/lsof',['-t','--',socket],{timeout:remaining(2000),maxBuffer:4096})).stdout.trim()}
  catch(error:any){if(error.code===1)continue;throw Error('native_host_lookup_unconfirmed')}
  for(const value of new Set(pids.split(/\s+/))){
   if(!/^[1-9][0-9]{0,8}$/.test(value))throw Error('unverified_native_host_pid')
   const pid=Number(value)
   if(closedPids.has(pid))continue
   const row=(await exec('/bin/ps',['-ww','-p',value,'-o','uid=','-o','command='],{timeout:remaining(1000),maxBuffer:4096})).stdout.trim()
   const match=row.match(/^([0-9]+)\s+(.*?)$/)
   if(!match||match[2]!==adapterPath||Number(match[1])!==process.getuid?.())throw Error('unverified_native_host_identity')
   const alive=()=>{try{process.kill(pid,0);return true}catch(e:any){if(e.code==='ESRCH')return false;throw e}}
   if(alive())process.kill(pid,'SIGTERM')
   for(let i=0;i<5&&alive();i++)await new Promise(r=>setTimeout(r,20))
   if(alive())process.kill(pid,'SIGKILL')
   for(let i=0;i<10&&alive();i++)await new Promise(r=>setTimeout(r,20))
   if(alive())throw Error('native_host_exit_unconfirmed')
   closedPids.add(pid)
  }
 }
}
// Node's official macOS distribution exceeds 128 MiB. Keep its allowance
// separate from modules/adapters and stream hashes instead of allocating binaries.
const ARTIFACT_LIMIT=128*1024*1024
const NODE_ARTIFACT_LIMIT=256*1024*1024
const sameFile=(a:Stats,b:Stats)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs
async function checkedFile(file:CheckedFile,limit=ARTIFACT_LIMIT) {
 if(!isAbsolute(file.path)||!digest(file.sha256))throw Error('invalid_computer_artifact')
 const info=await lstat(file.path)
 if(!info.isFile()||info.isSymbolicLink()||info.size<1||info.size>limit)throw Error('computer_artifact_mismatch')
 const handle=await open(file.path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK)
 try{
  const before=await handle.stat()
  if(!before.isFile()||!sameFile(before,info))throw Error('computer_artifact_mismatch')
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(64*1024);let size=0
  for(;;){
   const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,limit-size+1),null)
   if(bytesRead===0)break
   size+=bytesRead;if(size>limit)throw Error('computer_artifact_mismatch')
   hash.update(buffer.subarray(0,bytesRead))
  }
  const after=await handle.stat(),current=await lstat(file.path)
  if(size!==before.size||hash.digest('hex')!==file.sha256||!sameFile(before,after)||
   !current.isFile()||current.isSymbolicLink()||!sameFile(before,current))throw Error('computer_artifact_mismatch')
 }finally{await handle.close()}
}
export async function verifyComputerArtifacts(a:ComputerArtifacts) {
 if(!/^[a-f0-9]{40}$/.test(a.coreSource)||!isAbsolute(a.coreDirectory)||await realpath(a.coreDirectory)!==a.coreDirectory)throw Error('invalid_computer_artifact')
 const names=Object.keys(a.files).sort()
 if(!['adapter.js','refs.js','policy.js','loop.js','model.js','package.json'].every(n=>names.includes(n))||names.length>32||names.some(n=>!/^[-a-z]+\.(js|json)$/.test(n)))throw Error('invalid_computer_artifact')
 const actual=(await readdir(a.coreDirectory)).sort()
 if(JSON.stringify(actual)!==JSON.stringify(names))throw Error('computer_artifact_inventory_mismatch')
 for(const name of names)await checkedFile({path:join(a.coreDirectory,name),sha256:a.files[name]})
 await checkedFile(a.node,NODE_ARTIFACT_LIMIT);await checkedFile(a.adapter)
 if(a.cursor){
  if(a.cursor.sha256!==TARX_CURSOR_SHA256)throw Error('unapproved_native_cursor')
  await checkedFile(a.cursor)
  const png=await readFile(a.cursor.path)
  if(png.length>2*1024*1024||png.length<33||png.subarray(0,8).toString('hex')!=='89504e470d0a1a0a'||png.subarray(12,16).toString()!=='IHDR'||png.readUInt32BE(16)!==32||png.readUInt32BE(20)!==32)throw Error('invalid_native_cursor')
 }
}
function validCheck(c:NativeCheck) {return c&&['enabled','count'].includes(c.kind)&&typeof c.role==='string'&&c.role.length<80&&typeof c.name==='string'&&c.name.length<200&&(c.kind!=='count'||Number.isInteger(c.count)&&c.count!>=0&&c.count!<=10)}
function validAction(a:NativeAction) {return a&&a.command==='click'&&typeof a.role==='string'&&a.role.length<80&&typeof a.name==='string'&&a.name.length<200}
export function validateNativeScope(s:NativeScope,maxSteps:number) {
 if(s?.preparation_model_calls!==undefined&&(!['local_model','supercomputer'].includes(s.mode)||s.preparation_model_calls!==1))throw Error('invalid_native_scope')
 if(!s||typeof s.app!=='string'||!s.app||s.app.length>100||!/^w-[0-9]+$/.test(s.window?.id)||!Number.isInteger(s.window.pid)||s.window.pid<=0||!digest(s.window.title_sha256)||
  !Array.isArray(s.actions)||!s.actions.length||s.actions.length>16||!s.actions.every(validAction)||!Array.isArray(s.success)||!s.success.length||s.success.length>8||!s.success.every(validCheck))throw Error('invalid_native_scope')
 if(s.mode!=='supercomputer'&&s.data_consent!==undefined)throw Error('invalid_native_scope')
 if(s.mode==='deterministic_actuator'){
  if(s.model||!Array.isArray(s.steps)||!s.steps.length||s.steps.length>maxSteps||s.steps.some(step=>!validAction(step.action)||!s.actions.some(a=>JSON.stringify(a)===JSON.stringify(step.action))||!Array.isArray(step.expect)||!step.expect.length||step.expect.length>8||!step.expect.every(validCheck)))throw Error('invalid_native_scope')
 }else if(s.mode==='local_model'){
  if(s.steps||!s.model||typeof s.model.model!=='string'||!s.model.model||s.model.model.length>200)throw Error('invalid_native_scope')
  const url=new URL(s.model.baseURL)
  if(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password||url.search||url.hash||!['','/','/v1','/v1/','/v1/chat/completions'].includes(url.pathname))throw Error('invalid_native_scope')
 }else if(s.mode==='supercomputer'){
  if(Object.keys(s.window).sort().join(',')!=='id,pid,title_sha256'||s.actions.some(action=>Object.keys(action).sort().join(',')!=='command,name,role')||s.success.some(check=>Object.keys(check).sort().join(',')!==(check.kind==='count'?'count,kind,name,role':'kind,name,role')))throw Error('invalid_native_scope')
  if(s.steps!==undefined||s.model!==undefined||s.data_consent!=='goal_and_scoped_controls'||Object.keys(s).some(key=>!['app','window','actions','success','mode','data_consent','preparation_model_calls'].includes(key)))throw Error('invalid_native_scope')
 }else throw Error('invalid_native_scope')
}
export type VerifiedAccountAccess={token:string;subject_id:string}
/** Native owner only: use the existing introspector on the SAME loaded token.
 * No channel text, history or observation enters this identity-only read. */
export async function resolveNativeAccountAccess(input:{subject_id:string;loadCredential:()=>Promise<string>;fetcher?:typeof fetch;signal:AbortSignal}):Promise<VerifiedAccountAccess|null>{
 try{
  if(!(input.signal instanceof AbortSignal)||input.signal.aborted)return null
  if(!/^tvs_[a-f0-9]{32}$/.test(input.subject_id))return null
  const token=(await input.loadCredential()).trim()
  const principal=await resolveCliPrincipal({loadCredential:async()=>token,fetcher:input.fetcher,signal:input.signal})
  return principal.ok&&principal.subject_id===input.subject_id?{token,subject_id:principal.subject_id}:null
 }catch{return null}
}
export type NativeAccountAccess=(run:Omit<ComputerRun,'request'>)=>Promise<VerifiedAccountAccess|null>
export function createNativeComputerExecutor(input:{resolveAccountAccess?:NativeAccountAccess;artifacts:ComputerArtifacts;resolveScope:(session:ComputerSession,request?:ComputerRequest)=>Promise<NativeScope|null>;onCursorState?:(rendered:boolean)=>void;onOutcome?:(outcome:ComputerOutcome,requestId:string)=>void}):ComputerExecutor {
 const artifacts=structuredClone(input.artifacts)
 async function launch(observe:boolean,{request,session,signal,stillAuthorized}:ComputerRun):Promise<ComputerOutcome> {
   if(signal.aborted||!await stillAuthorized())throw Error('computer_cancelled')
   await verifyComputerArtifacts(artifacts)
   const resolved=await input.resolveScope(session,request)
   if(!resolved)throw Error('native_scope_required')
   const scope=structuredClone(resolved);validateNativeScope(scope,session.max_steps)
   if(signal.aborted||!await stillAuthorized())throw Error('computer_cancelled')
   // Credential never enters the scope, grant, ledger, environment or receipt.
   // Recovery is observation-only and must not load a credential or call a model.
   let accountToken:string|undefined
   if(scope.mode==='supercomputer'&&!observe){
    if(typeof input.resolveAccountAccess!=='function')throw Error('native_account_access_required')
    let timer:ReturnType<typeof setTimeout>|undefined
    const accessAbort=new AbortController(),accessSignal=AbortSignal.any([signal,accessAbort.signal])
    try{
     const resolved=await Promise.race([Promise.resolve().then(()=>input.resolveAccountAccess!({session:structuredClone(session),signal:accessSignal,stillAuthorized})),new Promise<null>(resolve=>{timer=setTimeout(()=>{accessAbort.abort();resolve(null)},Math.max(1,Math.min(6000,session.timeout_ms,session.expires_at-Date.now())))})])
     if(!resolved||Object.keys(resolved).sort().join(',')!=='subject_id,token'||resolved.subject_id!==session.subject_id||typeof resolved.token!=='string'||!/^tarx_cli_[0-9a-f]{64}$/.test(resolved.token))throw Error('native_account_access_required')
     accountToken=resolved.token
    }finally{clearTimeout(timer);accessAbort.abort()}
    if(signal.aborted||!await stillAuthorized())throw Error('computer_cancelled')
   }
   // Darwin sockaddr_un is short; the normal per-user TMPDIR can exceed it.
   const home=await mkdtemp(join(await realpath(process.platform==='darwin'?'/tmp':tmpdir()),'tarx-cu-'))
   let nativeSession:string|undefined
   try {
    return await new Promise<ComputerOutcome>((resolve,reject)=>{
     const child=fork(new URL('./tarx-computer-worker.ts',import.meta.url),[],{execPath:artifacts.node.path,execArgv:['--experimental-strip-types'],detached:true,
      cwd:home,env:workerEnv(home,artifacts),stdio:['ignore','ignore','ignore','ipc']})
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
      const m=message as {kind?:string;id?:number;result?:ComputerOutcome;phase?:string;code?:string;session?:string;rendered?:boolean}
      // Stop fences late outcomes/presentation; retain session identity for owned cleanup.
      if(signal.aborted&&m.kind!=='native_session')return
      if(m.kind==='authorize'&&Number.isInteger(m.id)&&++checks<=32){
       void stillAuthorized().then(ok=>{if(!ok||signal.aborted){stop();return}if(child.connected)child.send({kind:'authorization',id:m.id,allowed:true})},stop)
      }else if(m.kind==='native_session'&&!nativeSession&&artifacts.cursor&&typeof m.session==='string'&&/^[A-Za-z0-9_-]{1,100}$/.test(m.session)){
       nativeSession=m.session
      }else if(m.kind==='native_cursor'&&nativeSession&&m.rendered===true){
       try{input.onCursorState?.(true)}catch{/* Presentation cannot grant execution. */}
      }else if(m.kind==='failure'&&typeof m.phase==='string'&&/^[a-z]{1,20}$/.test(m.phase)&&typeof m.code==='string'&&/^[A-Z_]{1,64}$/.test(m.code)){
       failure=Error('computer_'+m.phase+'_'+m.code);failed=true;stop()
      }else if(m.kind==='result'&&!result){
       // Strictly bounded metadata; core/model/native output never crosses IPC.
       if(JSON.stringify(message).length>1024){failed=true;stop();return}
       result=m.result
       if(result)try{input.onOutcome?.(result,request.request_id)}catch{/* Diagnostics cannot grant execution or complete a task. */}
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
     else child.send({kind:'start',observe,artifacts,scope,request:{goal:request.goal,...(scope.mode==='supercomputer'?{}:{context:request.context})},maxSteps:session.max_steps,...(accountToken?{accountToken}:{})},error=>{if(error){failed=true;stop()}})
    })
   }finally{
    // Preserve the private state if host ownership/exit cannot be confirmed.
    let cleanupError:unknown
    try{if(nativeSession)await endOwnedCursorSession(home,artifacts,nativeSession)}catch(error){cleanupError=error}
    try{await closeOwnedComputerHosts(home,artifacts.adapter.path)}catch(error){cleanupError??=error}
    if(cleanupError)throw cleanupError
    try{input.onCursorState?.(false)}catch{}
    await rm(home,{recursive:true,force:true})
   }
 }
 return {
  shutdownGraceMs:6000,
  async ready(){if(process.platform==='win32')return false;try{await verifyComputerArtifacts(artifacts);return true}catch{return false}},
  run:(params:ComputerRun)=>launch(false,params),
  /** Read-only recovery. Verifies the consented window and does not click. */
  observe:(params:ComputerRun)=>launch(true,params),
 }
}
