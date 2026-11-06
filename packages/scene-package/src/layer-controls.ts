/** Data contract of the bundled layered-stage component; arbitrary Scene source remains separate. */
const kinds=new Set(['group','rect','ellipse','path','text','image','window','table','lamp','cup','book','letter','shelf','fish']);
const numeric=new Set(['x','y','scale','rotate','opacity','strokeWidth','width','height','fontSize','brightness','softness','count','speed','emptySlot','enterFrame','exitFrame','fadeFrames']);
const common=new Set(['kind','x','y','scale','rotate','opacity','visible','enterFrame','exitFrame','fadeFrames']);
const fields:Record<string,string[]>={group:['children'],rect:['width','height','fill','stroke','strokeWidth'],ellipse:['width','height','fill','stroke','strokeWidth'],path:['d','fill','stroke','strokeWidth'],text:['text','fontSize','fill','width'],image:['src','width','height'],window:['width','height'],table:['width','height'],lamp:['brightness','softness'],cup:[],book:[],letter:['width','height','text','fontSize'],shelf:['width','height','emptySlot'],fish:['fill','count','speed']};
const bounds:Record<string,[number,number]>={scale:[.05,20],rotate:[-360,360],opacity:[0,1],width:[1,1920],height:[1,1080],strokeWidth:[0,40],fontSize:[12,120],brightness:[0,1],softness:[0,1],count:[0,18],speed:[0,5],emptySlot:[-1,6],enterFrame:[0,108000],exitFrame:[0,108001],fadeFrames:[1,300]};
const strings=new Set(['kind','fill','stroke','d','text','src']);
const record=(v:unknown):v is Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v);
export function layeredStageProblem(inputs:Record<string,unknown>,patch?:Record<string,unknown>):string|undefined{
 if(Object.keys(inputs).some(k=>!['layers','background','palette','fps','width','height','durationInFrames','window'].includes(k)))return'unsupported layered-stage root property';
 if(patch&&Object.keys(patch).some(k=>!['layers','background','palette'].includes(k)))return'layered-stage controls live at inputs root: layers/background/palette; do not wrap params';
 if(inputs.background!==undefined&&typeof inputs.background!=='string')return'background must be a color string';
 if(inputs.palette!==undefined&&!['warm','quiet'].includes(String(inputs.palette)))return'palette must be warm or quiet';
 if(!record(inputs.layers))return'layers must be an ID object';
 let count=0;
 const visit=(layers:Record<string,unknown>,depth:number):string|undefined=>{
  for(const[id,v]of Object.entries(layers)){
   if(v===null)continue;
   if(++count>240||depth>4)return'layer budget exceeded';
   if(!id||id.length>100||!record(v)||typeof v.kind!=='string'||!kinds.has(v.kind))return'each complete layer needs a supported kind; rebuild removed layers with kind';
   for(const[k,x]of Object.entries(v)){
    if(!common.has(k)&&!fields[v.kind].includes(k))return'unsupported '+v.kind+' control: '+k;
    if(numeric.has(k)){if(typeof x!=='number'||!Number.isFinite(x))return k+' must be numeric';const range=bounds[k]??[-10000,10000];if(x<range[0]||x>range[1]||(['count','emptySlot'].includes(k)&&!Number.isInteger(x)))return k+' outside component control range';}
    else if(strings.has(k)){if(typeof x!=='string')return k+' must be a string';}
    else if(k==='visible'){if(typeof x!=='boolean')return'visible must be boolean';}
    else if(k==='children'){if(!record(x))return'children must be an ID object';const error=visit(x,depth+1);if(error)return error;}
    else return'unsupported layer control: '+k;
   }
  }
 };
 return visit(inputs.layers,0);
}
