// 配置由运行器拼在前面；复用同一个 TaskSpace，不触碰其他测试窗口。
const fs = await import('node:fs/promises');
const task = await taskSpace('aivtb-track 直播');
const page = task.page('p1');
await page.cdp('Emulation.setDeviceMetricsOverride', {width:1920,height:1080,deviceScaleFactor:1,mobile:false});
await page.cdp('Page.bringToFront', {});
await fs.mkdir(QA.out, {recursive:true});
for (let i=0;i<10;i++) {
  const at=Date.now();
  const path=`${QA.out}/${at}.jpg`;
  const overlap = await page.evaluate(measureOverlap);
  const observed = await page.evaluate(() => ({ installedAt: window.__trackQA?.installedAt, events: window.__trackQA?.events.splice(0) ?? [] }));
  const shot = await page.cdp('Page.captureScreenshot', { format: 'jpeg', quality: 85, captureBeyondViewport: false });
  await fs.writeFile(path, Buffer.from(shot.data, 'base64'));
  await fs.appendFile(`${QA.out}/shots.jsonl`, JSON.stringify({at,path,overlap,observed})+'\n');
  await new Promise(r=>setTimeout(r,Math.max(0,at+5000-Date.now())));
}
console.log('截图10张', QA.out);
