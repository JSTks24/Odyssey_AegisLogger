# Odyssey AegisLogger

作者本人为使用「类脑」而特殊定制的 Vencord 消息留档插件。消息被删除、被编辑之后不再无迹可寻。

## 功能

- 删除 / 编辑 / 幽灵 Ping 消息全部留档，存在本地 IndexedDB，重启 Discord 也不丢
- 每次编辑时的附件状态独立留档（修掉了上游纯删图不记录的 bug）
- 日志查看器：来源行（服务器 › 频道 · 作者 · 时间）可点击跳转，Discord 式搜索筛选（`user:` / `server:` / `has:` 等语法 + 可删除的筛选芯片），滚动自动加载
- 服务器 / 频道 / 用户粒度的黑白名单：白名单为空时记录所有服务器，设了白名单则只记录白名单与私信；右键任意服务器 / 频道 / 用户即可加入或移出名单
- 作用域正则排除规则，命中的消息不计入日志（幽灵 Ping 例外）
- 删除附件保存（可限制大小与扩展名）、日志导入导出、图片缓存目录管理
- 中英双语界面

## 安装

### Windows 安装

前置条件：[Git](https://git-scm.com/downloads)、[Node.js](https://nodejs.org) 22.20 及以上的 22.x、24.12 及以上的 24.x，或 25 及以上。安装使用 Git 仓库维护版本与更新状态，ZIP 解压目录不能作为安装源。

```cmd
git clone https://github.com/JSTks24/Odyssey_AegisLogger.git
cd Odyssey_AegisLogger
install.cmd
```

脚本在当前电脑克隆 Vencord 到本仓库下的 `Vencord\`，按宿主 `packageManager` 声明准备本地 pnpm，使用锁文件安装宿主依赖，再复制插件源码、构建并进入 Vencord 的 Discord 注入流程。已有 Vencord 源码保持当前版本，其他插件保留；目标插件目录被未知内容占用时停止并提示处理。

已有 Vencord 可显式指定路径；以下命令只准备源码和构建，不执行 Discord 注入：

```cmd
install.cmd --vencord-dir "D:\Projects\Vencord" --no-inject
```

网络需要代理时：

```cmd
install.cmd http://127.0.0.1:7890
install.cmd http://127.0.0.1:7890 "D:\Projects\Vencord"
```

旧版 `[代理地址] [Vencord目录]` 参数继续可用。代理传递给本次 Git 和依赖下载过程，不写入全局 Git／npm 配置。也可直接运行 `node scripts/install.mjs`，参数与 CMD 入口相同。

安装完成后手动重启 Discord，到 设置 → Vencord → 插件 启用 AegisLogger。插件安装采用受管理的源码副本；复制整个仓库或创建 junction 的手动方式不再是安装步骤。已有旧 junction 会在校验归属后迁移，联接指向的源码保留。

### 更新与恢复

重复运行 `install.cmd` 或使用插件内更新按钮，两者调用同一套更新流程。检查当前分支的 upstream，仅快进插件源码；本地修改、分叉、游离 HEAD、缺少 upstream 时停止并给出原因，不丢弃本地工作。

```cmd
node scripts/install.mjs --check --json
node scripts/install.mjs --update --no-inject
```

安装记录 `.aegislogger-install.json` 保存当前机器的源码、宿主位置和最后成功构建版本，不纳入发布。构建前保留旧插件副本与运行产物，失败恢复旧运行版本。已经拉取源码但构建失败时显示待重新构建，重试无需再出现新提交；成功构建后需要手动重启 Discord 才会加载新版本。

### 数据与卸载

源码、安装记录和构建文件位于选择的源码／宿主目录。Discord 注入会修改所选客户端；Vencord 设置位于 `%APPDATA%\Vencord`，消息日志位于 Discord 的 IndexedDB，原生附件数据默认位于 `%APPDATA%\Vencord\AegisLoggerData` 或插件设置指定的目录。

移除插件时先在 Vencord 设置中禁用 AegisLogger，删除宿主内受管理的 `src\userplugins\odyssey-aegis-logger` 副本并重新构建、重启。卸载整个 Vencord 应使用宿主的 `pnpm uninject` 或 Vencord 安装器的卸载功能。删除源码文件夹不会自动还原 Discord 注入或清除设置、消息和附件数据；数据清理由插件设置中的对应功能执行。

## 开发

```bash
pnpm install --frozen-lockfile
pnpm test
```

使用 `package.json` 声明的 pnpm 版本。测试覆盖 IndexedDB 数据层、迁移流程、查询引擎、消息过滤矩阵、本地化完整性、安装更新行为和发布隐私。普通测试不依赖固定位置的 Vencord。

宿主相关类型检查先显式生成本机配置：

```cmd
node scripts/prepare-host.mjs --vencord-dir "D:\Projects\Vencord"
pnpm exec tsc -p tsconfig.host.json --noEmit
```

`tsconfig.host.json` 为忽略的本机配置，跨盘路径也可使用；仓库内的 `tsconfig.json` 不会被安装改写。未生成宿主配置时，测试报告明确跳过依赖真实宿主的标识符检查。

`scripts/evidence-mangle.mjs` 仅用于显式提供 WebSocket、输出目录及三条 `/channels/...` 路径的本机验收；仓库不附带真实服务器、频道或消息定位。输出可能含当前客户端信息，属于本机资料，不作为发布内容。

`scripts/accept-b01.mjs <WebSocket> <输出目录>` 默认检查 Blob URL 的格式和本次事件，不引用历史本机报告。需要对照历史异常时，添加 `--historical-blob-source <JSON文件>`；JSON 至少包含 `url`，可附 `report`、`scenarioId` 和已知的 `messageId`／`elementId`／`requestId`／`provenance`。历史资料只作为证据来源，不代替本轮实际复现。

## 致谢

本项目基于 [vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 修改开发：

- 原项目：vc-message-logger-enhanced — https://github.com/Syncxv/vc-message-logger-enhanced
- 原作者：© Syncxv 及其贡献者
- 原项目许可证：GPL-3.0-or-later

感谢原项目作者的工作。本项目是原项目的修改版本，依照 GPL-3.0-or-later 以同样方式开源。

## 许可

[GPL-3.0-or-later](./LICENSE)
