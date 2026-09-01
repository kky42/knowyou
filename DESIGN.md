# knowyou — an agent-agnostic background memory layer

一个纯后台的记忆层:定期扫描各 agent harness 的 session 文件,蒸馏成记忆条目,
池满后折叠进长期记忆,溢出内容归档。Agent 侧唯一的集成点是全局 `AGENTS.md` 里的几行说明。

## 设计原则

1. **Agent-agnostic**:核心只依赖"session 会落盘在可预测位置"这一事实,不依赖任何扩展 API。
   集成面 = 读三个文件 + AGENTS.md 四行指令。
2. **纯文件,无运行时**:所有状态都是 markdown/yaml/json,agent 用 read/grep 就能用,
   人类用编辑器就能审。没有数据库、没有 socket、没有常驻服务进程。
3. **确定性优先**:扫描、水位、渲染全部是确定性代码;LLM 只出现在两处
   (observation 蒸馏、consolidation 折叠),且都是无状态的一次性调用。
4. **每层有界**:observations 池有上限,MEMORY.md 有配额,溢出只往下一层走(journals),不丢失。
5. **Agent 只读**:agent 在会话内对 `~/.knowyou/` 无写权限(靠指令约束),写入只有 `knowyou` 一条路径。

## 目录布局

```
~/.knowyou/
  INDEX.md            # 渲染产物:观察简表(一条一行)
  MEMORY.md           # 长期折叠记忆(有配额)
  observations/       # 记忆池:一次 observation 一个文件,最多 MAX_OBSERVATIONS 条
    YYYY-MM-DD-hh-mm-ss.md
  journals/           # 归档层:consolidation 时从 MEMORY.md 挤出的内容
    YYYY-MM-DD-hh-mm-ss.md
  .state.json         # 水位:哪些 session 文件的哪些部分已消化(增量、幂等)
  config.yaml         # 全部配置
```

## 各文件规格

### INDEX.md(渲染产物,机械生成,可随时重建)

- 纯列表:每条 observation 一行,一句话摘要 + 文件引用
- 不渲染 journals(它们已离开活跃记忆;agent 需要时按规则关键词检索)
- 不含指令——使用说明放在全局 AGENTS.md,INDEX 保持纯数据

```markdown
# Observations

- [2026-07-14 10:30] 确定了 knowyou 用纯年龄 FIFO 折叠,不做类型分流 (observations/2026-07-14-10-30-00.md)
- [2026-07-14 09:12] om 的 consolidation 是吸收不是删除,tombstone=水位 (observations/2026-07-14-09-12-00.md)
...
```

### MEMORY.md(长期折叠记忆,有配额)

- 由 consolidation 逐步折叠而成:多轮 observation 合并、去重、newest-wins
- 自由 markdown,按主题分节(节的结构由 LLM 在折叠时维护,不预设分类法)
- 配额:**max 500 lines / 20000 chars**(零和:写入必须指明挤出什么)

### observations/YYYY-MM-DD-hh-mm-ss.md(记忆池条目)

- 一次 observation 蒸馏 = 一个文件,文件名 = 写入时间
- front-matter:来源 session 路径、覆盖的 chunk 范围、主题标签
- 正文:这次蒸馏出的记忆内容(原子、自包含)
- 被 consolidation 吸收后**从池中删除**(信息已活在 MEMORY.md 里,池是缓冲不是档案)
- agent 按需读取(INDEX 的一行引用就是入口)

### journals/YYYY-MM-DD-hh-mm-ss.md(归档层)

- 每次 consolidation 时,从 MEMORY.md 挤出的内容记录在此,concise 措辞
- 不重要(已移出长期记忆)、但是历程的一部分;agent 仅在需要时关键词检索
- 无配额、只增不删

### .state.json(水位)

```jsonc
{
  "sessions": {
    "<session-file-path>": { "size": 123456, "mtime": "...", "processedChunks": 3 }
  }
}
```

- 每 30 分钟的扫描只处理增量;重复扫描、进程重启都幂等
- 会话文件 mtime/size 未变 → 跳过

### config.yaml

```yaml
schedule:
  updateEverySeconds: 1800      # 扫描/更新周期(默认 30min)

scan:
  windowDays: 7                 # 只看最近 7 天的 session;更早的一律忽略
  minNewChars: 20000            # 未扫增量的消息文本(不含系统提示/scaffolding)超过此值才蒸馏
  minUserTurns: 2               # 过滤一次性/噪声会话
  redactSecrets: true

agent:                          # 后台 LLM 用的 runner
  runner: pi                    # pi | codex(pi 用 `pi -p`,codex 用 `codex exec`,后面加)
  model: <provider/model>       # 可选;省略则使用 Pi 的默认模型
  thinking: low                 # 可选;省略则使用 Pi 的默认 reasoning effort

limits:
  maxObservations: 30           # 池上限;超过触发 consolidation
  maxObservationChars: 500      # 单条 observation 正文的字符上限(~一句话摘要量级)
  maxMemoryChars: 20000         # MEMORY.md 配额(只按字符,不按行)
```

## 工作流

后台服务 = 一个循环(或 launchd/cron 周期调用),每轮三步:

```
knowyou run
  (A) observe      → (B) consolidate → (C) render
```

### 扫描(vendored backpass 代码 + 字节偏移水位)

`src/scan/backpass/` 内是 backpass discovery 层的逐字拷贝(MIT,见该目录 README):
shared.js、interaction.js、adapters/{pi,claude,codex,grok}.js。上游更新时直接重新拷贝、
只重放 README 里列出的微量修改。`src/scan/adapters.ts` 是 glue 层:时间窗口过滤(在
enumerate 层完成,窗口外文件根本不返回)、字节偏移增量读取、每 harness 的消息映射
(标注镜像自上游哪个 read())、secrets 脱敏、阈值计数。knowyou 自己的逻辑只存在于
glue 层和管线编排。

- **适配器三件套**:每个 harness 实现 `enumerate()`(枚举 session 文件: path/mtimeMs/bytes)、
  `classify()`(只读文件头几行拿 cwd/id,便宜)、`read()`(解析成消息事件)。目前支持 pi、codex、
  claude、grok;默认扫描全部,配置 `scan.harnesses` 后覆盖默认列表
  (`~/.pi/agent/sessions/<escaped-cwd>/*.jsonl` 仅是 pi 的存储示例)
- **scan-cache**:`.state.json` 以文件路径为键,未变化的文件 O(1) 跳过
- **fail-soft**:某个 harness 存储缺失/格式漂移 → 命名警告后跳过,整轮不失败
- **self-exclusion**:knowyou 自己的 runner(pi -p / codex exec)产生的 session
  必须被识别并排除,否则后台 agent 会观察自己,无限自噬

在 backpass 之上,knowyou 增加一层它没有的**字节偏移水位**(backpass 文件一变就整读;
我们只处理增量):

- 水位 = 每个 session 文件已处理到的**字节偏移**(对齐最后一个完整换行;
  pi session 是 append-only JSONL,追加安全)
- `size > offset` → 读 `[offset, EOF)`,对齐到最后的完整 `\n`,只解析这段新行;
  `size < offset` → 文件被截断/重写,offset 归零整读
- **计入口径**:只统计新增部分中 user/assistant/toolResult 消息的文本字符
  (系统提示词、harness scaffolding、custom 条目一律不计),tokens ≈ chars/4 仅作展示
- **触发阈值**:未扫增量(按上述口径)超过 `minNewChars` 才蒸馏并产出一条 observation;
  不足则只推进水位,不调 LLM。低于阈值的碎片会累积到下一轮一起算
- **预处理**:蒸馏前做确定性压缩(tool-call 折行、截断输出、redact secrets),典型压缩 95%+

### (A) Observation

- 对每个合格 chunk 调一次 LLM(runner: `pi -p`,prompt 借鉴 om 的 observer prompt):
  从原始对话 chunk 蒸馏出原子记忆条目
- 产出写入 `observations/YYYY-MM-DD-hh-mm-ss.md`,同步更新 `.state.json` 水位

### (B) Consolidation

- 触发条件(机械判断):`observations/` 条数 > maxObservations
- 动作:**纯按年龄 FIFO**,取最旧的一批(约 10 条)调 LLM(借鉴 om 的 consolidator prompt)
  折叠进 MEMORY.md:
  - 与已有 section 合并、去重;冲突时最新覆盖旧的(newest-wins)
  - preference/fact/decision 一视同仁——只要是必要的,就该进长期记忆,所以不分类型分流
- 折叠完成后**删除**池中已被吸收的条目
- **零和挤出**:若 MEMORY.md 超过 500 行/20000 字符,把最旧的 section 内容以 concise
  形式移入 `journals/YYYY-MM-DD-hh-mm-ss.md`(按写入时间命名),MEMORY.md 回到配额内

### (C) Render

- 机械重渲染 `INDEX.md`(从 observations/ 的 front-matter + 一行摘要),无 LLM

## Agent 侧集成(唯一的集成面)

在对应 harness 的全局指令文件(如 `~/.pi/agent/AGENTS.md`)添加四行:

```markdown
- 阅读 ~/.knowyou/INDEX.md 了解最近的观察事件
- 阅读 ~/.knowyou/MEMORY.md 获取长期记忆
- ~/.knowyou/journals/ 含更早期的归档记忆,仅在需要时按关键词检索(grep)
- 不可编辑、修改、删除 ~/.knowyou 中的任何内容;写入由后台服务独占
```

## 命令

| 命令 | 效果 |
|---|---|
| `knowyou run` | 跑一轮完整管线(scan → observe → consolidate → render) |
| `knowyou scan` | 只跑扫描+观察(A):报告各 session 的增量与是否达标,产出 observation;不触发 consolidation。开发测试用,也用于预览下一轮会扫到什么 |
| `knowyou start` | 注册定时任务(launchd StartInterval = updateEverySeconds;Linux 落 crontab) |
| `knowyou stop` | 取消定时任务 |
| `knowyou status` | 定时任务是否注册、池条数、MEMORY.md 占用、水位概况、上次运行时间与错误 |

无 `--loop`,无常驻进程:`start` 把调度交给 OS(launchd/cron),`run` 是它周期拉起的一次性命令,
`scan` 是人为触发同一管线的入口。

## 借鉴来源

- **backpass**:跨 harness 的 session 存储扫描(适配器 + 增量缓存 + soft-fail)、
  蒸馏前置的确定性压缩、secrets redaction
- **observational-memory**:observer/consolidator 的 prompt 设计、"折叠是吸收不是删除"、
  newest-wins、每层有界、INDEX 由结构机械渲染
- **headlong**:记忆就是可 grep 的纯 markdown、归档层(≈journey 的"压缩旧段"独立成层)

## v1 范围与非目标

**v1 做**:pi/codex/claude/grok 适配器、全局层(~/.knowyou)、三步管线、config.yaml、四行 AGENTS.md 集成。

**明确不做(v1)**:
- 项目层(`<project>/.knowyou/` + STATUS.md)——暂不加入,机制留好复用空间
- 多 runner(先 pi;codex 适配加起来很快,但 v1 不做)
- 跨项目佐证门槛、recall 语义检索、向量库、daemon/socket、agent 会话内写入

**后续路线**:项目层(复用同一套管线,加 STATUS.md)→佐证门槛(全局池要求 ≥2 独立 session)→
`knowyou search`(语义检索 journals)。
