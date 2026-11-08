/** Host-supplied computer consent. The caller provides the session id.
 * This module never mints one. Pairing is not a grant. */
import {createComputerTaskController,computerIntentHash,COMPUTER_TASK,type ComputerAuthority,type ComputerSession,type ComputerSubmission} from './tarx-computer-task.ts'
import {createNativeComputerExecutor,validateNativeScope,type ComputerArtifacts,type NativeAction,type NativeScope} from './tarx-computer-executor.ts'
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
export function connectComputerHost(input:{file:string;coreSource:string;artifacts:ComputerArtifacts;consent:ReturnType<typeof createComputerHostConsent>}){
 return createComputerTaskController({file:input.file,coreSource:input.coreSource,authority:input.consent.authority,executor:createNativeComputerExecutor({artifacts:input.artifacts,resolveScope:(session,request)=>input.consent.resolveScope(session,request)})})
}
