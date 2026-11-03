import React from 'react';
import {useCurrentFrame} from 'remotion';
import {defineRemotionScene} from '@reelmorph/scene';
function Title({params={}}:{params?:{text?:string}}){const frame=useCurrentFrame();return <div style={{width:'100%',height:'100%',background:'#102d38',color:'#ecf4ef',display:'flex',alignItems:'center',justifyContent:'center',font:'80px sans-serif',transform:`translateX(${Math.sin(frame/90)*12}px)`}}>{params.text??'窗外的光'}</div>;}
export default defineRemotionScene(Title);
