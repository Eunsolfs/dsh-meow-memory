# meow-memory 工具文案（键值行：`- key: value`，首个半角冒号+空格为分隔符，value 原样保留；行首两格缩进为续行。### 标题仅供阅读，解析时忽略。
# 键约定：<tool>.description / <tool>.param.<name> / <tool>.out.<path>。缺键会 throw，新增键须同步 src/tools.ts。）

### memory_remember

- memory_remember.description: 把一条值得跨会话记住的信息写入当前工作区的记忆库（SQLite，按 level 分表）。 必填参数：content（内容）/ project（归属："全局"或项目名，多项目用英文逗号分隔）/ keywords（8-13 个检索关键词）/ importance（重要性评估）。缺失会报错并提示重填。 level 分类：soul=AI 自身（少用）；user=用户基本信息与基础偏好； project=项目（项目名如 femo/meow-memory/meow-eyes/dsh）； rules=设计原则/行为准则（全局准则 project 填"全局"且 importance≥2 会全量注入到首轮；  项目特定准则填 project 参数，随 memory_project 注入；其余走检索）； fact=细碎原子事实（一句话直陈 ≤60 字）；lesson=你学到的经验（被纠正的一定记这里）； topic=话题（建议 goal 目标句，用 keywords 检索）。 铁律：用户介绍项目设计思路/框架/决策理由时，content 必须保留用户原话措辞，不要转述总结。 与已有条目高度重复会自动合并（更新而非新增）。调用成功后工具会返回确认，无需重复调用本工具。
- memory_remember.param.content: 要记住的内容；fact/lesson 一句话 ≤60 字；topic ≤300 字；涉及用户原话必须保留措辞。
- memory_remember.param.level: 记忆层级，默认 fact。
- memory_remember.param.project: 必填。项目名（level=project 时必须是具体项目名）；全局适用的信息填"全局"；同时适用于多个项目时用英文逗号分隔，如"dsh,femo"。
- memory_remember.param.subcategory: project 子类：overview=目标概述/structure=项目结构/decisions=技术决策/quotes=用户原话/ops=部署与数据/todo=进行中。
- memory_remember.param.goal: 话题目标句（level=topic 建议填，如"让 femGen 集成可用"）。
- memory_remember.param.importance: 重要性（数字即可，不设上限；软引导 1-4：4=致命红线/健康安全，3=用户强调/全局适用，2=用户决策抽象总结，1=琐碎）。
- memory_remember.param.corrected: 是否为用户纠正的内容（level=lesson 时）。
- memory_remember.param.keywords: 必填。8-13 个检索关键词（合并后会更新为最新值）；缺失会报错，没有自动提取回退。
- memory_remember.out.keywords: 实际存储的关键词（合并后为最新值）。
- memory_remember.out.project: 实际归属项目（若有）。

### memory_search

- memory_search.description: 在当前工作区记忆库中检索记忆（BM25 × 近期权重）。 query 必填且不能为空——传你要查的关键词/句子，如 memory_search({query: "记忆插件 部署"})； 想浏览某项目全貌请用 memory_project（不需要 query），不要用空 query 调本工具。 结果构成（用户拍板）：默认 top 10 = 前 5 条按相关度无脑取（不排除任何记忆，包括已注入/已检索/本 session 建立的）+ 后 5 条从后续排名绕开已注入/已检索的记忆补齐（保证新信息）。 默认搜索范围=fact+lesson+topic+rules；level 支持逗号多选（如 fact,lesson）；想看项目全景传 level=project。 返回按相关度取 top-k 后按记忆时间戳重排（旧→新，供判断发展过程与新旧冲突）。
- memory_search.param.query: 检索关键词/句子（必填，不能为空；例："记忆插件 部署"）。
- memory_search.param.level: 限定层级，逗号多选：fact/lesson/topic/rules/project/soul/user（默认 fact,lesson,topic,rules）。
- memory_search.param.project: 按项目名过滤（逗号多选，OR 语义，如 "dsh,femo"；"全局"/未标记条目天然包含）。
- memory_search.param.status: 按状态过滤（逗号多选：active/archived/stale/all；默认 active，todo 类的 stale 视为已完成参与；含 all=不过滤）。
- memory_search.param.days: 只看最近 N 天创建的条目（按创建时间）。
- memory_search.param.k: 返回条数上限。
- memory_search.param.content_max: 每条内容截断长度，0=全文。
- memory_search.param.explain: 可解释检索开关（默认关）。开=true 时每条命中附带分项得分 explain（bm25 关键词分、importance、recencyWeight 指数半衰权重、status），用于排查"为什么没召回/为什么召回它"，不改排序。
- memory_search.out.note: 冲突提示。
- memory_search.out.hits.id: 完整记忆 id（可传给 memory_read/memory_update/memory_find_similar）。
- memory_search.out.hits.keywords: 记忆关键词列表（LLM 提取或自动 bigram）。
- memory_search.out.hits.project: 项目归属；""=未标记；全局信息为"全局"。
- memory_search.out.hits.updated_at: 记忆时间戳（最后更新时间，毫秒）。
- memory_search.out.hits.explain: bm25 关键词原始分（importance/recencyWeight/status 随行返回，不单独描述）。

### memory_find_similar

- memory_find_similar.description: 按记忆 id 查找内容相似的条目（bigram 词频向量余弦）——用于查重、找冲突、判断某条记忆是否已有近似记录。 同样只检索其他会话建立的记忆，本会话已见（注入/检索过）的自动排除。
- memory_find_similar.param.id: 基准记忆 id（memory_read/search 结果里的完整 id 或前 12 位）。
- memory_find_similar.param.k: 返回条数。
- memory_find_similar.param.content_max: 每条内容截断长度，0=全文。
- memory_find_similar.out.hits.similarity: 余弦相似度 0-1，越高越接近。

### memory_read

- memory_read.description: 读取记忆库中某条记忆的完整内容（含 title/keywords/importance/状态等元数据）。
- memory_read.param.id: 记忆 id（注入块或 memory_search 结果里给出的 id）。

### memory_update

- memory_update.description: 更新记忆库中某条记忆（内容/重要性/状态/项目归属/话题目标句/关键词等）。 status 取值：active / stale（完结：todo 完成、话题达成目标 → stale 视为 done）/ archived（删除，过时作废/重复/被替代的条目）。
- memory_update.param.id: 记忆 id。
- memory_update.param.content: 新内容（topic 重写时用：起因经过发展结果 ≤300 字）。
- memory_update.param.status: 新状态。
- memory_update.param.importance: 新重要性（数字即可，不设上限；软引导 1-4：4=致命红线/健康安全，3=用户强调/全局适用，2=用户决策抽象总结，1=琐碎）。
- memory_update.param.goal: 新目标句（topic）。
- memory_update.param.project: 新项目名（project/fact/lesson/rules/topic）；全局信息填"全局"；多个项目用英文逗号分隔；传空字符串 = 清空归属（未标记）。
- memory_update.param.keywords: 手动指定关键词（发现不准时主动修正/补充；不传或空数组 = 不更新关键词）。

### memory_project

- memory_project.description: 取回某个项目在记忆库中的完整注入段落（纯文本，按子标签分组，未过时条目一口气全给）。 project 参数必填：你要看哪个项目的信息？不传会报错，先想清楚项目名再调用。 当用户问起某个项目（femo/meow-memory/meow-eyes/dsh…）的设计历史、技术决策、用户原话、项目进度时调用； 也用于需要项目全景上下文再作答的场合。 规则：组内按记忆时间戳旧→新；todo 子标签输出「已完成：」（最近完成 5 条）+「To do list：」；每条记忆带完整 id、最后更新时间戳与原文。
- memory_project.param.project: 项目名（会话开头的记忆导引会列出用户的所有 project，直接选用）。
- memory_project.out.text: 按子标签分组的项目记忆注入段落（纯文本）。

### memory_list

- memory_list.description: 列出记忆库条目的元数据（id / 层级 / 标题 / 关键词 / importance / 状态 / 项目 / 记忆时间戳），**不含正文**——用于低 token 成本地盘点记忆、找到 id 再交给 memory_read / memory_update / memory_forget。默认只列 active；level / project / status 支持逗号多选；limit / offset 分页。要看正文用 memory_read，要看项目全景用 memory_project。
- memory_list.param.level: 限定层级，逗号多选：soul/user/project/fact/lesson/topic/rules；默认 all=全部层级。
- memory_list.param.project: 按项目名过滤（逗号多选，OR 语义）；"全局"/未标记条目天然包含。
- memory_list.param.status: 状态过滤：active（默认）/ stale / archived / all。
- memory_list.param.limit: 返回条数上限（1-100，默认 20）。
- memory_list.param.offset: 分页偏移（从 0 开始，默认 0）。
- memory_list.out.note: 当前筛选条件与结果条数提示。
- memory_list.out.total: 命中筛选条件的条目总数（不受 limit 影响）。
- memory_list.out.items.id: 完整记忆 id（可传给 memory_read / memory_update / memory_forget）。
- memory_list.out.items.level: 记忆层级。
- memory_list.out.items.title: 展示用标题（由正文截断生成）。
- memory_list.out.items.keywords: 关键词列表。
- memory_list.out.items.importance: 重要性。
- memory_list.out.items.status: 状态（active / stale / archived）。
- memory_list.out.items.project: 项目归属；""=未标记；全局信息为"全局"。
- memory_list.out.items.updated_at: 记忆时间戳（最后更新时间，毫秒）。

### memory_forget

- memory_forget.description: 按 id 处理单条记忆：默认 mode=archive 归档（可恢复）；mode=restore 取消归档恢复为 active；mode=delete 永久硬删除（不可恢复，必须同时传 confirm=true）。只影响一条；批量清理请多次调用，或先用 memory_list 列出 id。优先用归档，硬删除只在用户明确要求"彻底删除"时使用。
- memory_forget.param.id: 记忆 id（完整 id 或前 12 位短 id）。
- memory_forget.param.mode: archive=归档（默认，可恢复）/ restore=取消归档 / delete=硬删除（不可恢复，需 confirm=true）。
- memory_forget.param.confirm: mode=delete 时必须显式传 true，否则拒绝执行；其他模式忽略。
- memory_forget.out.note: 处理结果提示（归档 / 恢复 / 删除）。
- memory_forget.out.id: 被处理的记忆 id。

### memory_dream

- memory_dream.description: 立即为本窗口安排一次记忆整理（dream）：把本窗口建立过/提取过的记忆逐轮发给主 agent 整理封存（第 1 轮=原子记忆 project/fact/lesson/rules/soul/user，第 2 轮=topic 记忆，第 3 轮=项目总结——仅当本窗口涉及具体项目时追加）。窗口空闲 3 小时以上自动触发（北京时间峰时 9-12 点/14-18 点及各自前 15 分钟不触发），此工具用于手动触发。

### memory_home

- memory_home.description: 查看 meow-memory 的全局数据目录（日志、梦境窗口账本、迁移状态等实例级数据的存放位置；记忆库本体在每个项目内、不受影响；prompt 覆盖层不在这里，固定解析自 `$DSH_HOME/storages/meow-memory/prompts/`）。**默认只读**：`security.allowHomeSwitch: false` 时本工具只能查看当前目录、三个预设与切换是否开启，传 target 会被拒绝并说明原因——这是安全闸：搬动目录会改变实例数据的落点，不应让模型随意搬走。只有用户在配置里显式打开 `security.allowHomeSwitch: true` 后才允许切换。切换时会自动把旧目录内容整体搬过去（同盘为移动、跨盘为复制），跨盘复制时旧目录保留不删，需提醒用户确认后手动删除；若用户本机跑着多个 dsh 实例共享同一目录，请提醒它们应同步修改。当用户表示想把记忆数据/日志挪出 C 盘、换到别的盘或目录时调用（先确认开关已打开，否则说明需要改配置）。切换结果写在稳定位置指针（$DSH_HOME/storages/meow-memory-home.json），跨重启仍生效。
- memory_home.param.target: 目标位置。三选一传预设标记：default=系统用户主目录（默认）、dsh-storage=DSH 根目录 storages 下的 meow-memory、plugin-root=插件本体根目录下的 storage；也可以传一个绝对路径。不传=只查看当前状态，不做任何修改；`security.allowHomeSwitch: false` 时传 target 会被拒绝。
- memory_home.out.note: 切换/查看结果：当前或新的目录位置、搬移的文件数、旧目录的处置提示。
