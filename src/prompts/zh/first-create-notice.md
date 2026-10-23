【meow-memory 首次建库提示】
记忆库刚刚在当前工作区创建：{dbPath}。

三点须知：
1. 这个文件在工作区的隐藏目录里，**误删无法恢复**（没有回收站）。插件已在该目录自动写入自忽略 `.gitignore`（默认不进 git）；如果你手动关过 `security.autoGitignore`，请自行补一条。
2. 记忆库本体固定在当前工作区内，不会被搬走。`memory_home` / `homeDir` 管理的是**实例级数据**（日志 / window-index / 迁移状态等），不是这个 `memory.db`；默认全局数据目录位于平台用户主目录下的 `.dsh-meow`：`{homePath}`。`memory_home` 默认只读，需要显式配置 `security.allowHomeSwitch: true` 才能切换。
3. 想自动备份：在 profile 配置里设 `backup.enabled: true`（每次 dream 收尾生成 `memory.db.bak` 快照）。

本提示只出现一次，无需回复；如用户问到记忆数据的存放或安全，以上是要点。
