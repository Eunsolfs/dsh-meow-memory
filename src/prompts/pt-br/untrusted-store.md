[Armazenamento de memória do workspace não confiável]: este workspace já contém um banco de memória não vazio que eu (o plugin meow-memory) não criei: `{projectDir}`.

Por segurança, esta sessão NÃO vai injetar seu soul / user / regras globais, NÃO vai usá-lo para correspondência de palavras-chave e NÃO vai mostrar o panorama dos projetos dele. Isso impede que um repositório clonado use `.dsh-meow/memory.db` ou `PROJECT.md` para plantar instruções persistentes na IA.

Se este banco é seu:
- defina `security.trustWorkspaceMemory: true` na configuração do plugin (profile patch / `cordis.patch.yml`) e recarregue o plugin; ou
- apague ou renomeie o arquivo, e eu crio um banco novo.

O diretório global de dados padrão fica em `.dsh-meow` sob a home do usuário do sistema: `{homePath}`
