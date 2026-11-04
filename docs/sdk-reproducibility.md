# SDK 来源、重建与 CI

源码固定为私有 `rayson-x/reelmorph-agent@c73ac74f9a5479586f0ea5d39f5c40d2dc39a98b`。公开仓只保存桥接代码；源码快照、依赖、生成组件和录制资源均留在忽略目录。

## 本机核验

```sh
AIVTB_SDK_REPO=/authorized/path/reelmorph-agent node scripts/sdk-doctor.mjs
```

doctor 从固定 Git 对象读取 runtime manifest 和 pnpm lockfile，逐一解析本机真实安装的46个依赖并比较版本，输出 lockfile hash、依赖版本与包声明的 license 到 `.deps/sdk-doctor.json`。不读取或打印凭据；版本不一致会失败。它核验的是本机实际闭包，不伪称已在另一台机器重装成功。

独立重建须使用授权的干净检出：checkout上述commit，Node 24与pnpm 10.33.0，执行 `pnpm install --frozen-lockfile`，再把 `AIVTB_SDK_REPO` 指向该检出运行doctor与SDK检查。不能拿当前HEAD替换固定版本，也不能为让检查通过而临时改写锁文件。

## CI

`.github/workflows/check.yml` 的public job安装公开仓的锁定依赖，跑类型检查、领域/宿主测试与构建。没有私有源时，SDK专用测试明确skip，不计为私有集成成功。

手动workflow dispatch选中sdk_integration后，private-sdk job需要仓库secret `AIVTB_SDK_SSH_KEY`。对应公钥只作为私有源仓库的只读Deploy key，不能push，也不获得其他仓库访问权。工作流检出固定commit并按固定lockfile安装，跑doctor及真正的SDK/Film检查。未提供授权则明确失败。默认PR与fork不接触此secret；检出不保留凭据，工作流不上传私有源码/制品。密钥配置与私有CI实际成功须分别核验。

使用的是[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)与[pnpm/action-setup](https://github.com/pnpm/action-setup)的官方接口。

## 许可边界

doctor中的license是包自身声明的清单，不是商业授权结论。Remotion等依赖的适用条款、组织规模与运营用途须按实际情况确认；本地源码可读、无用户或测试通过，都不能证明已购买商业授权。项目没有把私有SDK实现公开发布，也没有自动替用户购买或接受额外商业许可。

## 2026-11-04 远端验证

只读Deploy key与Actions Secret已配置；[workflow run 41766787217](https://github.com/rayson-x/dsh-vtb/actions/runs/41766787217) 的public和private-sdk均成功。私有源固定提交检出、46项依赖版本核对以及真实SDK/Film Node检查已在干净Ubuntu runner运行。此前冷缓存的并发初始化暴露ENOTEMPTY目录发布冲突，已通过独立临时目录和原子发布处理；新增三进程冷缓存回归。本记录证明技术重建与访问链路，不扩大私有源码公开范围，也不代替依赖商业许可判断。
