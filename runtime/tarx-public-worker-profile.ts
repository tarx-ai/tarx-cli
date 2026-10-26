import {mkdir,writeFile,readFile,readdir,lstat} from 'node:fs/promises'
import {join} from 'node:path'
import {PUBLIC_NOTE} from './tarx-bounded-task.ts'

/** Materializes only into a NEW directory. No credentials in authored files.
 * The operator supplies a worker-only token to its child process explicitly. */
export async function createPublicWorkerProfile(root:string,modelBaseURL:string,modelId:string){
 const url=new URL(modelBaseURL)
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash)throw Error('loopback_model_required')
 if(!modelId||modelId.length>120)throw Error('invalid_model')
 const files:Record<string,string>={
 'package.json':JSON.stringify({name:'tarx-public-note-worker',private:true,type:'module',dependencies:{eve:'0.83.2',ai:'7.0.153','@ai-sdk/openai-compatible':'3.0.78',zod:'4.6.7'}})+'\n',
 'agent/agent.ts':`import {defineAgent} from 'eve'\nimport {createOpenAICompatible} from '@ai-sdk/openai-compatible'\nconst provider=createOpenAICompatible({name:'tarx-scoped',baseURL:${JSON.stringify(url.href)}})\nexport default defineAgent({model:provider(${JSON.stringify(modelId)}),modelContextWindowTokens:32768,defaultTools:false,tool:false})\n`,
 'agent/sandbox.ts':"import {defineSandbox,DefaultSandbox} from 'eve/sandbox'\nexport const environment=DefaultSandbox.environment({justBash:{autoInstall:false}})\nexport default defineSandbox(()=>{throw new Error('sandbox_unavailable_for_public_note')})\n",
 'agent/instructions.md':'Read the public note with read_launch_note exactly once when asked. Report its result. Do not delegate.\n',
 'agent/tools/read_launch_note.ts':`import {defineTool} from 'eve/tools'\nimport {z} from 'zod'\nexport default defineTool({description:'Read the fixed public tool-check note.',inputSchema:z.object({}).strict(),async execute(){return {text:${JSON.stringify(PUBLIC_NOTE)},source:'fixture',privateContext:false}}})\n`,
 'agent/channels/eve.ts':`import {eveChannel} from 'eve/channels/eve'\nimport {timingSafeEqual} from 'node:crypto'\nimport type {AuthFn} from 'eve/channels/auth'\nconst auth:AuthFn<Request>=async request=>{\n const token=process.env.TARX_WORKER_TOKEN\n if(!token||! /^[a-f0-9]{64}$/.test(token))return null\n const actual=Buffer.from(request.headers.get('authorization')??'')\n const expected=Buffer.from('Bearer '+token)\n if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return null\n return {authenticator:'tarx-worker',principalId:'tarx-local-bridge',principalType:'user'}\n}\nexport default eveChannel({auth:[auth]})\n`,
 }
 await mkdir(root,{mode:0o700})
 for(const [path,content]of Object.entries(files)){await mkdir(join(root,path,'..'),{recursive:true});await writeFile(join(root,path),content,{mode:0o600,flag:'wx'})}
 async function verify(){
  try{
   async function walk(path:string):Promise<string[]>{const found:string[]=[];for(const name of await readdir(join(root,path))){const relative=path?path+'/'+name:name;const stat=await lstat(join(root,relative));if(stat.isSymbolicLink())throw Error('profile_symlink');if(stat.isDirectory())found.push(...await walk(relative));else found.push(relative)}return found}
   const roots=await readdir(root)
   if(roots.some(name=>!['agent','package.json','node_modules','.eve'].includes(name)))return false
   const actual=(await walk('agent')).sort(),expected=Object.keys(files).filter(p=>p.startsWith('agent/')).sort()
   if(JSON.stringify(actual)!==JSON.stringify(expected))return false
   for(const [path,content]of Object.entries(files)){if((await lstat(join(root,path))).isSymbolicLink()||await readFile(join(root,path),'utf8')!==content)return false}
   return true
  }catch{return false}
 }
 return {verify}
}
