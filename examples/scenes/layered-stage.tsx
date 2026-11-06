import React from 'react';
import {useCurrentFrame} from 'remotion';
import {defineRemotionScene} from '@reelmorph/scene';

type Layer={kind?:string;x?:number;y?:number;scale?:number;rotate?:number;opacity?:number;visible?:boolean;fill?:string;stroke?:string;strokeWidth?:number;width?:number;height?:number;d?:string;text?:string;src?:string;fontSize?:number;brightness?:number;softness?:number;count?:number;speed?:number;emptySlot?:number;enterFrame?:number;exitFrame?:number;fadeFrames?:number;children?:Record<string,Layer|null>};
type Props={background?:string;palette?:string;layers?:Record<string,Layer|null>};
const number=(v:unknown,d:number,min=-10000,max=10000)=>typeof v==='number'&&Number.isFinite(v)?Math.min(max,Math.max(min,v)):d;
const wrap=(text:string,width:number,size:number)=>{const out:string[]=[];for(const line of text.split('\n')){let part='',used=0;for(const c of line){const n=/[\u2e80-\uffff]/.test(c)?size:size*.6;if(used+n>width&&part){out.push(part);part='';used=0;}part+=c;used+=n;}out.push(part);}return out.slice(0,6);};
const hash=(s:string)=>{let h=0;for(const c of s)h=(h*31+c.charCodeAt(0))|0;return(h>>>0).toString(36);};
function LayeredStage({background='transparent',palette='warm',layers={}}:Props){
 const frame=useCurrentFrame(),quiet=palette==='quiet';
 const ink=quiet?'#506a77':'#304953',paper=quiet?'#e1e2d6':'#f0e0bc',wood=quiet?'#77858a':'#967b5d',light=quiet?'#d1dbc2':'#f7d597';
 let rendered=0;
 const draw=(id:string,l:Layer|null,depth=0):React.ReactNode=>{
  if(!l||l.visible===false||depth>4||rendered++>=240)return null;
  const x=number(l.x,0),y=number(l.y,0),scale=number(l.scale,1,.05,20),w=number(l.width,100,1,1920),h=number(l.height,100,1,1080),fill=l.fill??ink,stroke=l.stroke??'none',sw=number(l.strokeWidth,2,0,40);
  const fade=number(l.fadeFrames,18,1,300),enter=number(l.enterFrame,0,0,108000),exit=number(l.exitFrame,108001,0,108001);
  const alpha=number(l.opacity,1,0,1)*Math.max(0,Math.min(1,(frame-enter)/fade,(exit-frame)/fade));
  const glow='glow-'+hash(id);let content:React.ReactNode;
  switch(l.kind){
   case'group':content=Object.entries(l.children??{}).map(([key,value])=>draw(id+'-'+key,value,depth+1));break;
   case'rect':content=<rect width={w} height={h} fill={fill} stroke={stroke} strokeWidth={sw}/>;break;
   case'ellipse':content=<ellipse cx={w/2} cy={h/2} rx={w/2} ry={h/2} fill={fill} stroke={stroke} strokeWidth={sw}/>;break;
   case'path':content=<path d={l.d??''} fill={fill} stroke={stroke} strokeWidth={sw} strokeLinecap="round" strokeLinejoin="round"/>;break;
   case'text':content=<text fill={fill} fontSize={number(l.fontSize,36,12,120)} fontFamily='"Songti SC",Georgia,serif' dominantBaseline="hanging">{wrap(l.text??'',number(l.width,600,1,1920),number(l.fontSize,36,12,120)).map((line,i)=><tspan key={i} x="0" dy={i?number(l.fontSize,36,12,120)*1.4:0}>{line}</tspan>)}</text>;break;
   case'image':content=<image href={l.src} width={w} height={h} preserveAspectRatio="xMidYMid meet"/>;break;
   case'window':content=<><ellipse cx={w/2} cy={h/2} rx={w/2} ry={h/2} fill={quiet?'#415e6d':'#173e50'} stroke={wood} strokeWidth={14}/><path d={`M${w*.15} ${h*.3} Q${w*.3} ${h*.08} ${w*.6} ${h*.12}`} fill="none" stroke="#b6d5d2" opacity=".35" strokeWidth="6"/></>;break;
   case'table':content=<><path d={`M0 0H${w}L${w-12} 24H12Z`} fill={wood}/><path d={`M22 24V${h}M${w-22} 24V${h}`} stroke={wood} strokeWidth="16"/></>;break;
   case'lamp':{
    const strength=number(l.brightness,.65,0,1),soft=number(l.softness,.6,0,1);
    content=<><defs><filter id={glow} x="-150%" y="-150%" width="400%" height="400%"><feGaussianBlur stdDeviation={10+soft*22}/></filter></defs><ellipse cx="50" cy="40" rx={35+soft*60} ry={28+soft*50} fill={light} opacity={strength*.7} filter={`url(#${glow})`}/><path d="M22 42Q22 7 50 7Q78 7 78 42Z" fill={light} opacity={.25+strength*.75}/><path d="M50 43V91M29 93H71" stroke={wood} strokeWidth="7" strokeLinecap="round"/></>;break;}
   case'cup':content=<><path d="M70 20C112 12 110 68 72 64" fill="none" stroke={paper} strokeWidth="10"/><path d="M12 17H76L71 77Q45 91 18 77Z" fill={paper} stroke={ink} strokeWidth="2"/><path d="M12 17Q42 7 76 17" fill="none" stroke={ink} strokeWidth="3"/><path d="M28 15L34 23L38 14" fill={wood}/><ellipse cx="45" cy="85" rx="32" ry="5" fill={ink} opacity=".15"/></>;break;
   case'book':content=<><path d="M5 16Q27 3 50 15Q73 3 95 16V78Q73 65 50 77Q27 65 5 78Z" fill={paper} stroke={wood} strokeWidth="3"/><path d="M50 15V77" stroke={wood} strokeWidth="2"/>{[28,39,50,61].map(y=><path key={y} d={`M14 ${y}L41 ${y-2}M59 ${y-2}L86 ${y}`} stroke={ink} opacity=".3" strokeWidth="1.5"/>)}</>;break;
   case'letter':content=<><path d={`M0 6L${w-4} 0L${w} ${h-5}L5 ${h}Z`} fill={paper}/><path d={`M12 13L${w-15} 9`} stroke={wood} opacity=".35"/>{wrap(l.text??'',w-36,number(l.fontSize,24,12,120)).map((line,i)=><text key={i} x="18" y={38+i*number(l.fontSize,24,12,120)*1.5} fill={ink} fontSize={number(l.fontSize,24,12,120)} fontFamily='"Songti SC",Georgia,serif'>{line}</text>)}</>;break;
   case'shelf':content=<><path d={`M0 ${h}H${w}M0 0V${h+12}M${w} 0V${h+12}`} fill="none" stroke={wood} strokeWidth="10"/>{Array.from({length:7},(_,i)=>i).filter(i=>i!==number(l.emptySlot,-1,-1,6)).map(i=><g key={i} transform={`translate(${14+i*(w-24)/7} ${h-58-(i%3)*9}) rotate(${i%2?3:-3})`}><rect width={(w-36)/8} height={58+(i%3)*9} fill={[ink,wood,quiet?'#9caeaa':'#b58f72'][i%3]}/><path d="M4 8H15M4 43H15" stroke={paper} opacity=".5" strokeWidth="2"/></g>)}</>;break;
   case'fish':content=<g fill={l.fill??(quiet?'#9dbdc1':'#b2d0c8')} opacity=".8">{Array.from({length:Math.round(number(l.count,4,0,18))},(_,i)=>{
    const t=frame*number(l.speed,1,0,5),dx=i*48+Math.sin(t/110+i)*45,dy=Math.sin(t/45+i*.7)*12;
    return <g key={i} transform={`translate(${dx} ${dy})`}><path d="M0 0Q18 -12 32 0Q18 12 0 0L-11 -9V9Z"/><circle cx="25" cy="-1" r="1.5" fill={ink}/></g>;})}</g>;break;
   default:content=null;
  }
  return <g key={id} data-layer={id} opacity={alpha} transform={`translate(${x} ${y}) rotate(${number(l.rotate,0,-360,360)}) scale(${scale})`}>{content}</g>;
 };
 return <svg viewBox="0 0 1920 1080" width="100%" height="100%" style={{display:'block',background}} role="img" aria-label="节目内容画面">{Object.entries(layers).map(([id,layer])=>draw(id,layer))}</svg>;
}
export default defineRemotionScene(LayeredStage);
