import { describe, expect, it } from 'vitest';
import { Desk, sceneCatalog } from '../src/dsh/desk';

describe('前台后台的桌子', () => {
  it('进度只留最新一条；交了最终的就算干完，进度一起清掉', () => {
    const desk = new Desk(() => 0);
    const t = desk.open('answer', '抹香鲸能潜多深');
    desk.bind(t, 's1');
    expect(desk.ofSession('s1')).toBe(t);
    desk.deliver(t, 'progress', '在搜「sperm whale」');
    desk.deliver(t, 'progress', '在读 nhm.ac.uk');
    expect(desk.hasNews()).toBe(false);
    expect(desk.line()).toContain('在读 nhm.ac.uk');
    desk.deliver(t, 'answer', '大约 2000 米（出处：NHM）');
    expect(t.status).toBe('done');
    expect(desk.hasNews()).toBe(true);
    const text = desk.take();
    expect(text).toContain('查到了');
    expect(text).not.toContain('在读');
    expect(desk.take()).toBe('');
    // 干完以后再交不收
    desk.deliver(t, 'answer', '又一份');
    expect(desk.take()).toBe('');
  });

  it('撤掉的活不再收东西，也不占名额', () => {
    const desk = new Desk(() => 0);
    const t = desk.open('topic', '随便找个题');
    desk.deliver(t, 'progress', '在搜');
    expect(desk.cancel(t.id)).toBe(t);
    expect(desk.running()).toHaveLength(0);
    desk.deliver(t, 'fail', '晚了');
    expect(desk.take()).toBe('');
  });

  it('话题：起步卡和补料都不算完，一直跟着；换话题时旧的作废', () => {
    const desk = new Desk(() => 0);
    const topic = desk.openTopic('找个心理学的题', 0);
    expect(desk.running()).toHaveLength(0);
    expect(desk.line()).toContain('话题');
    desk.name(topic, '知识的诅咒');
    desk.deliver(topic.task, 'start', '- 1990 年敲桌子实验（出处：x）', 1_000);
    expect(topic.task.status).toBe('running');
    expect(topic.batches).toBe(1);
    expect(topic.spokenAtLastBatch).toBe(1_000);
    expect(desk.take()).toContain('话题「知识的诅咒」（t1） 起步卡到了');
    desk.deliver(topic.task, 'cards', '- 又一条（出处：y）', 50_000);
    expect(topic.batches).toBe(2);
    expect(desk.take()).toContain('又补了一批');
    const next = desk.openTopic('换个历史题', 60_000);
    expect(topic.task.status).toBe('cancelled');
    expect(desk.topic).toBe(next);
    desk.deliver(topic.task, 'cards', '晚到的', 70_000);
    expect(desk.take()).toBe('');
    expect(desk.topics).toEqual(['知识的诅咒']);
  });

  it('场景目录从场景开头的注释里读出演示什么、参数和动作', () => {
    const text = sceneCatalog('scenes');
    expect(text).toContain('@percolation.html');
    expect(text).toMatch(/percolation\.html：.*参数 open.*动作 pour、reset、reroll/);
    expect(text).not.toContain('index.html');
  });
});
