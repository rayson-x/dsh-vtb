/**
 * 她在翻资料：搜索词一个字一个字打出来，搜到的网页标题一条条冒出来，正在读的那个亮起来。
 * 查资料要十几二十秒，主画面上得有东西；内容全是真的（后台真在搜、真在读），不是装样子。
 */

import type { ResearchFeed } from '../stage/protocol';

/** 每个字打多久、每条结果隔多久冒出来（毫秒） */
const TYPE_MS = 70;
const ROW_MS = 350;

/** big：工位很小时（桌上的显示器）用大字、少几条，缩小了也看得清 */
export function Research({ feed, now, big = false }: { feed: ResearchFeed; now: number; big?: boolean }) {
  const since = now - feed.at;
  const query = feed.query ?? '';
  const typed = [...query].slice(0, Math.floor(since / TYPE_MS)).join('');
  const typing = typed.length < [...query].length;
  // 结果等搜索词打完再一条条出来
  const shown = typing ? 0 : Math.min(feed.sources.length, big ? 3 : 6, Math.floor((since - [...query].length * TYPE_MS) / ROW_MS) + 1);
  return (
    <div className={`research ${big ? 'big' : ''}`}>
      <div className="research-card">
        <div className="research-bar">
          <i className="research-lens" />
          <span className="research-query">{typed}</span>
          <span className={`research-caret ${typing ? 'on' : ''}`} />
        </div>
        <ol className="research-list">
          {feed.sources.slice(0, shown).map((x) => {
            const reading = !!feed.reading && x.host === feed.reading;
            return (
              <li key={x.title} className={reading ? 'reading' : ''}>
                <span className="research-host">{x.host}</span>
                <span className="research-title">{x.title}</span>
                {reading && <em>在读</em>}
              </li>
            );
          })}
          {!typing && !feed.sources.length && <li className="research-wait"><span className="research-dots"><i /><i /><i /></span></li>}
        </ol>
        {feed.reading && !feed.sources.some((x) => x.host === feed.reading) && (
          <div className="research-reading"><em>在读</em>{feed.reading}</div>
        )}
      </div>
    </div>
  );
}
