// 在正式开讲计时前激活本任务的舞台文档，避免把浏览器静音的开场算入真语音验收。
const task = await taskSpace('aivtb-plan 验收');
const page = task.page('p1');
if (await page.url() !== 'http://127.0.0.1:3921/') await page.goto('http://127.0.0.1:3921/');
const before = await page.snapshot();
if (before.includes('点一下页面开声音')) await page.click('text=点一下页面开声音');
else if (!await page.evaluate(() => navigator.userActivation.hasBeenActive)) await page.mouse.click(4, 4, { label: '开启 舞台 声音' });
const activated = await page.evaluate(() => navigator.userActivation.hasBeenActive);
if (!activated) throw new Error('舞台文档未获得播放手势，不开始正式验收');
console.log('QA_AUDIO_READY ' + JSON.stringify({ spaceId: task.spaceId, at: Date.now(), activated, url: await page.url() }));
