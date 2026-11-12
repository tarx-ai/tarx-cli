/** Host computer consent. grant stores a session. issueNativeHostGrant creates
 * one only after the native artifacts verify, then stores it here. Pairing is
 * not a grant. A runtime that cannot verify those artifacts does not issue. */
import {randomBytes} from 'node:crypto'
import {createComputerTaskController,computerIntentHash,parseComputerRequest,COMPUTER_TASK,type ComputerAuthority,type ComputerRequest,type ComputerSession,type ComputerSubmission,type PrepareBrowserTask} from './tarx-computer-task.ts'
import {createNativeComputerExecutor,validateNativeScope,verifyComputerArtifacts,type ComputerArtifacts,type NativeAction,type NativeScope,type NativeAccountAccess} from './tarx-computer-executor.ts'
import {pairingCredentialTaskAccess,type PairStore} from './tarx-browser-pairing.ts'
const opaque=(s:unknown)=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(s)
const agentOk=(s:unknown)=>typeof s==='string'&&(String(s).includes(':')?/^channel-agent:[A-Za-z0-9-]{1,128}$/.test(String(s)):opaque(s))
export type ComputerHostGrant={request_id:string;actions:NativeAction[];session:ComputerSession;scope:NativeScope}
export function createComputerHostConsent(now:()=>number=Date.now){
 const grants=new Map<string,ComputerHostGrant>()
 const live=(sessionId:string)=>{const grant=grants.get(sessionId);return grant&&now()<grant.session.expires_at?grant:null}
 return {
  grant(value:ComputerHostGrant){
   const session=value?.session
   if(!session||!/^[A-Za-z0-9_-]{8,80}$/.test(value.request_id)||!/^wrun_[0-9A-Z]{20,32}$/.test(session.session_id)||
    !/^tvs_[a-f0-9]{32}$/.test(session.subject_id)||!opaque(session.install_id)||!opaque(session.channel_id)||!agentOk(session.agent_id)||
    !/^[a-f0-9]{64}$/.test(session.intent_sha256)||!Number.isFinite(session.expires_at)||now()>=session.expires_at||
    !Number.isInteger(session.max_steps)||session.max_steps<1||session.max_steps>8||!Number.isInteger(session.timeout_ms)||session.timeout_ms<1||session.timeout_ms>45000||
    !Array.isArray(value.actions)||!value.actions.length||JSON.stringify(value.actions)!==JSON.stringify(value.scope?.actions))throw Error('invalid_computer_consent')
   validateNativeScope(value.scope,session.max_steps)
   grants.set(session.session_id,structuredClone(value))
  },
  revoke(sessionId:string){grants.delete(sessionId)},
  authority:{
   async resolve(sessionId:string){const grant=live(sessionId);return grant?structuredClone(grant.session):null},
   async bind(request:ComputerSubmission){
    const matches=[...grants.values()].filter(grant=>live(grant.session.session_id)&&grant.request_id===request.request_id&&grant.session.channel_id===request.channel_id&&grant.session.agent_id===request.agent_id)
    if(matches.length!==1)return null
    const grant=matches[0]!
    if(computerIntentHash({...request,task:COMPUTER_TASK,session_id:grant.session.session_id})!==grant.session.intent_sha256)return null
    return structuredClone(grant.session)
   },
  } satisfies ComputerAuthority,
  async resolveScope(session:ComputerSession,request?:{request_id?:string}){
   const grant=live(session.session_id)
   if(!grant||grant.request_id!==(request?.request_id??grant.request_id)||grant.session.channel_id!==session.channel_id||grant.session.agent_id!==session.agent_id||
    grant.session.subject_id!==session.subject_id||grant.session.install_id!==session.install_id||grant.session.intent_sha256!==session.intent_sha256||
    JSON.stringify(grant.scope.actions)!==JSON.stringify(grant.actions))return null
   return structuredClone(grant.scope)
  },
 }
}
const hostAlphabet='0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
function newHostSessionId(){
 let suffix=''
 for(const byte of randomBytes(26))suffix+=hostAlphabet[byte%36]
 return 'wrun_'+suffix
}
export type NativeHostGrant={
 artifacts:ComputerArtifacts
 consent:ReturnType<typeof createComputerHostConsent>
 request:{request_id:string;channel_id:string;agent_id:string;goal:string;context?:string}
 subject_id:string
 install_id:string
 actions:NativeAction[]
 scope:NativeScope
 expires_at:number
 max_steps:number
 timeout_ms:number
 stillAuthorized?:()=>boolean|Promise<boolean>
}

async function preparationRead<T>(run:()=>Promise<T>,signal:AbortSignal):Promise<T>{
 if(signal.aborted)throw Error('native_preparation_cancelled')
 let stop=()=>{}
 try{return await Promise.race([Promise.resolve().then(run),new Promise<never>((_,reject)=>{
  stop=()=>reject(Error('native_preparation_cancelled'));signal.addEventListener('abort',stop,{once:true})
 })])}finally{signal.removeEventListener('abort',stop)}
}
async function currentHostAuthority(check:()=>boolean|Promise<boolean>){
 let timer:ReturnType<typeof setTimeout>|undefined
 try{return await Promise.race([Promise.resolve().then(check),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),1000)})])===true}
 catch{return false}finally{clearTimeout(timer)}
}

/** Native-only preparation. The task is untrusted data; scope/artifacts/limits
 * are supplied by the native owner. Nothing listens, grants or executes here. */
export async function prepareNativeHostTask(input:{
 pairStore:PairStore;pairingCredential:string;task:unknown;artifacts:ComputerArtifacts
 resolveScope:(request:Readonly<ComputerSubmission>)=>NativeScope|Promise<NativeScope>
 expires_at:number;max_steps:number;timeout_ms:number;now?:()=>number;signal?:AbortSignal
}):Promise<{state:'prepared';execution_authorized:false;grant:Omit<NativeHostGrant,'consent'>}|null>{
 try{
  if(!input||typeof input!=='object'||Object.keys(input).some(key=>!['pairStore','pairingCredential','task','artifacts','resolveScope','expires_at','max_steps','timeout_ms','now','signal'].includes(key)))return null
  const {pairStore,pairingCredential,resolveScope,expires_at,max_steps,timeout_ms,signal:cancel}=input,now=input.now??Date.now
  const signal=AbortSignal.any([AbortSignal.timeout(10000),...(cancel?[cancel]:[])])
  const raw=structuredClone(input.task)
  if(!raw||typeof raw!=='object'||Array.isArray(raw)||'session_id' in raw)return null
  const parsed=parseComputerRequest(raw)
  if(!parsed||typeof resolveScope!=='function'||typeof now!=='function')return null
  const started=now(),artifacts=structuredClone(input.artifacts)
  if(!Number.isFinite(started)||!Number.isFinite(expires_at)||expires_at<=started||expires_at>started+600000||
     !Number.isInteger(max_steps)||max_steps<1||max_steps>8||!Number.isInteger(timeout_ms)||timeout_ms<1||timeout_ms>45000)return null
  const first=await preparationRead(()=>pairingCredentialTaskAccess(pairingCredential,pairStore,now),signal)
  if(!first||!first.task_scopes.includes(COMPUTER_TASK)||!opaque(first.install_id))return null
  const subject_id=first.subject_id,install_id=first.install_id
  const stillAuthorized=async()=>{
   try{
    const fresh=await pairingCredentialTaskAccess(pairingCredential,pairStore,now)
    return !cancel?.aborted&&now()<expires_at&&Boolean(fresh&&fresh.subject_id===subject_id&&fresh.install_id===install_id&&fresh.task_scopes.includes(COMPUTER_TASK))
   }catch{return false}
  }
  await preparationRead(()=>verifyComputerArtifacts(artifacts),signal)
  const request={request_id:'nhr_'+randomBytes(16).toString('hex'),channel_id:parsed.channel_id,agent_id:parsed.agent_id,goal:parsed.goal,...(parsed.context!==undefined?{context:parsed.context}:{})}
  const scope=structuredClone(await preparationRead(async()=>resolveScope(Object.freeze({...request,task:COMPUTER_TASK})),signal))
  validateNativeScope(scope,max_steps)
  if(!await preparationRead(stillAuthorized,signal))return null
  return {state:'prepared',execution_authorized:false,grant:{artifacts,request,subject_id,install_id,
   actions:structuredClone(scope.actions),scope,expires_at,max_steps,timeout_ms,stillAuthorized}}
 }catch{return null}
}

/** User consent on a native host. The session id is random. It is not derived
 * from a machine install, user, or pairing credential. */
export async function issueNativeHostGrant(input:NativeHostGrant):Promise<ComputerSession|null>{
 if(!input||typeof input!=='object')return null
 const {consent,stillAuthorized}=input
 let saved:Omit<NativeHostGrant,'consent'|'stillAuthorized'>
 try{
  saved=structuredClone({artifacts:input.artifacts,request:{request_id:input.request.request_id,channel_id:input.request.channel_id,agent_id:input.request.agent_id,goal:input.request.goal,context:input.request.context},subject_id:input.subject_id,install_id:input.install_id,
   actions:input.actions,scope:input.scope,expires_at:input.expires_at,max_steps:input.max_steps,timeout_ms:input.timeout_ms})
  if(stillAuthorized&&!await currentHostAuthority(stillAuthorized))return null
  await verifyComputerArtifacts(saved.artifacts)
  if(stillAuthorized&&!await currentHostAuthority(stillAuthorized))return null
 }catch{return null}
 const session_id=newHostSessionId()
 const request:ComputerRequest={task:COMPUTER_TASK,session_id,...saved.request}
 const session:ComputerSession={session_id,subject_id:saved.subject_id,install_id:saved.install_id,channel_id:request.channel_id,agent_id:request.agent_id,intent_sha256:computerIntentHash(request),expires_at:saved.expires_at,max_steps:saved.max_steps,timeout_ms:saved.timeout_ms}
 consent.grant({request_id:request.request_id,actions:saved.actions,session,scope:saved.scope})
 return consent.authority.resolve(session_id)
}
export function connectComputerHost(input:{resolveAccountAccess?:NativeAccountAccess;prepareBrowser?:PrepareBrowserTask;file:string;coreSource:string;artifacts:ComputerArtifacts;consent:ReturnType<typeof createComputerHostConsent>}){
 return createComputerTaskController({file:input.file,coreSource:input.coreSource,authority:input.consent.authority,prepareBrowser:input.prepareBrowser,executor:createNativeComputerExecutor({artifacts:input.artifacts,resolveAccountAccess:input.resolveAccountAccess,resolveScope:(session,request)=>input.consent.resolveScope(session,request)})})
}
