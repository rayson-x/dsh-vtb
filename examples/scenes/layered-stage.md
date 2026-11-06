# layered-stage：可复用分层内容场景

workspaceBuildPreview({directionEpoch,taskId,taskVersion,template:"layered-stage",props:{background:"transparent",palette:"warm",layers:{...}}})。文字只放短线索，阅读时可放大对应层，不复制整段字幕。这是已有组件组合，通常无需读SDK或重写源码；超出能力再用source/其他SDK。

默认108000帧（30fps下1小时），通常省略durationInFrames，局部元素的进退交给导播。坐标1920×1080。layers为按顺序绘制的ID字典，每个元素可有kind、x、y、scale、rotate、opacity、visible、enterFrame、exitFrame、fadeFrames。先组合一套完整底场，再独立调整组件，避免逐句换场。默认透明背景可保留直播间原布景；palette为warm或quiet。帧由真实Remotion时钟推进，inspectCandidate的browser快照可读当前frame；为入退场安排未来enterFrame/exitFrame，不把估算字速当已发生的进度。

已有组件：
- window：width/height（椭圆窗，默认100），table：width/height（桌面与桌腿）。
- lamp：局部100×100，brightness 0–1、softness 0–1；配合x/y/scale控制位置和大小。
- cup、book：局部约100×100。letter：width/height、text（最多6行）、fontSize。
- shelf：width/height、emptySlot（-1无空格，0–6留空），fish：count 0–18、speed 0–5、fill。
- text：text/fontSize/fill；rect、ellipse：width/height/fill/stroke/strokeWidth；path：d/fill/stroke/strokeWidth；image：src/width/height。
- group：children同样是ID字典，可组合更多造型。

示例底场 props：
{"background":"transparent","palette":"warm","layers":{"window":{"kind":"window","x":140,"y":80,"width":720,"height":590},"fish":{"kind":"fish","x":290,"y":350,"scale":2,"count":0},"shelf":{"kind":"shelf","x":1080,"y":140,"width":560,"height":210,"emptySlot":-1},"table":{"kind":"table","x":380,"y":800,"width":1100,"height":220},"lamp":{"kind":"lamp","x":800,"y":550,"scale":2.5,"brightness":0.65,"softness":0.6},"letter":{"kind":"letter","x":1070,"y":540,"width":360,"height":240,"text":"一封没署名的来信","fontSize":28},"cup":{"kind":"cup","x":540,"y":650,"scale":1.5,"visible":false}}}

导播updateInputs的inputs直接合并场景根级字段，不套params。例：{"layers":{"lamp":{"brightness":0.4,"softness":0.9},"cup":{"visible":true}}}；新增鱼群用{"layers":{"fish":{"count":5}}}。嵌套字段增量合并，其他组件保持原样；数组整体替换。移除某层可visible=false或将该ID设null。更新须带对应proposalIds，真实painted后才算兑现；改变组件参数不必重新编译或take。

这里给的是组件能力，不替主播决定台词或替导播决定何时呈现。可以给其他主题组合出邮柜、展台、路线、标注等，或基于source临时写新效果；不要把组件目录、技术说明或这份示例文字画进节目。
