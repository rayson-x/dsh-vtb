/** 挂件只留参与口令和实时摘要；不经过整块缩放，数字变化也不挤小字号。 */
import type { Item } from '../../stage/draw/model';

// 标题只是提示，全文在回到主画布后展示；按字截短，省略号也占一个字位。
const short = (text: string, limit = 10) => {
  const chars = [...text.replace(/\s+/g, ' ').trim()];
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('');
};
const number = (n: number) => Math.abs(n) >= 10000 ? n.toExponential(1) : String(Number(n.toFixed(1)));

export function Docked({ item, now }: { item: Item; now: number }) {
  let kind = '', title = item.text, metric = '', detail = '', hint: string[] = [];
  const votes = Object.entries(item.votes ?? {});
  const total = votes.reduce((n, [, v]) => n + v, 0);
  const top = [...votes].sort((a, b) => b[1] - a[1])[0];
  const values = (item.values ?? []).map((x) => x.v);
  switch (item.kind) {
    case 'poll': {
      kind = item.open ? '投票中' : '投票已结束';
      const index = item.rows?.findIndex((r) => r.label === top?.[0]) ?? -1;
      const tied = votes.filter(([, n]) => n === top?.[1]).length > 1;
      metric = total ? `${tied ? '并列' : '领先'} ${index + 1} · ${number(top![1])} 票` : '等待第一票';
      detail = total ? `${short(top![0], 6)} · 共 ${number(total)} 票` : '共 0 票';
      hint = [item.open ? `发 ${(item.rows ?? []).map((_, i) => i + 1).join('/')} 投票` : '等待主持人揭晓'];
      break;
    }
    case 'tier':
      kind = item.open && item.judging ? '夯到拉 · 评档中' : '夯到拉 · 等待开评';
      title = item.judging ?? item.text;
      metric = total ? `${top![0]} · ${number(top![1])}票` : '等待第一票';
      detail = `${total ? '领先 · ' : ''}共 ${number(total)} 票`;
      hint = item.open && item.judging ? ['发 夯/顶级/人上人', '或 NPC/拉完了'] : ['等待主持人开评'];
      break;
    case 'score':
      kind = item.open ? '打分中' : '打分已结束';
      metric = values.length ? `平均 ${(values.reduce((a, b) => a + b, 0) / values.length).toFixed(1)} 分` : '等待第一个评分';
      detail = `已有 ${number(values.length)} 人打分`;
      hint = [item.open ? '发 1–10 打分' : '等待主持人揭晓'];
      break;
    case 'guess': {
      kind = item.open ? '猜数字中' : '猜数字已结束';
      const sorted = [...values].sort((a, b) => a - b);
      metric = values.length ? `中位数 ${number(sorted[Math.floor(sorted.length / 2)]!)}` : '等待第一个猜测';
      detail = `已有 ${number(values.length)} 人猜`;
      hint = [item.open ? '直接发一个数字' : '等待主持人揭晓'];
      break;
    }
    case 'soup': {
      kind = '海龟汤 · 提问中';
      const asks = item.asks ?? [];
      const waiting = asks.filter((x) => !x.a).length;
      metric = `${waiting} 个问题排队`;
      detail = `已回答 ${asks.length - waiting} 个问题`;
      hint = ['发「是不是…」提问'];
      break;
    }
    case 'timer': {
      const seconds = Math.max(0, Math.ceil(Number(item.text) - (now - item.born) / 1000));
      kind = seconds ? '倒计时进行中' : '倒计时结束';
      title = item.note ?? '互动倒计时';
      metric = seconds ? `剩余 ${number(seconds)} 秒` : '时间到！';
      detail = '以主持人口令为准';
      hint = [seconds ? '请在结束前发弹幕' : '等待主持人公布结果'];
      break;
    }
    case 'wall':
      kind = '弹幕上墙';
      title = item.note ?? '观众';
      metric = short(item.text, 9);
      detail = '主持人选中的留言';
      hint = ['发弹幕，等主持人上墙'];
      break;
  }
  return <div className="draw-dock" aria-label={`${kind}：${title}`}>
    <p className="draw-dock-kind">{kind}</p>
    <h3 title={title}>{short(title)}</h3>
    <p className="draw-dock-metric">{metric}</p>
    <p className="draw-dock-detail">{detail}</p>
    <div className="draw-dock-hint">{hint.map((line) => <p key={line}>{line}</p>)}</div>
  </div>;
}
