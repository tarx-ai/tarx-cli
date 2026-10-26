#!/usr/bin/env node
/** Opt-in local command entry. No worker/model startup or host registration. */
import {readFile,writeFile,mkdir,open} from 'node:fs/promises'
import {join,resolve} from 'node:path'
import {homedir} from 'node:os'
import {randomBytes,createHash} from 'node:crypto'
import {createRequire} from 'node:module'
import {pathToFileURL} from 'node:url'
import {createFilePairStore,createPairingChallenge,approvePairingChallenge,revokePairing} from './tarx-browser-pairing.ts'
import {createPairedSessionListener} from './tarx-runtime-http.ts'
import {createFileOwnerStore} from './tarx-eve-listener.ts'

export async function installIdentity(stateDir:string):Promise<string>{
 await mkdir(stateDir,{recursive:true,mode:0o700})
 const file=join(stateDir,'install-id')
 try{const h=await open(file,'wx',0o600);try{await h.writeFile('install_'+randomBytes(24).toString('hex'))}finally{await h.close()}}
 catch(e:any){if(e.code!=='EEXIST')throw e}
 const id=(await readFile(file,'utf8')).trim()
 if(!/^install_[a-f0-9]{48}$/.test(id))throw Error('invalid_install_identity')
 return id
}
function localURL(value:string){const u=new URL(value);if(u.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||u.pathname!=='/')throw Error('loopback_worker_required');return u.origin}
export async function runRuntimeEntry(args:string[],testDeps:{fetcher?:typeof fetch;clientFactory?:(url:string)=>any}={}){
 const command=args[0]??'help',options:Record<string,string>={}
 for(let i=1;i<args.length;i+=2){if(!/^--(state-dir|credential-file|eve-root|worker-url|port|challenge)$/.test(args[i])||!args[i+1]||args[i+1].startsWith('--'))throw Error('invalid_arguments');options[args[i].slice(2)]=args[i+1]}
 if(command==='help')return {command:'runtime',commands:['challenge','approve','revoke','serve'],requires:'Node >=24 and pinned Eve 0.83.2 for serve; no service or worker installed'}
 if(!['challenge','approve','revoke','serve'].includes(command))throw Error('unknown_command')
 const state=resolve(options['state-dir']??join(homedir(),'.tarx','state','eve'))
 const store=createFilePairStore(join(state,'pairs.json'))
 if(command==='challenge'){
  const install_id=await installIdentity(state)
  const credentialFile=resolve(options['credential-file']??join(homedir(),'.tarx','state','chat-key'))
  return createPairingChallenge({loadCredential:()=>readFile(credentialFile,'utf8'),install_id,store,fetcher:testDeps.fetcher})
 }
 if(command==='approve'||command==='revoke'){
  const challenge=options.challenge??'';if(!/^[a-f0-9]{64}$/.test(challenge))throw Error('invalid_challenge')
  if(command==='approve')return {ok:await approvePairingChallenge(challenge,store)}
  await revokePairing(createHash('sha256').update(challenge).digest('hex'),store);return {ok:true}
 }
 if(Number(process.versions.node.split('.')[0])<24)throw Error('node_24_required')
 if(!options['worker-url'])throw Error('existing_worker_required')
 const workerURL=localURL(options['worker-url'])
 const port=Number(options.port??3270);if(!Number.isInteger(port)||port<0||port>65535)throw Error('invalid_port')
 let client:any
 if(testDeps.clientFactory)client=testDeps.clientFactory(workerURL)
 else{
  if(!options['eve-root'])throw Error('pinned_eve_package_required')
  const root=resolve(options['eve-root']),require=createRequire(join(root,'package.json'))
  const packageFile=require.resolve('eve/package.json')
  if(JSON.parse(await readFile(packageFile,'utf8')).version!=='0.83.2')throw Error('eve_version_mismatch')
  const {Client}=await import(pathToFileURL(require.resolve('eve/client')).href)
  client=new Client({host:workerURL})
 }
 const listener=createPairedSessionListener({host:'127.0.0.1',port,allowedOrigins:new Set(['https://tarx.com','https://www.tarx.com']),pairStore:store,ownerStore:createFileOwnerStore(join(state,'owners.json')),eveClient:()=>({attach:(id:string)=>client.sessions.attach(id)}),readiness:async()=>{
  let reachable=false
  let timeout:ReturnType<typeof setTimeout>|undefined
  try{const h=await Promise.race([client.health(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('health_timeout')),1500)})]);reachable=h?.ok===true&&h?.status==='ready'}catch{}finally{if(timeout)clearTimeout(timeout)}
  // A worker health reply is not model inference or tool discovery.
  return {config_valid:true,worker_reachable:reachable,model_responsive:false,tools:[],healthy:false}
 }})
 const address=await listener.listen()
 return {listener,address}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  const result=await runRuntimeEntry(process.argv.slice(2))
  if('listener' in result){console.log(JSON.stringify({listening:result.address,mode:'paired_read_attach',task_submission:false}));for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{void result.listener.close().then(()=>process.exit(0))})}
  else {console.log(JSON.stringify(result));if('ok' in result&&result.ok===false)process.exitCode=1}
 }catch{console.error(JSON.stringify({ok:false,error:'runtime_command_failed',hint:'Check command arguments, saved CLI sign-in and pinned runtime dependencies.'}));process.exitCode=1}
}
