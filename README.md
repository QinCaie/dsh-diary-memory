# dsh-diary-memory

把「日记 / 长期记忆」做成标准 DSH 插件。原来那套散装件（独立 MCP 进程、PowerShell 合并脚本、启动器里的备份步骤）全部收进插件里。

## 它替代了什么

| 原来 | 现在 |
|---|---|
| `src/mcp-diary.js` 独立 MCP 进程 | 插件内直接注册 5 个工具 |
| `scripts/diary-merge.mjs` 靠启动脚本调用 | 插件内定时器（默认 5 分钟） |
| `scripts/backup-memory.ps1` 靠启动脚本调用 | 插件内定时器（每 6 小时检查，每天一份） |
| 提示词里叫她自己调 `briefing` | 每天首轮**原生注入**（`agent/pre-step`） |

存储格式**完全不变**：还是那个单文件 jsonl，还是「传入 / 已合并」的无损合并。历史数据不用迁移。

## 数据布局

```
<dataDir>/                     默认 D:\Ayu\日记
├─ 大肥鱼的日记.jsonl          所有记录，一行一条
├─ 传入/                       换机器时把旧文件粘这里
├─ 已合并/                     合并完的原件，带时间戳前缀
└─ config.json                 运行期配置（设置页写的那份）
```

## 工具

| 工具 | 作用 |
|---|---|
| `diary_write` | 写一条「日记」或「今天」 |
| `diary_remember` | 更新长期记忆某一类（**整体替换**，条目用「；」分隔） |
| `diary_recall` | 按关键词翻（含归档） |
| `diary_briefing` | 取一份简报 |
| `diary_status` | 看条数 / 字数 / 路径 / 开关 |

## 记忆清晰度（2026-11-07 加）

借了 HCEM 插件「记忆模糊度」的思路（只借这一条，不借那套情绪打分）：

- 每条记忆有个 **清晰度 0–1**：按写入时间衰减（半衰期 120 天），被 `diary_recall` 翻到会加一点。
- `diary_recall` 每条结果带 `清晰度` 和 `记得`（清楚 / 大概 / 模糊 / 淡了）；低于 0.45 时会另给一句「模糊提醒」——翻出来不等于记得清，说的时候要打折。
- `diary_write` 加了个 `重要: true`：衰减慢四倍、清晰度不低于 0.85，留给真正要记一辈子的。
- 清晰度 < 0.35 的算「淡了」：不进简报正文，只在简报尾巴上说一句还有几条。

**jsonl 主文件一个字不动**：使用热度单独存在 `<dataDir>/记忆使用.json`（哪条被翻过、翻过几次），删掉这个文件就回到"全都一样清楚"的状态。

## 配置

两种方式，效果一样：

1. **设置页**：DSH 设置 → 「记忆（日记）」
2. **直接改** `<dataDir>/config.json`

主要开关：日记条数与字数、长期记忆分类与上限、合并间隔、备份目标与份数、注入开关与作用域。

`inject.onlyQqSessions`（默认 true）只给 QQ 桥接的会话注入，避免污染 DSH 主界面。

## HTTP 接口

```
GET  /api/diary-memory/config     读配置
POST /api/diary-memory/config     合并式写配置
GET  /api/diary-memory/stats      统计
POST /api/diary-memory/merge      立即合并
POST /api/diary-memory/backup     立即备份
```

## 安装

```sh
dsh plugin --profile <名字> add link:D:/Ayu/plugins/dsh-diary-memory
```

然后在 profile 的 `dsh.profile.bundles` 里加上 `dsh-diary-memory`。

## 已知限制

- 注入的消息用本地构造（`{id, role, content, source}`），因为宿主 `@deepseek-ai/dsh-llm` 在当前环境里 import 不到；形状与宿主 `createMessage` 一致。
- 没有 `schemastery`，所以**不在 cordis.patch.yml 里写 `config`**（带 config 但没有 Schema 会让条目激活失败）。默认值在 `index.js` 的 `DEFAULTS`。
