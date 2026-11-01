# 深夜怪谈布景

使用内置 imagegen 图片生成工具逐张生成。先完成 room 和 board 并检查风格，其余组件以 board 为材质与画风参考。图片中不含文字、人物或恐怖元素。

## 尺寸、透明度与内区

单位均为像素。四边距从**完整图片画布**计算，顺序为**左 / 上 / 右 / 下**，表示避开边框、蜡封、绳结和图标后的保守文字安全区，不是透明留边的宽度。网页缩放图片时，边距应同比例缩放。

| 文件 | 实际尺寸 | 透明度 | 内区四边距（左 / 上 / 右 / 下） | 内区尺寸 | 用途 |
| --- | --- | --- | --- | --- | --- |
| `room.webp` | 1920 × 1080 | 不透明，RGB | 0 / 0 / 0 / 0 | 1920 × 1080 | 全幅背景，不作为文字底板 |
| `kit/board.png` | 1280 × 800 | PNG RGBA，外围透明 | 90 / 140 / 90 / 90 | 1100 × 570 | 深色展示区，避开顶部蜡封 |
| `kit/subtitle.png` | 1500 × 180 | PNG RGBA，外围透明 | 80 / 55 / 80 / 55 | 1340 × 70 | 深色字幕区 |
| `kit/plaque.png` | 900 × 220 | PNG RGBA，外围透明 | 105 / 85 / 40 / 70 | 755 × 65 | 深色节目名区，避开左侧蜡烛和顶部绳环 |
| `kit/note.png` | 480 × 200 | PNG RGBA，外围透明 | 30 / 60 / 30 / 30 | 420 × 110 | 浅米黄色旧纸，配深色文字，避开顶部图钉 |
| `kit/badge.png` | 260 × 90 | PNG RGBA，外围透明 | 70 / 31 / 35 / 31 | 155 × 28 | 暗红徽章文字区，左侧另留状态点位置 |
| `kit/gift.png` | 640 × 150 | PNG RGBA，外围透明 | 140 / 40 / 30 / 40 | 470 × 70 | 深色礼物提示区，避开左侧礼盒 |

徽章的状态点未画入图片，可放在 `(42, 45)` 附近，建议半径 4 px。房间中央下方 `(650, 800)` 至 `(1250, 1050)` 为木地板留白参考区；角色可以向上延伸覆盖背景。房间右上方暗墙适合叠加节目牌。

组件中的深色区域配浅米色 `#ece3cf` 文字；便签配深色文字。徽章保留暗红色蜡质内区。边缘均保留真实 alpha，未使用品红底；窄条组件去除多余透明画布后等比缩放，再透明补边到表中尺寸。

## 生成提示词记录

以下为本套图片使用的提示词要点；每次生成都复述共同风格与禁止项，每张单独调用生成工具。

共同风格：Japanese anime background art, clean linework, compatible with a cute chibi whale maid but draw no character. Quiet, secluded, slightly chilly rainy-night old study / attic, late-night storytelling radio atmosphere. Ink blue black `#12151c`, deep ink green `#1b2622`, aged cream `#e9dfc6`, muted candle gold `#e0b45a`, dark red `#a3342b`. Aged bronze / dark wood borders with restrained wear. No text, lettering, numbers, watermark, people, silhouettes, faces, skulls, blood, monsters, ghosts or horror imagery. One standalone asset per image, never a full livestream screenshot.

- **room**：1920 × 1080 opaque landscape, straight-on old study. Large rain-streaked window on left, distant diffused streetlamp; one old desk lamp in middle-right rear as the only warm interior light. Bookshelves, antique clock without numerals, unlit candles, keys and landscape picture frames. Wooden floor, empty central lower foreground, quiet upper third and rightmost quarter.
- **board**：1280 × 800 front-on dark corkboard / blackboard, thin aged bronze and dark wood frame, four copper corner nails, one plain dark red wax seal on top frame. Flat dark `#1d1915` blank interior with extremely faint grain; decoration confined to border. Genuine transparent PNG exterior.
- **subtitle**：1500 × 180 very long thin horizontal dark old wood / leather strip, modest copper end caps, blank dark interior, no hanging objects or icons. Genuine transparent PNG exterior.
- **plaque（最终版）**：900 × 220 long slim dark wood program sign, thin bronze edging, two tiny twine loops tucked against top edge. One small candle contained in far-left end; main blank dark interior starts after left 14 percent. No books, feather, ink bottle, foliage, drapery, wax seal, diamonds or flourishes. Genuine transparent PNG exterior.
- **note**：480 × 200 aged cream `#e9dfc6` horizontal paper strip, worn irregular corners, one tiny copper pushpin and short twine at upper center. Large flat light writing interior, no rules or ink stains. Genuine transparent PNG exterior.
- **badge**：260 × 90 dark red `#a3342b` wax / leather capsule with restrained bronze edge, smooth blank red center. Reserve empty left fifth for a future status dot, do not draw dot or lettering. Genuine transparent PNG exterior.
- **gift**：640 × 150 dark old wood plaque, thin candle-gold and aged copper edge, one small closed dark red gift box with antique gold ribbon in left icon zone. Remaining center and right blank dark `#1d1915`; no cords, candles or wax seal. Genuine transparent PNG exterior.

## 检查与重做

逐张查看生成原图及最终 PNG，检查无文字、人物或恐怖元素，文字内区留白，组件外围具有透明通道；并核验实际文件格式、尺寸和安全区 alpha。

节目牌 `kit/plaque.png` 重做 1 次：首版左侧额外出现书本、羽毛笔、植物等装饰，且吊绳较长；最终版简化为短绳环和小蜡烛。其余 6 张未重做。首版未放入本目录。
