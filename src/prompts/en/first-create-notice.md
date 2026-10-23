[meow-memory first store created]
A memory store was just created in the current workspace: {dbPath}.

Three things to know:
1. This file sits in a hidden directory inside the workspace and **cannot be recovered if deleted** (no recycle bin). The plugin already wrote a self-ignoring `.gitignore` there (so it stays out of git by default); if you disabled `security.autoGitignore`, add an entry yourself.
2. The memory store itself stays inside the current workspace and is never moved. `memory_home` / `homeDir` manage **instance-level data** (logs / window-index / migrate state), not this `memory.db`. The default global data directory lives in `.dsh-meow` under the platform user home: `{homePath}`. `memory_home` is query-only by default; switching requires `security.allowHomeSwitch: true`.
3. Want automatic backups: set `backup.enabled: true` in the profile config (each dream's end produces a `memory.db.bak` snapshot).

This notice appears once; no reply needed. If the user asks where memory data lives or how safe it is, the points above are the answer.
