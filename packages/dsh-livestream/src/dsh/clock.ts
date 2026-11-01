/** 现在几点（本地时间）：她得知道是深夜还是下午、星期几，开场白、闲聊才对得上 */
export function clockNow(at = new Date()): string {
  const day = at.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  const time = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const h = at.getHours();
  const part = h < 5 ? '凌晨' : h < 9 ? '早上' : h < 12 ? '上午' : h < 14 ? '中午' : h < 18 ? '下午' : h < 23 ? '晚上' : '深夜';
  return `${day} ${part} ${time}`;
}
