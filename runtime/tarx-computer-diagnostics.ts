/** Bounded, local-only evidence about one native action.
 * Labels are classified, never copied. Counts describe only browser-pane
 * controls. Nothing here can grant execution, verify a task or reach a receipt. */
export type ControlCategory = 'browser_open'|'browser_close'|'button'|'menu_item'|'text_field'|'other'
export type Delivery = 'delivered_verified'|'delivered_unverified'|'not_delivered'|'unknown'
export type Mechanism = 'semantic_api'|'physical_synthetic'|'unknown'
export type Verification = 'none'|'passed'|'failed'
export type ControlCounts = {open:number;close:number}
export type ActionDiagnostics = {
 control:ControlCategory
 delivery:Delivery
 mechanism:Mechanism
 verification:Verification
 focused?:boolean
 before?:ControlCounts
 after?:ControlCounts
}
type Node={role?:unknown;name?:unknown;children?:unknown}
const CATEGORY = new Set<ControlCategory>(['browser_open','browser_close','button','menu_item','text_field','other'])
const DELIVERY = new Set<Delivery>(['delivered_verified','delivered_unverified','not_delivered','unknown'])
const MECHANISM = new Set<Mechanism>(['semantic_api','physical_synthetic','unknown'])
const VERIFICATION = new Set<Verification>(['none','passed','failed'])

export function controlCategory(node:unknown):ControlCategory {
 const value=node&&typeof node==='object'?node as Node:null
 if(!value)return 'other'
 const role=typeof value.role==='string'?value.role:''
 const name=typeof value.name==='string'?value.name.trim().toLowerCase():''
 if(role==='button'&&name==='open browser')return 'browser_open'
 if(role==='button'&&(name==='close browser'||name==='browser active'))return 'browser_close'
 if(role==='button')return 'button'
 if(role==='menuitem')return 'menu_item'
 if(role==='textfield'||role==='textarea'||role==='text area')return 'text_field'
 return 'other'
}

/** Count only the two pane controls a browser task can observe.
 * A raw snapshot is used before the action scope prunes unrelated nodes. */
export function controlCounts(tree:unknown):ControlCounts {
 const counts={open:0,close:0}
 const stack:unknown[]=[tree]
 while(stack.length){
  const raw=stack.pop()
  if(!raw||typeof raw!=='object')continue
  const node=raw as Node
  const category=controlCategory(node)
  if(category==='browser_open')counts.open++
  else if(category==='browser_close')counts.close++
  if(Array.isArray(node.children))stack.push(...node.children)
 }
 return {open:Math.min(counts.open,50),close:Math.min(counts.close,50)}
}

/** Read the adapter's own bounded delivery report, never its labels. */
export function adapterDelivery(data:unknown):{delivery:Delivery;mechanism:Mechanism} {
 const record=data&&typeof data==='object'?data as {disposition?:unknown;steps?:unknown}:null
 let delivery:Delivery='unknown',mechanism:Mechanism='unknown'
 const disposition=record?.disposition
 if(disposition&&typeof disposition==='object'&&typeof (disposition as {delivery?:unknown}).delivery==='string'){
  const value=(disposition as {delivery:string}).delivery
  if(DELIVERY.has(value as Delivery))delivery=value as Delivery
 }
 if(Array.isArray(record?.steps))for(const step of record.steps){
  if(!step||typeof step!=='object')continue
  const value=step as {mechanism?:unknown;verified?:unknown}
  if(typeof value.mechanism==='string'&&MECHANISM.has(value.mechanism as Mechanism))mechanism=value.mechanism as Mechanism
 }
 return {delivery,mechanism}
}

/** The core loop forces expect.kind 'none' for planner actions. That check
 * reports observed_only and is not a failed action postcondition. */
export function verificationState(steps:unknown):Verification {
 if(!Array.isArray(steps))return 'none'
 for(let index=steps.length-1;index>=0;index--){
  const step=steps[index]
  if(!step||typeof step!=='object'||(step as {decision?:unknown}).decision!=='act')continue
  const check=(step as {verification?:unknown}).verification
  if(!check||typeof check!=='object')return 'none'
  const value=check as {check?:unknown;passed?:unknown}
  if(value.check==='observed_only')return 'none'
  if(value.passed===true)return 'passed'
  if(value.passed===false)return 'failed'
  return 'none'
 }
 return 'none'
}

const count=(value:unknown)=>typeof value==='number'&&Number.isInteger(value)&&value>=0&&value<=50?value:null
function counts(value:ControlCounts|undefined):ControlCounts|undefined {
 if(!value||typeof value!=='object')return undefined
 const open=count(value.open),close=count(value.close)
 return open===null||close===null?undefined:{open,close}
}

/** Build one small object that crosses IPC. Unknown inputs are dropped. */
export function actionDiagnostics(input:{node:unknown;data:unknown;focused?:unknown;before?:ControlCounts;after?:ControlCounts;steps?:unknown}):ActionDiagnostics {
 const {delivery,mechanism}=adapterDelivery(input.data)
 const before=counts(input.before),after=counts(input.after)
 const focused=typeof input.focused==='boolean'?input.focused:undefined
 return {
  control:controlCategory(input.node),delivery,mechanism,verification:verificationState(input.steps),
  ...(focused===undefined?{}:{focused}),
  ...(before?{before}:{}),...(after?{after}:{}),
 }
}

export const diagnosticsEnums=Object.freeze({CATEGORY,DELIVERY,MECHANISM,VERIFICATION})
