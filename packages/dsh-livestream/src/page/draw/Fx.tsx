/**
 * 叠在元素上的动作：手绘圈、荧光笔、波浪下划线、一闪一闪的光边、画过来的箭头、✓✗ 章、划掉的线。
 * 贴着元素的实际内容画（字就贴着字），按 0–100 的相对坐标画，线宽不跟着拉伸；同一个动作再做一次就重画。
 */

import type { Item } from '../../stage/draw/model';


export function FxLayer({ item, hug }: { item: Item; hug: boolean }) {
  const fx = item.fx;
  return (
    <>
      {/* 圈：字用椭圆圈住，整块的东西用圆角框框住；稍微歪一点，像马克笔画的 */}
      {fx?.kind === 'circle' && <i className={`fx-ring ${hug ? 'oval' : 'box'}`} key={fx.at} />}
      {fx?.kind === 'underline' && <i className="fx-wave" key={fx.at} />}
      {fx?.kind === 'highlight' && <i className="fx-highlight" key={fx.at} />}
      {fx?.kind === 'pulse' && <i className="fx-pulse" key={fx.at} />}
      {fx?.kind === 'arrow' && (
        <div className="fx-arrow" key={fx.at}>
          {fx.arg && <span>{fx.arg}</span>}
          <svg width="150" height="110" viewBox="0 0 150 110">
            <path d="M 10 10 C 60 6, 110 30, 132 88" pathLength={1} />
            <path className="head" d="M 118 80 L 134 96 L 140 74" pathLength={1} />
          </svg>
        </div>
      )}
      {item.struck && <i className="fx-strike" />}
      {item.stamp && <b className={`fx-seal ${/假|错|谣/.test(item.stamp) ? 'bad' : /真|对/.test(item.stamp) ? 'good' : ''}`} key={`seal-${fx?.at ?? 0}`}>{item.stamp}</b>}
      {item.mark && <b className={`fx-stamp ${item.mark}`} key={`${item.mark}-${fx?.at ?? 0}`}>{item.mark === 'check' ? '✓' : '✗'}</b>}
    </>
  );
}
