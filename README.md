# Odyssey AegisLogger

基于 [vc-message-logger-enhanced](https://github.com/Syncxv/vc-message-logger-enhanced)（GPL-3.0-or-later，© Syncxv & contributors）深度改造的 Vencord 消息日志插件。

## 功能

- 删除 / 编辑 / 幽灵 ping 消息留档（IndexedDB）
- 编辑时删除附件独立留档（上游 bug 修复）
- 日志行显示来源服务器 / 频道 / 作者 / 时间
- 按人 / 服务器 / 内容筛选（语法提示 + 右键快捷筛选）
- 带作用域的正则排除规则（命中不计入日志）

## 测试

```bash
pnpm install
pnpm test
```

## 许可

GPL-3.0-or-later，见 LICENSE。
