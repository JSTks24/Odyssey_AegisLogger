# Odyssey AegisLogger

为「类脑」定制的 Vencord 消息留档插件。消息被删除、被编辑之后不再无迹可寻。

## 功能

- 删除 / 编辑 / 幽灵 Ping 消息全部留档，存在本地 IndexedDB，重启 Discord 也不丢
- 每次编辑时的附件状态独立留档（修掉了上游纯删图不记录的 bug）
- 日志查看器：来源行（服务器 › 频道 · 作者 · 时间）可点击跳转，Discord 式搜索筛选（`user:` / `server:` / `has:` 等语法 + 可删除的筛选芯片），滚动自动加载
- 服务器 / 频道 / 用户粒度的黑白名单：白名单为空时记录所有服务器，设了白名单则只记录白名单与私信；右键任意服务器 / 频道 / 用户即可加入或移出名单
- 作用域正则排除规则，命中的消息不计入日志（幽灵 Ping 例外）
- 删除附件保存（可限制大小与扩展名）、日志导入导出、图片缓存目录管理
- 中英双语界面

## 安装

### 一键安装（Windows）

1. 下载本仓库：点 `Code` → `Download ZIP` 解压，或者

   ```
   git clone https://github.com/JSTks24/Odyssey_AegisLogger.git
   ```

2. 双击仓库根目录的 `install.cmd`。脚本会检查并补齐 Node.js / pnpm 环境，把 Vencord 源码克隆到**本目录下的 `Vencord\`**，编译本插件并注入 Discord，过程中需要确认的地方都有提示。脚本产生的文件全部留在这个目录里，不会写进您的用户目录；卸载时删掉整个文件夹即可。
3. 如果网络不通（GitHub 直连失败），带代理地址重跑：

   ```
   install.cmd http://127.0.0.1:7890
   ```

安装完成后重启 Discord，到 设置 → Vencord → 插件 里启用 AegisLogger。以后想更新插件，重新跑一遍 `install.cmd` 即可，脚本可以反复执行。Vencord 自己的设置目录是 `%APPDATA%\Vencord`，由 Vencord 自身维护，与本脚本无关。

### 手动安装

前置条件：[Node.js](https://nodejs.org) ≥ 22、[pnpm](https://pnpm.io)、git。

```bash
git clone https://github.com/Vendicated/Vencord.git
cd Vencord
pnpm install
mklink /J src\userplugins\odyssey-aegis-logger <本仓库的本地路径>
pnpm build
pnpm inject
```

`pnpm inject` 按提示选择 Discord Stable 即可。开发模式下之后更新插件只需重新 `pnpm build` 并重启 Discord。

## 开发

```bash
pnpm install
pnpm test
```

测试覆盖 IndexedDB 数据层、迁移流程、查询引擎、消息过滤矩阵与本地化完整性。

## 致谢

本项目基于 [vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced) 修改开发：

- 原项目：vc-message-logger-enhanced — https://github.com/Syncxv/vc-message-logger-enhanced
- 原作者：© Syncxv 及其贡献者
- 原项目许可证：GPL-3.0-or-later

感谢原项目作者的工作。本项目是原项目的修改版本，依照 GPL-3.0-or-later 以同样方式开源。

## 许可

[GPL-3.0-or-later](./LICENSE)
