/** Server/local-CLI only. Never send the saved CLI credential to browser JS.
 * Reuses TARX's existing authority; makes no local account/grant or spend event.
 */
const STABLE=/^tvs_[0-9a-f]{32}$/
export type CliPrincipalResult = {ok:true;subject_id:string}|{ok:false;error:'missing_credential'|'identity_unavailable'|'identity_unverified'}
export async function resolveCliPrincipal(input:{loadCredential:()=>Promise<string>;fetcher?:typeof fetch}):Promise<CliPrincipalResult>{
 let token:string
 try {token=await input.loadCredential()} catch {return {ok:false,error:'missing_credential'}}
 if(typeof token!=='string'||!/^tarx_cli_[0-9a-f]{64}$/.test(token.trim()))return {ok:false,error:'missing_credential'}
 try {
  const response=await(input.fetcher??fetch)('https://tarx.com/api/auth/cli/introspect',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({token:token.trim(),spend:false}),redirect:'error',signal:AbortSignal.timeout(3000)})
  if(!response.ok)return {ok:false,error:'identity_unverified'}
  const body=await response.json()
  if(body?.ok!==true||typeof body.subject_id!=='string'||!STABLE.test(body.subject_id))return {ok:false,error:'identity_unverified'}
  return {ok:true,subject_id:body.subject_id}
 }catch{return {ok:false,error:'identity_unavailable'}}
}
