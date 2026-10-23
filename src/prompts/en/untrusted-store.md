[Workspace memory store not trusted]: this workspace already contains a non-empty memory database that I (the meow-memory plugin) did not create: `{projectDir}`.

For safety, this session will NOT inject its soul / user / global rules, will NOT use it for keyword hits, and will NOT show its project panorama. This blocks a cloned repository from using `.dsh-meow/memory.db` or `PROJECT.md` to plant persistent instructions in the AI.

If this store is yours:
- set `security.trustWorkspaceMemory: true` in the plugin config (profile patch / `cordis.patch.yml`) and reload the plugin; or
- delete or rename the file, and I will create a fresh store.

The default global data directory lives in `.dsh-meow` under the platform user home: `{homePath}`
