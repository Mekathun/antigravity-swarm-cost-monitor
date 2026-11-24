# Swarm Cost Monitor

> **零依赖 Antigravity 侧边栏插件**：实时监控每个 **Swarm / Worker** 的费用与 Token 占比、多模型消耗拆解、**当前会话上下文窗口（Context Window）** 占用，以及 Gemini / Claude 实时账户额度仪表盘。

[English](README.md) · [简体中文](README.zh-CN.md)

![Node.js](https://img.shields.io/badge/Node.js-20%2B-339933?logo=node.js&logoColor=white)
![Zero Dependencies](https://img.shields.io/badge/Dependencies-Zero-0ea5e9)
![Antigravity Plugin](https://img.shields.io/badge/Antigravity-Auxiliary%20Pane-6366f1)
![License: MIT](https://img.shields.io/badge/License-MIT-amber)

---

## 为什么做这个插件？

普通的配额插件只能看到账号级别的总体剩余百分比。但在运行多 Agent **Swarm** 或长对话时，你真正关心的是：**哪个 Swarm、哪个 Worker、哪个模型花掉了最多预算**，以及**当前会话的上下文窗口还剩多少空间**。

**Swarm Cost Monitor** 以只读方式直接解析本地 Antigravity 运行日志（`~/.gemini/antigravity/brain/`），优先读取每一步 `PLANNER_RESPONSE` 记录的**精确** `input_tokens`、`cache_read_tokens`、`output_tokens` 与 `model`（仅在缺失时回退到中英文分比例估算），全程零外部依赖、零 CDN，完美适配 Antigravity 侧边栏暗/亮色主题。

---

## 核心特性

### 1. Swarm 花费与多模型归因（`Swarm 花费` 标签页）
- **跨 Swarm 占比**：自动发现本地原生 Swarm（`.system_generated/swarm/`）与独立子代理树，展示每个 Swarm 的花费与 Token 占比。
- **Worker 精细拆解**：交互式 SVG 环形图 + 堆叠占比条 + 可排序 Worker 卡片（`coordinator`、各 Worker、`monitor`、`narrator`）。
- **单条多模型颜色叠加**：当同一个 Worker 中途切换过模型（例如先用 `Claude Opus 5.5`、再切到 `Gemini 4 Neon`），横条会自动按各模型颜色分段叠加，展开即可查看每个模型的费用、占比与调用次数。
- **多维度指标与时间线**：支持按 **费用 (`$`) / Token / 步数与工具调用** 切换，并提供累计花费时间线。

### 2. 当前会话上下文窗口监控（`上下文窗口` 标签页）
- **严格隔离当前会话**：仅展示当前所在会话的上下文窗口占用（不会串入其他对话）。
- **填充度与预警线**：展示 `已用 / 上限`、剩余空间、60% / 80% 预警刻度、Cache 命中率，以及超过 75% 时的 `/compact` 压缩建议。
- **上下文构成拆解**：参考 Claude Code `/context` 与 `agy-hud`，拆分为 **系统提示与工具定义、工具调用与返回、助手回复、思考过程、用户输入、系统通知** 六大类别。
- **逐轮增长曲线与 Top 8 占用步骤**：可视化每轮对话的上下文增长曲线与自动压缩（Compaction）标记，并列出当前活跃窗口内占用最高的 8 个步骤。

### 3. 左下角常驻额度监控与设置
- **锚定在插件「设置」按钮正上方**：
  - **最小（Mini）**：仿 Codex 风格的双 **3/4 圆弧（270°）** 仪表盘，分别显示 **Gemini 5h (`G`)** 与 **Claude 5h (`C`)** 剩余额度，悬停查看精确百分比与重置倒计时。
  - **紧凑（Compact）**：双列迷你横向进度条。
  - **最大（Expanded）**：完整多横条面板，含套餐等级、Prompt/Flow Credits、可折叠 27 模型明细，以及可选的 **「显示周额度」**（官方窗口识别 + 近 7 天本地统计）。
- **智能自适应轮询**：有会话在运行时按 5s 刷新，全部空闲时自动降频至 30s，且通过数据签名比对跳过无变化 DOM 重绘（彻底杜绝 5 秒闪烁）。
- **中英双语切换**：在设置中一键切换 `中文 / English`，配置自动持久化保存。

---

## 安装方式

**Windows (PowerShell)：**
```powershell
git clone https://github.com/Mekathun/antigravity-swarm-cost-monitor.git
cd antigravity-swarm-cost-monitor
.\install.ps1
```

**macOS / Linux：**
```bash
git clone https://github.com/Mekathun/antigravity-swarm-cost-monitor.git
cd antigravity-swarm-cost-monitor
chmod +x install.sh && ./install.sh
```

安装完成后，在 Antigravity 的 **Customizations → Plugins** 中启用 **Swarm Cost Monitor**，或直接打开面板：
```markdown
[Swarm Cost Monitor](sidecar://swarm-cost-monitor/swarm_cost/)
```

### 独立浏览器调试模式
```bash
cd sidecars/swarm_cost
PORT=43123 node main.mjs
# 访问 http://127.0.0.1:43123/?conversationId=<会话ID>
```

---

## 隐私与资源占用

- **100% 本地只读**：仅读取本地 `~/.gemini/antigravity/brain/` 与本地 Language Server (`127.0.0.1`) 状态，不上传任何数据、零外部请求。
- **极低系统开销**：基于 `mtime + 文件大小` 的增量缓存，命中缓存扫描仅需 `< 0.1 ms`，常驻内存约 `50–80 MB`，空闲降频后几乎零 CPU 占用。

---

## 开源协议

[MIT](LICENSE)
