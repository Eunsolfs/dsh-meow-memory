【工作区记忆库未受信】：本工作区里已经存在一个**不是我（meow-memory 插件）创建**的非空记忆库：`{projectDir}`。

出于安全考虑，本次会话**不会注入**它的 soul / user / 全局 rules，**不会**用它做关键词命中，也**不会**展示它的项目全景。这是防止克隆来的仓库借 `.dsh-meow/memory.db` 或 `PROJECT.md` 向 AI 注入持久指令。

如果这个库是你自己的：
- 在插件配置（profile patch / `cordis.patch.yml`）里设 `security.trustWorkspaceMemory: true` 后重新加载插件；或
- 删除/改名该文件后由我重建一个新库。

全局数据目录默认在该平台用户主目录下的 `.dsh-meow`：`{homePath}`
