【aviso de criação do banco meow-memory】
Um banco de memória acabou de ser criado no workspace atual: {dbPath}.

Três coisas importantes:
1. Este arquivo fica num diretório oculto dentro do workspace e **não pode ser recuperado se apagado** (não há lixeira). O plugin já gravou ali um `.gitignore` auto-ignorante (fica fora do git por padrão); se você desativou `security.autoGitignore`, adicione a entrada manualmente.
2. O banco de memória em si fica dentro do workspace atual e nunca é movido. `memory_home` / `homeDir` gerenciam **dados em nível de instância** (logs / window-index / estado de migração), não este `memory.db`. O diretório global de dados padrão fica em `.dsh-meow` sob a home do usuário do sistema: `{homePath}`. `memory_home` é somente consulta por padrão; a troca exige `security.allowHomeSwitch: true`.
3. Quer backups automáticos: defina `backup.enabled: true` na configuração do profile (ao fim de cada dream é gerado um snapshot `memory.db.bak`).

Este aviso aparece uma única vez; não é preciso responder. Se o usuário perguntar onde ficam os dados de memória ou quão seguros são, os pontos acima são a resposta.
