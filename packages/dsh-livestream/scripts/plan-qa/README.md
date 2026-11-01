# 节目单历史诊断脚本（最终验收已交接）

最终由协调者在 aivtb-integrate 以同一集成版本连续三轮、每轮六分钟团队开加一分钟关，覆盖 plan 和 track。此目录保留原六分钟团队开诊断，不是最终验收入口；本副本不再启动大脑或长轮。report.mjs 仅生成诚实的交接报告，不宣称三轮全过。

以下历史复跑说明仅供协调者明确需要时使用：

所有命令在 `packages/dsh-livestream` 下执行；只用 3821 / 3921 / 3941。先在仓库根目录确认 `.env` 已配置密钥，勿输出其内容。

```sh
node build.mjs
node lib/console.js --port 3821 --stage 3921 --brain 3941
```

另一终端启动大脑：

```sh
curl -s -X POST http://127.0.0.1:3821/brain/start -H 'content-type: application/json' -d '{}'
node scripts/plan-qa/run.mjs 11 12 13
node scripts/plan-qa/strict.mjs 11 12 13
node scripts/plan-qa/contact.mjs 11 12 13
node scripts/plan-qa/report.mjs
```

`run.mjs` 使用 ego-browser 的同一个 `aivtb-plan 验收` TaskSpace。capture 会打开舞台并解除已显示的静音提示；首次使用请确认舞台已出声，再开始计时。若同名空间属于其他任务，换一个唯一名称并在 capture.mjs 中同步，不接管其他任务的空间。

每次使用未占用的新轮次编号；运行器拒绝覆盖现有结果和指纹文件。每轮从主播实际开口算六分钟：一分钟动态读取当前话题/节目点发点题，三分钟发礼物附言，四分半发泛化方向的主人换题。团队全程开启。每轮结束后才保存 run-N.json；所有指标逐轮判断，缺证据失败。strict 必须收到三个全部通过的轮次才返回 0。查看报告里的开讲原话，确认它实际展开要求，而非重复承诺。

联系表生成后删除 shots-N 目录里的单张 jpg，保留 jsonl 测量记录及 contact-N。收尾 POST `/brain/stop`，关闭这次启动的控制台进程，并在 ego-browser 中对本次 TaskSpace 调用一次 `finish({ keep: [] })`。不 push。
