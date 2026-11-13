/** Bounded classification of the core loop's returned result. */
const failureCodes = new Set(['NATIVE_TASK_FAILED','native_action_out_of_scope','native_target_ambiguous','native_step_unverified','native_identity_or_approval_changed','native_session_unavailable','unknown','UNKNOWN','AMBIGUOUS_TARGET','ACTION_FAILED','NOT_FOUND','TIMEOUT'])
const stageFor = (code:string) => /ADAPTER|ACTION|AMBIGUOUS|NOT_FOUND|TIMEOUT/i.test(code) ? 'adapter' as const : 'verification' as const
export function returnedFailure(result:any) {
 if(!result||result.outcome==='done')return undefined
 const steps=Array.isArray(result.steps)?result.steps:[]
 for(let i=steps.length-1;i>=0;i--){
  const step=steps[i]
  if(step?.result==='error'&&typeof step.errorCode==='string'){
   const code=failureCodes.has(step.errorCode)?step.errorCode:'unknown'
   return {failure_stage:'adapter' as const,failure_code:code}
  }
  // Planner actions force expect.kind 'none'; the core reports observed_only
  // and that is not a failed action postcondition. Only a real check failure is.
  if(step?.verification&&step.verification.passed===false&&step.verification.check!=='observed_only')return {failure_stage:'verification' as const,failure_code:'native_step_unverified'}
 }
 return {failure_stage:stageFor(String(result.outcome??'')),failure_code:result.outcome==='max_steps'?'max_steps':'unverified'}
}

