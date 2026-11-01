/**
 * 角色占位：Live2D 接上之前先用这个。会眨眼、讲话时动嘴、按心情换脸，看片时眼睛看向片子。
 * 关掉角色（visible=false）时整层不画，节目照样成立。
 */

import type { Mood, Look } from '../stage/protocol';

function Eyes({ mood, look }: { mood: Mood; look: number }) {
  if (mood === 'happy') {
    return (
      <g className="eyes" stroke="#1d1b22" strokeWidth="9" strokeLinecap="round" fill="none">
        <path d="M300 372 q26 -30 52 0" />
        <path d="M428 372 q26 -30 52 0" />
      </g>
    );
  }
  const r = mood === 'surprised' ? 30 : 24;
  const ry = mood === 'sad' ? 18 : r;
  const dy = mood === 'thinking' ? -8 : 0;
  return (
    <g className="eyes blink">
      <ellipse cx="326" cy="372" rx={r} ry={ry} fill="#1d1b22" />
      <ellipse cx="454" cy="372" rx={r} ry={ry} fill="#1d1b22" />
      <circle cx={334 + look} cy={362 + dy} r="8" fill="#fff6e8" />
      <circle cx={462 + look} cy={362 + dy} r="8" fill="#fff6e8" />
    </g>
  );
}

function Brows({ mood }: { mood: Mood }) {
  const d = {
    neutral: ['M296 318 q30 -12 60 0', 'M424 318 q30 -12 60 0'],
    happy: ['M296 312 q30 -16 60 0', 'M424 312 q30 -16 60 0'],
    surprised: ['M296 300 q30 -20 60 0', 'M424 300 q30 -20 60 0'],
    thinking: ['M296 318 q30 -4 60 -10', 'M424 302 q30 -18 60 4'],
    sad: ['M296 312 q30 4 60 12', 'M424 324 q30 -4 60 -12'],
  }[mood];
  return (
    <g stroke="#3a2a2a" strokeWidth="8" strokeLinecap="round" fill="none">
      <path d={d[0]} />
      <path d={d[1]} />
    </g>
  );
}

function Mouth({ mood, speaking }: { mood: Mood; speaking: boolean }) {
  if (speaking) return <ellipse className="mouth talking" cx="390" cy="462" rx="26" ry="20" fill="#7a2c34" />;
  if (mood === 'surprised') return <ellipse cx="390" cy="462" rx="16" ry="18" fill="#7a2c34" />;
  const d = mood === 'happy' ? 'M352 450 q38 40 76 0' : mood === 'sad' ? 'M360 470 q30 -22 60 0' : mood === 'thinking' ? 'M366 462 h40' : 'M360 456 q30 18 60 0';
  return <path d={d} stroke="#7a2c34" strokeWidth="9" strokeLinecap="round" fill={mood === 'happy' ? '#7a2c34' : 'none'} />;
}

export function Avatar({ mood, speaking, look: gaze }: { mood: Mood; speaking: boolean; look: Look }) {
  // 看片时人在右下，眼睛看向左边的片子
  const look = gaze === 'left' ? -9 : gaze === 'right' ? 9 : 0;
  return (
    <svg className={`avatar-svg ${speaking ? 'speaking' : ''}`} viewBox="0 0 780 1010" aria-hidden>
      {/* 身体：连帽衫 */}
      <path d="M120 1010 C130 760 240 640 390 640 C540 640 650 760 660 1010 Z" fill="#2b3a55" />
      <path d="M300 660 C320 720 460 720 480 660 L470 700 C440 760 340 760 310 700 Z" fill="#22304a" />
      <path d="M372 700 v120 M408 700 v120" stroke="#e9b45a" strokeWidth="8" strokeLinecap="round" />
      {/* 脖子 */}
      <rect x="352" y="560" width="76" height="100" rx="30" fill="#f1cdb4" />
      <g className="head">
        {/* 后发 */}
        <path d="M170 380 C160 160 300 90 390 90 C480 90 620 160 610 380 L640 640 C580 600 540 560 520 520 L260 520 C240 560 200 600 140 640 Z" fill="#30243a" />
        {/* 脸 */}
        <ellipse cx="390" cy="380" rx="190" ry="200" fill="#f8dcc6" />
        {/* 刘海 */}
        <path d="M200 330 C210 170 320 140 390 140 C470 140 580 170 584 330 C540 260 500 230 450 220 C430 270 380 290 330 290 C350 260 352 240 348 224 C290 240 240 280 200 330 Z" fill="#30243a" />
        {/* 耳机 */}
        <path d="M180 360 C170 200 260 120 390 120 C520 120 610 200 600 360" stroke="#e9b45a" strokeWidth="18" fill="none" />
        <rect x="160" y="340" width="44" height="96" rx="20" fill="#e9b45a" />
        <rect x="576" y="340" width="44" height="96" rx="20" fill="#e9b45a" />
        <Brows mood={mood} />
        <Eyes mood={mood} look={look} />
        {(mood === 'happy' || speaking) && (
          <g fill="#f29c8f" opacity="0.45">
            <ellipse cx="282" cy="430" rx="30" ry="16" />
            <ellipse cx="498" cy="430" rx="30" ry="16" />
          </g>
        )}
        <Mouth mood={mood} speaking={speaking} />
        {mood === 'thinking' && (
          <g className="think-dots" fill="#fff6e8">
            <circle cx="640" cy="200" r="10" />
            <circle cx="676" cy="160" r="14" />
            <circle cx="722" cy="112" r="20" />
          </g>
        )}
      </g>
    </svg>
  );
}
