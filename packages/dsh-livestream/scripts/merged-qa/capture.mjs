// QA由runner拼入；恢复父协调者已有空间，不导航、不刷新、不finish。
const fs=await import('node:fs/promises');
const task=await taskSpace('aivtb 合并验收'),page=task.page('p1');
if(!(await page.url()).startsWith('http://127.0.0.1:3925/'))throw Error('父任务p1尚未打开3925舞台');
await page.cdp('Emulation.setDeviceMetricsOverride',{width:1920,height:1080,deviceScaleFactor:1,mobile:false});
await page.cdp('Page.bringToFront',{});
await fs.mkdir(QA.out,{recursive:true});
for(let i=0;i<10;i++){
  const at=Date.now(),path=`${QA.out}/${at}.jpg`;
  const overlap=await page.evaluate(measureOverlap);
  const observed=await page.evaluate(()=>({installedAt:window.__trackQA?.installedAt,events:window.__trackQA?.events.splice(0)??[]}));
  const shot=await page.cdp('Page.captureScreenshot',{format:'jpeg',quality:85,captureBeyondViewport:false});
  await fs.writeFile(path,Buffer.from(shot.data,'base64'));await fs.appendFile(`${QA.out}/shots.jsonl`,JSON.stringify({at,path,overlap,observed})+'\n');
  await new Promise(r=>setTimeout(r,Math.max(0,at+5000-Date.now())));
}
console.log('截图10张',QA.out);
