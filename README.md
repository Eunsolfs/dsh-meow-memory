# meow-memory 🐱📝 · 加固 fork

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

> **这是什么**：`Phant0Meow/dsh-meow-memory` **v0.31.1** 的个人加固 fork（本仓库，版本 **0.33.0**，分支 `hardening`）。
> 上游是 MIT 授权，上游仓库：<https://github.com/Phant0Meow/dsh-meow-memory>。本 fork **与上游无隶属关系**，不代上游发布、也不代表上游立场；所有改动与剩余问题见 [CHANGELOG.md](CHANGELOG.md)。

为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）打造的跨会话记忆插件：七层 SQLite 记忆、首轮快照注入、每消息关键词命中，以及**有预算上限**的自动整理。

当前版本 **0.33.0** ｜ 变更见 [CHANGELOG.md](CHANGELOG.md) ｜ 已实测宿主 **DSH Desktop 0.2.1-rc.2**（见[兼容性](#兼容性)）

**诚实声明**：本 README 只写代码里确实存在的行为。0.32 删掉了上游 README 里若干夸大表述（"自动去重合并"、"艾宾浩斯遗忘曲线"、每消息命中"BM25"、"兼容 dsh 0.1.5"），并在每处注明真实边界。

---

## 装之前先读：它会自动花 token

这是本插件最容易被低估的成本。**默认配置下，插件会在你不发指令时自动发起 LLM 请求**；0.32 给每一类都加了上限，但没有把任何一类关掉（保持上游默认行为，只把无界变有界）。

| 花费 | 何时发生 | 0.33 上限 |
|---|---|---|
| **静态税**：system prompt 里的记忆手册 + 全部工具描述/schema | **每一次**模型请求，哪怕这个会话一次记忆都没用 | ≈**6.7k tokens/请求**（中文包实测；英文包 ≈6.3k；随语言包与工具描述长度略变）。无法按请求关闭；要彻底不付这笔税，设 `enabled: false` 停用插件（或卸载） |
| **首轮快照**：soul / user / 全局 rules / 记忆导引 | 每个会话第一条真实用户消息前，一次 | `budget.snapshotMaxChars` 默认 **6000 字符**（≈2.7k tokens 中文） |
| **每消息关键词命中** | 第二条消息起，命中关键词时 | `hitTopK` 默认 2 条 × `budget.hitMaxChars` 默认 **1500 字符/条**（≈1.4k tokens/消息上限） |
| **压缩后重注入** | 会话压缩后的下一轮 | `budget.reinjectMaxChars` 默认 **8000 字符**（≈3.6k tokens） |
| **dream 自动整理** | 窗口空闲 ≥ `dream.idleMinutes`（默认 180 分钟）、非峰时、**该窗口有 live agent**、估算上下文 ≤ `budget.dreamMaxContextTokens`（默认 40000） | 最多 **3 轮全上下文请求**（后续轮次会重新估算上下文，超限提前收尾）；`budget.dreamMaxPerWindowPerDay` 默认 **1 次/窗口/天**，另有**进程级全局** `budget.dreamMaxPerDayTotal` 默认 **12 次/天**（N 个窗口不再 = N 倍；计数为进程生命周期滚动 24h，重启清零）。30k token 的会话一次 dream ≈ 90k input tokens；会话历史永久 +8–15k durable tokens |
| **反思（reflection）** | 单任务连续 ≥ `reflectTurns`（默认 7）个工具步后，任务结束 | **1 轮全上下文请求**；`budget.reflectMaxPerDay` 默认 6 次/天/窗口（会话），`reflectMinIntervalMinutes` 默认 20 分钟，另有**进程级全局** `budget.reflectMaxPerDayTotal` 默认 **24 次/天**（进程滚动 24h，重启清零）；上下文超 `dreamMaxContextTokens` 时跳过 |

**怎么关掉自动花费**（只关自动、手动工具仍可用）：

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    reflect: false            # 关自动反思
    dream:
      enabled: false          # 关自动 dream（/dream 与 memory_dream 手动仍可用）
```

也可以只对单个窗口关：会话行「…」菜单 → **记忆参与** → 关闭「自动注入」/「自动整理」。想彻底不花这 ≈6.7k 静态税，只能停用插件。

> **手动 `/dream` / `memory_dream` 不吃自动成本闸**（显式意愿）：不受峰时/每日频次/上下文大小闸限制（手动调用本身就在活窗口里，不需要 live-agent 自动闸），按**完整会话上下文**连跑最多 **3 轮**（atomic / topic / 项目总结）。上下文很大时请先 `/compact` 再 dream——这是唯一能显著降低手动整理成本的办法。

> 这些是**上限**，不是承诺。实际花费取决于条目数、内容长度和会话长度；最坏情况下一天的自动花费仍有量级上限（≤1 次 dream + ≤6 次反思的全上下文轮）。上下文闸里的"估算 token"是**近似值**：CJK ≈1.7 字符/token、非 CJK ≈4 字符/token（宁可估高），不是精确计费。

> **0.33 的分层存储不增加每消息 token**：只是多一个本地 SQLite 库（用户级全局库），注入条数仍受 `budget.*` 上限约束；fuzzy 补分是纯 CPU 计算、不花 token；dream/反思频次与上下文闸不变。

---

## 记忆存哪里：两层存储（0.33）

0.33 把"全局"从"单工作区内全局"改成真正的**用户级**两层存储：

```
<activeHomeDir>/global/memory.db        ← 用户级（跨工作区）
  soul / user / rules(全局)
<workspace>/<projectDir>/memory.db      ← 工作区级（每个 cwd 一份）
  project / fact / lesson / topic / rules(项目)
```

- **用户级全局库**：在全局数据目录下（`activeHomeDir()/global/memory.db`；默认 `~/.dsh-meow/global/memory.db`，可用 `homeDir` / `MEOW_MEMORY_HOME` 改）。`homeDir` / `memory_home` 切目录时全局库跟着搬。
- **工作区库**：仍按 cwd 一份，保存 `project` / `fact` / `lesson` / `topic` / 项目级 `rules`。
- **写入路由**：`memory_remember` 写 `soul` / `user`，或 `rules` 且 project 是全局标记 → **全局库**；其余 → **工作区库**。`memory_read` / `memory_update` / `memory_forget` / `memory_search` / `memory_list` / `memory_find_similar` **两库都查、按 id 去重**；同 id 时 **active 优先于 archived**（迁移后的工作区归档副本不会遮住全局正本）。`memory_project` 仍只读工作区库。
- **自动迁移（一次性）**：每个工作区的第一个可信会话会把工作区里原有的 soul / user / 全局 rules **按原 id 复制**进全局库，然后把工作区里的这些行**归档**（可恢复；避免注入与 dream 双计）。幂等标记写在工作区库 `dream_meta`（`globalmigrated:v1:<dir>`）；只对可信工作区执行，foreign 库不碰。
- **回退**：全局库不存在 / 未受信 / 不可用时，自动退回 0.32 的单工作区行为（soul/user/全局 rules 仍从工作区库读写），不报错。
- **迁移后如果全局库被删**：工作区里的原行仍是 archived，**不会自动重新注入**。恢复办法：恢复/备份全局目录，或用 `memory_forget`（`mode:'restore'`）逐条恢复工作区里的归档行。
- **备份边界（诚实声明）**：`backup.enabled` 只备份**工作区** `memory.db`，**不含全局库**；全局库请自行备份 `~/.dsh-meow/global/`（或你的 `homeDir`）。
- **dream/反思仍只整理工作区库**：全局条目靠工具/反思（每次任务后的反思轮可写全局库）维护，不进 dream 的三轮清单——已知限制。

---

## 安全模型

### 数据在哪

| 数据 | 位置 |
|---|---|
| 用户级全局记忆库（明文 SQLite） | `<activeHomeDir>/global/memory.db`：默认 `~/.dsh-meow/global/memory.db`（**在 `DSH_HOME` 之外**；可用 `homeDir` / `MEOW_MEMORY_HOME` 改） |
| 工作区记忆库（明文 SQLite） | `<工作区>/<projectDir>/memory.db`，`projectDir` 默认 `.dsh-meow` |
| 会话级"已见/查阅"留痕 | `<工作区>/.dsh-meow/sessions/<id>.json` |
| 工作区库的信任标记 | `<工作区>/.dsh-meow/.owner.json` |
| 全局库的信任标记 | `<activeHomeDir>/global/.owner.json`（installId 标记，`workspace: ''`） |
| 自忽略 `.gitignore` | `<工作区>/.dsh-meow/.gitignore`（内容 `*`，**目录自忽略**，`git add .` 不会把记忆提交进仓库） |
| 实例级全局目录（日志 / window-index / migrate 状态） | 默认 `~/.dsh-meow`（**在 `DSH_HOME` 之外**），可用 `homeDir` 或 `MEOW_MEMORY_HOME` 改 |
| prompt 文案实例覆盖层 | `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md`（固定路径，`$DSH_HOME` 缺省 `~/.dsh`；**不随 `homeDir`/`memory_home` 切换**） |

写库时会自动补 `.gitignore`（`security.autoGitignore: true`）：目录里没有就写 `*`；**已存在但缺少 `*` 行时也会追加一行 `*`**（防 `!*` 之类的重新包含规则把 `memory.db` 提交进 git）。但**不加密**：记忆正文是明文，可能含隐私/密钥。别把密钥写进记忆；`.gitignore` 只挡 git，不挡备份、同步盘和别的本地进程。

### 不信任工作区里"来路不明"的记忆库（#64-1 修复）

工作区常是 `git clone` 来的仓库——别人可以在仓库里塞一个 `.dsh-meow/memory.db` 或 `PROJECT.md`，让 AI 零交互把攻击者写的 soul/user/全局 rules 当成用户长期记忆注入。

0.32 的规则：

- 插件只会信任**自己创建的**库，或带有效 `.owner.json` 标记的库。标记必须同时满足：`schema=1`、`installId` 等于本机**随机安装 id**（持久化在 `$DSH_HOME/storages/meow-memory/install-id`，不是机器指纹）、且记录的 `workspace` 与当前工作区一致。伪造标记、他机标记、被搬到别的工作区的标记一律拒绝；install-id 无法持久化时标记校验 **fail-closed**；
- `workspace` 路径比较经 **realpath 归一**：通过 junction / 映射盘 / subst 别名打开同一个库不再被误判 foreign（修掉"换个入口就锁死"）；realpath 解析不了的别名仍按 fail-closed 拒绝（尽力而为）；
- **只有库文件根本不存在时**才自动创建并信任。**任何已存在的 `memory.db`——哪怕是空表/schema-only——都按 untrusted 处理**（防止"预置空库 + SQLite trigger"在写入时投毒）；
- untrusted 库**不会被正常聊天轮打开**：不升级 schema、不建索引、不迁移、不读；只有一次只读探针会碰文件。它的内容不注入，**所有记忆工具（读和写）、dream 与反思全部拒绝**，会话里提示一次如何信任（`security.trustWorkspaceMemory: true`）；
- 直到你显式信任、或删除/改名该库。确认库是你自己的再打开；
- `autoMigrate` **默认改为 `false`**：不再自动把工作区里的 `PROJECT.md` 导入记忆库。
- **全局库同样过信任闸**：`<activeHomeDir>/global/.owner.json`（installId 标记、`workspace: ''` 无工作区绑定）；库不存在 → 自动创建并信任，已存在但无有效标记 → **foreign**。全局库 foreign 时自动退回 0.32 单工作区行为（不读/不写全局），**没有 `trustWorkspaceMemory` 这类配置信任档**；从别的机器复制/同步来的全局目录会被判 foreign。

### `memory_home` 默认只读（#64-2 修复）

`memory_home` 是模型可直接调用的工具。旧版可把全局目录整体搬走（日志 / window-index / migrate 状态等实例数据的落点随之迁移），模型不该有这种文件系统副作用。

0.32 起：

- 默认 `security.allowHomeSwitch: false`，`memory_home` **只能查询**，切换请求会被明确拒绝；
- 需要模型能切目录时显式打开 `security.allowHomeSwitch: true`；
- prompt 覆盖层固定解析自 `$DSH_HOME/storages/meow-memory/prompts/`，**不跟随** `homeDir` / `memory_home` / `MEOW_MEMORY_HOME`，且不再读取旧位置（无 fallback）——切断"切目录 = 换注入文案"。

### 网络与鉴权

- 插件**不主动发起任何网络请求**（无外联、无遥测）。dream/反思的模型请求走 DSH 宿主现有的 agent 轮次，不是插件自己连网。
- 客户端 3 条本地路由（`/meow-memory/dreamed-sessions` 等）在 0.31.1 起接入宿主 `connection.requestRejection` 鉴权闸：跨站请求 401/403；鉴权服务缺失时保守 503。
- **数据路由同样过信任闸（0.32.1）**：`GET /meow-memory/dreamed-sessions`、`GET/POST /meow-memory/skip-dreams` 不打开 untrusted / 尚未判定 trust 的工作区库；POST 对 untrusted 工作区返回 **403**（不暴露记忆内容；鉴权不变）。
- 信任闸覆盖**窗口活动跟踪与启动期 window-index 恢复**：不会为了记窗口账本去打开/升级 untrusted 库；只有只读信任探针与注入链的判定会碰它。
- `security.debugLogs` 默认 `false`：`perf.log` 与 settings/configEditor 诊断 dump 默认不写（排障时开 `security.debugLogs: true` 或环境变量 `MEOW_MEMORY_DEBUG=1`）。`dream-debug.log` **默认仍写**，但只含会话 id / 计数 / 跳过原因等最小信息（不含记忆正文），启动时清理 48 小时前的日志、超 5MB 轮转；`apply-error.log` / `settings-register-error.log` 只在出错时写。**不要理解为"默认零日志"**。

### 卸载会留下数据（需手动清）

卸载插件不会删除记忆。确认不再需要后手动删：

```
<工作区>/.dsh-meow/                       # memory.db、sessions/、.owner.json、.gitignore
~/.dsh-meow/                              # 或你配置的 homeDir：global/memory.db、logs、window-index、migrate-state
$DSH_HOME/storages/meow-memory*           # install-id、prompt 覆盖层、切换指针（meow-memory-home.json）
```

---

## ✨ 功能特性

- **七层记忆**：`soul`（AI 自身）/ `user`（用户信息与偏好）/ `project`（项目信息，含 `subcategory`）/ `fact`（原子事实）/ `lesson`（教训与纠正）/ `topic`（进行中的话题，带目标句）/ `rules`（设计原则与行为准则）。每层一张 SQLite 表，id 带时间前缀。
- **两层存储（0.33）**：`soul` / `user` / 全局 `rules` 放在**用户级全局库**，跨工作区共享；`project` / `fact` / `lesson` / `topic` / 项目 rules 放工作区库。详见[记忆存哪里](#记忆存哪里两层存储033)。
- **首轮注入（长期记忆块）**：第一条用户消息前注入 soul / user / 全局 rules / 记忆导引。soul / user / 全局 rules 优先从用户级全局库读，工作区库兜底；作为独立 plugin snapshot 消息放在真实 user 消息之前，**不改写用户 prompt**；**首轮不跑关键词命中**（从第二轮起）。
- **每消息关键词命中 + 混合词法兜底**：从第二条用户消息起，按条目**关键词**（不是全文）检索 fact/lesson/rules/topic（全局 + 当前 project 锚定），`hitTopK` 命中注入。0.33 加离线混合词法补分：字符 bigram Jaccard + 0.25×trigram Jaccard（CJK 安全、NFKC），作为 BM25 弱命中时的 **floor**：`score = max(BM25, 0.55·fuzzy·recency·importance)`，噪声地板 0.2；对同义变体/词形/CJK 词边界有改善。**仍然不是向量/语义检索**（没有 embedding）；关键词质量差仍会静默召回不到。
- **当前 project 锚定**：带 project 参数即锚定该会话的当前项目；未锚定时命中只搜全局（闲聊不误伤）。
- **缓存友好**：静态 `meow-memory:guide` section 在 system prompt 中注册一次，文本恒定，不破坏 provider 的前缀缓存。
- **压缩后重注入**：会话压缩后，下一轮重新注入长期记忆快照 + 本会话查阅过的项目全景 + 本会话写入过的记忆原文（受 `reinjectMaxChars` 上限约束）。
- **写入去重的真实边界**：只对**同一层级**、正文 bigram Jaccard ≥ 0.8（近逐字相同）的条目自动合并。**改写/近义重复不会合并**，跨层矛盾也不会检测——需要合并时请用 `memory_find_similar` + `memory_update`/`memory_forget` 手动处理。
- **按窗口 dream**：窗口空闲 ≥ `idleMinutes`（默认 3 小时）、非峰时、有 live agent 时，由该窗口主 agent 分三轮整理（原子记忆 / topic / 项目总结）。0.32 起自动 dream **不再 `agents.resume()` 复活裸 agent**（#49 修复）、有上下文大小与频次上限、排除 archived、清单有条数上限。`/dream` 或 `memory_dream` 可手动立刻整理。
- **反思**：单任务连续 ≥ `reflectTurns` 个工具步后，询问模型自上次整理以来是否有值得记忆的内容；最后工具是 `memory_*` 视为已主动记忆、不重复反思。0.32 加了每日次数与最小间隔上限。
- **客户端 UI**：注入文本折叠成横条、反思/dream 轮折叠成卡片、会话列表显示 dream 状态图标。依赖 0.2.x 宿主内部结构，属"尽力而为"，宿主补丁版本变了可能静默失效（仅影响外观，不影响数据）。
- **零运行时依赖**：`node:sqlite` + 自包含 esbuild 产物（`lib/index.js`），无原生模块。

### 它做不到的事（别误会）

- **项目级记忆仍按工作区隔离**：`project` / `fact` / `lesson` / `topic` / 项目 rules 跟着 cwd 走（换工作区 = 新的项目记忆）。跨工作区共享的只有 `soul` / `user` / 全局 rules（0.33 用户级全局库）。
- **没有语义检索**：0.33 的 fuzzy 只是字符 n-gram 词法兜底（同义变体/词形/词边界），不是 embedding、不懂同义改写。`hit_count` 参与排序但不会自动改写关键词。
- **全局库不参与 dream**：dream 三轮仍只整理工作区库；全局条目靠工具/反思维护。
- **备份不含全局库**：`backup.enabled` 只备份工作区 `memory.db`。
- **迁移会归档工作区副本**：升级到 0.33 后原工作区的 soul/user/全局 rules 行变为 archived（内容保留）；全局库若丢失不会自动回灌，需恢复全局目录或逐条 `memory_forget mode=restore`。
- **遗忘是"指数半衰"而不是"艾宾浩斯复习曲线"**：`retrieval.halfLifeDays` 默认 30 天，`exp(-ln2 × 天数/30)`，并保留 importance≥3 的 0.85 下限。dream 会把 `updated_at` 按整理时间封存，所以衰减输入本身会被整理行为影响——这不是记忆科学意义上的复习调度。
- **dream 仍会把整理指令/回复/工具调用留在主会话历史里**：UI 折叠只是视觉收纳，token 仍持久存在。
- **`memory_home` 的切换能力默认关闭**；打开后它仍是模型可调用的工具，请自行评估。

---

## 📦 安装

**本 fork 没有发布到 npm registry。** 下面三条路任选；`npm install meow-memory` 装到的是**上游 0.31.1**，不是本仓库。

### 路线 A：本地目录 / tarball（推荐，无需 github 可达）

1. 在仓库里构建一次（本仓库不会提交 `lib/`）：

   ```sh
   npm install
   npm run build        # → lib/index.js、lib/client.js、lib/prompts/
   ```

2. 任选其一：
   - **本地目录**：GUI 左侧 **Plugins → Add plugin**，填**本仓库的绝对路径**（插件管理器接受绝对本地路径）；
   - **tarball**：`npm pack` 生成 `meow-memory-0.33.0.tgz`，Plugins → Add plugin 填该 `.tgz` 的绝对路径。
3. 重启 `dsh web`（或热重载插件）。新会话自动加载。

> 本地 `file:`/`link:` 安装不会执行 `prepare`，所以**必须先构建**；tarball 里已含 `lib/`，装上即可用。

### 路线 B：手动装进 profile（任意 DSH 安装）

1. 把本包复制（或软链/junction）到 profile 的 `node_modules/meow-memory`：

   ```sh
   mkdir -p ~/.dsh/profiles/<profile>/node_modules
   ln -s /absolute/path/to/meow-memory ~/.dsh/profiles/<profile>/node_modules/meow-memory
   ```

   Windows 用 `New-Item -ItemType Junction ...`（NTFS junction，无需管理员权限）。

2. 把 `meow-memory` 加进该 profile `package.json` 的 `dsh.profile.bundles` 数组。
3. 重启 `dsh web`。

### 路线 C：`github:` 一行装（**不推荐**）

```sh
dsh plugin --profile <profile> add github:<你的 fork 仓库地址>
```

⚠️ `github:` / git 依赖会安装 **devDependencies 并执行 `prepare`（esbuild 构建）**，需要 GitHub 可达、pnpm 允许构建脚本（≥10 默认阻止，要手工加 `allowBuilds`）、以及 `@deepseek-ai/dsh-*` devDep 能解析。任何一步失败都会回滚。除非你就是要验证构建链，否则用路线 A。

### ⚠️ 从上游 0.31 升级：旧记忆库默认"未受信"

上游 0.31 创建的 `memory.db` 没有 `.owner.json` 标记，本 fork 首次运行会把它判为 **foreign / untrusted**：不注入其内容，记忆工具（读/写）、dream 与反思被拒绝，会话里出现一次"工作区记忆库未受信"提示。**即使是空的上游库也算"已存在"，同样默认 untrusted。**

要保留旧记忆，二选一：

- 在 profile 配置里显式设 `security.trustWorkspaceMemory: true` 后重载插件（确认这个库是你自己创建的再开）；
- 或删除/改名旧 `memory.db` 重新开始（先备份——删除不可恢复）。

### 卸载

```sh
dsh plugin --profile <profile> remove meow-memory
```

**记忆数据不会随卸载删除**，清理路径见[安全模型](#安全模型)。

---

## 🔌 兼容性

本 fork 实测的环境（不是"向下兼容所有版本"的声明）：

| 项 | 值 |
|---|---|
| 宿主 | **DSH Desktop 0.2.1-rc.2**（Windows 11） |
| 运行时 | Electron 44.7.0 / Node **24.21.0**，`node:sqlite` 可用 |
| 验证范围 | 隔离实例加载成功；3 条 `/meow-memory/*` 路由带鉴权 200 / 不带 401；设置命名空间出现；无 apply 错误。**真实 LLM 对话轮/工具调用未在隔离实例中跑通**（无账号凭据） |
| 未验证 | **0.1.x 宿主**（本 fork 没有测过，不再宣称"兼容 dsh 0.1.5"）；其他 0.2.x 补丁版本 |

已知兼容性风险（沿用上游结论，本 fork 未改）：

- **设置页保存链路**：0.2.x 的 settings 服务改版后，插件走降级适配。设置页能渲染，但"改字段 → 保存 → 热重载 → 生效"未在本 fork 实测；最坏情况是设置页显示但不落到 apply。装完请按[自测清单](#自测清单)验一次。
- **客户端 UI**（折叠条/月亮图标/菜单面板）依赖 0.2.x `ChatSnapshot` 内部结构与 DOM 观察，宿主小版本更新可能静默失效；只影响外观。
- `node:sqlite` 要求 **Node ≥ 22.13**（22.5–22.12 需 `--experimental-sqlite`）。

---

## ⚙️ 配置

所有字段可选。**0.32 新增的安全/预算/检索三组字段目前只在配置层生效**（profile patch 或 `cordis.patch.yml`），设置页仍只覆盖 0.31 的字段（设置页代码不在本次加固范围）。

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true
    projectDir: '.dsh-meow'
    promptLang: 'zh'          # 首次使用建议显式配置
    hitTopK: 2
    autoMigrate: false        # 0.32 默认改为 false：不自动导入工作区 PROJECT.md
    security:
      trustWorkspaceMemory: false   # 信任已存在的 memory.db（含空库/schema-only）
      allowHomeSwitch: false        # 允许 memory_home 切换全局目录（默认只读）
      autoGitignore: true           # 写入/补全 .dsh-meow/.gitignore（自忽略）
      debugLogs: false              # perf/settings 诊断默认关（dream-debug 仍写最小日志）
    budget:
      snapshotMaxChars: 6000        # 首轮快照字符上限
      hitMaxChars: 1500             # 单条关键词命中字符上限
      reinjectMaxChars: 8000        # 压缩后重注入字符上限
      dreamMaxContextTokens: 40000  # 上下文估算超过则跳过自动 dream/反思
      dreamMaxPerWindowPerDay: 1    # 自动 dream 频次上限（每窗口/天）
      dreamMaxPerDayTotal: 12       # 进程级全局自动 dream 上限/天（滚动 24h；重启清零；0=关闭自动 dream）
      reflectMaxPerDay: 6           # 反思每日上限（每窗口）
      reflectMaxPerDayTotal: 24     # 进程级全局自动反思上限/天（滚动 24h；重启清零）
      reflectMinIntervalMinutes: 20 # 两次反思最小间隔
    retrieval:
      halfLifeDays: 30              # 指数半衰半衰期（天）
      minScore: 0.35                # 关键词命中注入门槛
      hitBoost: true                # 命中次数反馈加权
      importanceWeight: true        # importance 参与排序
    dream:
      enabled: true
      idleMinutes: 180
```

**完整字段、类型、默认值与效果见 [docs/配置参考.md](docs/配置参考.md)**（含 `titleMax` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate` 等）。

> ⚠️ **`promptLang` 首次使用建议显式配置。** 它决定注入/反思/dream 文案与工具描述的语言，也影响模型写条目用的语言——关键词按条目语言提取。内置 `zh` / `en` / `pt-br`；值就是 `src/prompts/` 的子目录名，**逐字匹配**：填不存在的名字（如 `pt`）不报错，静默落回中文包。

### 界面语言

插件界面文案跟随 DSH 的「设置 → 通用 → 语言」（中文 / English / Português (Brasil)），与 `promptLang` 是两层、互不影响。

---

## 🧠 工作原理

```
第一条用户消息（首轮）          第二条起的每条消息                 空闲≥3h + 非峰时 + live agent
┌────────────────────┐        ┌────────────────────┐        ┌──────────────────────┐
│ ===== 长期记忆 ===== │        │ 可能相关的记忆，仅供  │        │ 按窗口 dream：        │
│ 【关于你】(soul)     │        │ 参考：keywords 命中   │        │ 三轮（含项目总结）      │
│ 【关于user】         │        │ top-K + minScore    │        │ 有上下文/频次上限      │
│ 【设计原则】(rules)   │        │（全局+当前 project）  │        └──────────────────────┘
│ 【记忆导引】          │        └────────────────────┘        整理轮留在主会话历史
└────────────────────┘        已见 id 按会话记录                （UI 折叠 ≠ 不占 token）
独立 plugin snapshot          sessions/<id>.json
↓ 原样 user prompt            压缩信号 → 释放已见 + 重注入
每会话一次，首轮不做命中
```

> 0.33 起：首轮快照里的 soul / user / 全局 rules 优先来自用户级全局库（`<activeHomeDir>/global/memory.db`），工作区库兜底；项目全景与重注入仍只读工作区库。

### 工具（0.33 共 10 个）

| 工具 | 档 | 用途 |
|---|---|---|
| `memory_remember` | 写 | 写入一条记忆（必填 content/project/keywords/importance；**soul/user/全局 rules 写用户级全局库，其余写工作区库**；近逐字重复自动合并） |
| `memory_search` | 读 | 混合词法检索（BM25 + 字符 n-gram 兜底 floor）× 指数半衰，支持 level/project/status/days 过滤与 `explain`（含可选 `fuzzy`）；两库都查 |
| `memory_project` | 读 | 取回某项目完整注入段落（`project` 参数必填）；**只读工作区库** |
| `memory_find_similar` | 读 | 查重与冲突检测；两库都查 |
| `memory_read` | 读 | 按 id 读取单条完整元数据；两库都查 |
| `memory_update` | 写 | 修正 status / importance / goal / keywords / content；改哪库写哪库 |
| `memory_list` | 读 | **0.32 新增**：列条目 id/标题/关键词/状态/时间，不含正文；两库合并、按 id 去重 |
| `memory_forget` | 写 | **0.32 新增**：按 id 归档/取消归档/硬删除。默认归档；`mode:'delete'` 才硬删且必须 `confirm:true`；两库都查 |
| `memory_dream` | 写 | 手动触发本窗口整理（与 `/dream` 同语义；只整理工作区库） |
| `memory_home` | 目录 | 查看全局数据目录；**0.32 起默认只读**，需 `security.allowHomeSwitch: true` 才能切换（0.33 切换会连全局库一起搬，搬前先关连接） |

**参数、返回与副作用见 [docs/工具参考.md](docs/工具参考.md)**。

---

## 🧪 开发与测试

```sh
npm install
npm run build          # esbuild 打包 → lib/index.js / lib/client.js（自包含）
npm run test           # build + 语言包自查 + 全量断言（host + client 套件）
node scripts/check-lang.mjs en       # 只查某个 prompt 语言包
```

测试断言数：`npm test` **1076 条全绿**（host 676 + client 360），0 失败；另 `node smoke.mjs` 29 条；`scripts/check-lang.mjs` 校验 en/pt-br 两个语言包（11 槽位对齐）。

`@deepseek-ai/*` 包位于 dsh-meow pnpm workspace，不在本包 `node_modules` 里。Windows 上 `npm run link-workspace` 创建 workspace 包的 junction 镜像供 esbuild 解析；仅构建期需要。

### 自测清单

1. 普通对话一轮：首轮是否出现长期记忆快照横条（无 → 插件没工作）；
2. 设置页改一个字段 → 保存 → 热重载插件 → 值是否生效（验证 0.2.x settings 漂移）；
3. `/dream` 跑完 → 继续聊天：工具数量是否正常（防 #66）；
4. 反思轮后检查模型选择栏是否仍为主模型（防 #71，仅配置 `delegate.model` 时可能触发）；
5. 在克隆来的陌生仓库里开新会话：不应出现你没写过的长期记忆内容（不信任库/默认不迁移）；
6. 换一个工作区开新会话：`soul` / `user` / 全局 rules 应该还在（来自用户级全局库），`project` / `fact` 是新工作区的（验证两层存储）。

---

## 📚 文档

| 想了解 | 看这里 |
| --- | --- |
| 10 个工具的参数、返回与副作用 | [docs/工具参考.md](docs/工具参考.md) |
| 记忆存哪里、迁移与回退 | [记忆存哪里](#记忆存哪里两层存储033) |
| 全部配置项、类型与默认值 | [docs/配置参考.md](docs/配置参考.md) |
| 为什么这样设计、成本与取舍 | [docs/设计说明.md](docs/设计说明.md) |
| 装不上、检索不准、报错怎么读 | [docs/常见问题.md](docs/常见问题.md) |
| 版本变更与已知未修问题 | [CHANGELOG.md](CHANGELOG.md) |
| 加界面语言 | [src/i18n/README.md](src/i18n/README.md) |
| 加 prompt 语言包 | [src/prompts/README.md](src/prompts/README.md) |

## 🙏 致谢

本 fork 的代码绝大部分来自上游与以下贡献者（保留原有署名）：

- **[daveycodez](https://github.com/daveycodez)** — 英文语言包与英文分词（[PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6)，v0.22.0）
- **[chenmzh](https://github.com/chenmzh)** — 记忆注入改为独立 plugin snapshot 消息，根治会话标题污染（[PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10)）
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — dsh 0.1.2-alpha.4 双版本 Session events 兼容（[PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11)）
- **[coutogilson](https://github.com/coutogilson)** — 巴西葡语 prompt 语言包与界面文案层

0.32 加固改动（信任闸、预算上限、dream/反思频次、检索公式、管理工具、文档重写）见 [CHANGELOG.md](CHANGELOG.md)。

## 📄 License

MIT —— 见 [LICENSE](LICENSE)。上游版权归 `Phant0Meow/dsh-meow-memory` 作者；本 fork 保留原 LICENSE 与署名。
