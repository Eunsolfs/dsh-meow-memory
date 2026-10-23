# meow-memory 🐱📝 · fork endurecido

| [中文](README.md) | [English](README.en.md) | [Português (BR)](README.pt-br.md) | [MIT License](LICENSE) |
| :---: | :---: | :---: | :---: |

> **O que é isto**: um fork pessoal de endurecimento do `Phant0Meow/dsh-meow-memory` **v0.31.1** (este repositório, versão **0.35.0**, branch `hardening`).
> O upstream é MIT: <https://github.com/Phant0Meow/dsh-meow-memory>. Este fork **não tem vínculo com o upstream**, não publica em nome dele e não representa suas posições. Todas as mudanças e problemas restantes estão no [CHANGELOG.md](CHANGELOG.md).

Memória entre sessões para o [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): memória em sete níveis no SQLite, injeção de snapshot na primeira rodada, acertos por palavra-chave a cada mensagem e consolidação automática **com limites de orçamento**.

Versão **0.35.0** ｜ Histórico: [CHANGELOG.md](CHANGELOG.md) ｜ Host verificado: **DSH Desktop 0.2.1-rc.2** (veja [Compatibilidade](#compatibilidade))

**Nota de honestidade**: este README só afirma comportamentos que existem no código. A 0.32 removeu várias alegações infladas do upstream ("deduplicação/merge automáticos", "curva de esquecimento de Ebbinghaus", "BM25" nos acertos por mensagem, "compatível com dsh 0.1.5") e declara o limite real em cada ponto.

---

## Leia antes: ele gasta tokens automaticamente

Este é o custo mais subestimado do plugin. **Com a configuração padrão ele faz requisições de LLM sem um comando explícito do usuário**; a 0.32 limitou cada tipo, mas não desligou nenhum (o comportamento padrão do upstream foi mantido, só deixou de ser ilimitado).

| Gasto | Quando | Limite 0.35 |
|---|---|---|
| **Taxa estática**: manual de memória + descrição/schema de todas as ferramentas no system prompt | **Toda** requisição, mesmo sessão que nunca usa memória | ≈**6,7k tokens/requisição** (medido, pacote chinês; ≈6,3k em inglês; varia com o pacote de idioma e o tamanho das descrições). Não dá para desligar por requisição; para não pagar nada, defina `enabled: false` (ou remova o plugin) |
| **Snapshot da primeira rodada**: soul / user / regras globais / guia de memória | Uma vez, antes da primeira mensagem real de cada sessão | `budget.snapshotMaxChars` padrão **6000 caracteres** (≈2,7k tokens zh) |
| **Acertos por palavra-chave** | Da segunda mensagem em diante, quando há acerto | `hitTopK` padrão 2 × `budget.hitMaxChars` padrão **1500 caracteres/entrada** (≈1,4k tokens/mensagem no pior caso) |
| **Reinjeção pós-compactação** | A rodada seguinte a uma compactação | `budget.reinjectMaxChars` padrão **8000 caracteres** (≈3,6k tokens) |
| **Dream automático (caminho do agente principal, padrão)** | Janela ociosa ≥ `dream.idleMinutes` (padrão 180), fora do pico, **com live agent**, contexto estimado ≤ `budget.dreamMaxContextTokens` (padrão 40000) | Até **3 rodadas de contexto completo** (as rodadas seguintes reestimam e encerram cedo se estourar); `budget.dreamMaxPerWindowPerDay` padrão **1 por janela/dia**, mais um limite **de processo** `budget.dreamMaxPerDayTotal` padrão **12/dia** (contadores rolam 24h por vida do processo e zeram no restart). Uma sessão de 30k tokens custa ≈90k input tokens por dream; o histórico ganha ≈8–15k tokens duráveis |
| **Dream automático (caminho isolado, `dream.isolated: true`)** | Mesmos portões (frequência/cooldown/pico/limite global ainda valem), mais o serviço `subagents` do host e o provider `spawn` | **Zero crescimento de contexto visível na sessão principal** (o prompt do filho tem limite próprio `dream.isolatedMaxPromptChars`, padrão 20000 caracteres); os tokens do filho continuam cobrados; o portão `dreamMaxContextTokens` do contexto principal **não se aplica** ao caminho isolado |
| **Reflexão** | Depois de uma tarefa com ≥ `reflectTurns` (padrão 7) passos de ferramenta seguidos | **1 requisição de contexto completo**; `budget.reflectMaxPerDay` padrão 6/dia/janela (sessão), `budget.reflectMinIntervalMinutes` padrão 20, mais um limite **de processo** `budget.reflectMaxPerDayTotal` padrão **24/dia** (rolagem 24h, zera no restart); pulada quando o contexto excede `dreamMaxContextTokens` |
| **Busca semântica opcional (`retrieval.semantic.enabled: true`, desligada por padrão)** | Toda query de mensagem do usuário, cada `memory_search`, cada escrita (`memory_remember`/`memory_update`) e um backfill em background logo após o apply | **Não é gasto de tokens, e sim requisições de rede ao endpoint `/embeddings` configurado**: com ela ligada, 1 embedding de query por mensagem do usuário (o LRU de 256 só ajuda texto idêntico), 1 por escrita, e backfill de inicialização em lotes de ≤50 linhas/nível; **desligada (padrão) = zero requisição de rede**. Dados enviados/privacidade abaixo |

**Como parar o gasto automático** (as ferramentas manuais continuam funcionando):

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    reflect: false            # sem reflexão automática
    dream:
      enabled: false          # sem dream automático (/dream e memory_dream continuam)
```

Ou por janela: menu "…" da linha da sessão → **Participação da memória** → desligar "injeção automática"/"consolidação automática". Para não pagar a taxa estática de ≈6,7k, só desativando o plugin.

> **`/dream` / `memory_dream` manuais não passam pelos portões de custo automáticos** (vontade explícita): não há portão de pico/frequência/contexto (a invocação manual já exige uma janela viva), e rodam até **3 rodadas** sobre o **contexto completo da sessão** (atômicas / topic / resumo de projeto). Se o contexto estiver grande, rode `/compact` antes — é a única forma de reduzir de verdade o custo de um dream manual.

> São **limites**, não promessas. O gasto real depende de número e tamanho das entradas e do tamanho da sessão; o pior caso diário continua limitado em ordem de grandeza (≤1 dream + ≤6 reflexões de contexto completo). Os "tokens estimados" usados pelos portões de contexto são **aproximados**: CJK ≈1,7 caracteres/token, não-CJK ≈4 caracteres/token (superestimado de propósito), não é cobrança exata.

> **O armazenamento em camadas da 0.33 não adiciona tokens por mensagem**: é só mais um banco SQLite local (o global do usuário); as injeções continuam limitadas por `budget.*`. O fuzzy é só CPU (sem tokens); os limites de dream/reflexão e de contexto não mudam.

> **Busca semântica opcional da 0.35 (`retrieval.semantic.enabled: true`, desligada por padrão)**: por padrão é **totalmente offline com zero requisições de rede** (sem endpoint configurado = não ativa; comportamento idêntico à 0.34). Quando ativada, envia **corpo/título/palavras-chave das memórias** e **texto da mensagem/consulta do usuário** ao endpoint `/embeddings` compatível com OpenAI que você configurar (chave via variável de ambiente, nome padrão `MEOW_MEMORY_EMBEDDING_KEY`; se essa variável padrão não estiver definida, as requisições vão **sem chave**, para Ollama/LM Studio locais; só um `apiKeyEnv` *customizado* com variável ausente é tratado como não configurado — não faz requisição). A similaridade semântica é apenas um **piso de cosseno** (piso de ruído 0,25, abaixo disso conta como 0; similaridade negativa/zero conta como 0), nunca um rerank; falha/timeout (5s padrão)/não-2xx/forma inválida caem silenciosamente de volta ao léxico puro. Quando ativada, o apply do plugin **faz backfill dos registros históricos em background** (banco global + cada workspace confiável, ≤50 linhas/nível, falhas silenciosas e retentadas no próximo start). **Nenhum modelo local é empacotado**; trocar o modelo de embedding invalida os vetores armazenados (reescrever ou refazer o backfill). Veja [referência de configuração](docs/configuration-reference.md).

> **Dream isolado da 0.34 (`dream.isolated: true`, desligado por padrão; utilizável no 0.2.1 desde a 0.34.1)**: o dream automático roda numa **sessão filha spawnada de contexto vazio**, então a sessão principal não recebe turno de dream visível ao modelo (só fatos log-only) → **crescimento zero do contexto principal**; o filho ainda gasta tokens. O filho recebe os slots de prompt do dream + um digest de texto recente user/assistant e nomes de ferramentas + listas de entradas (sem resultados de ferramenta/avisos de plugin), então **a qualidade da consolidação é menor que o caminho principal** (trade-off conhecido). O filho **herda o agent preset do pai**, então a visibilidade da ferramenta `memory_*` depende do tool set desse preset (risco residual; caso contrário, volta ao dream do agente principal). `/dream` / `memory_dream` manuais sempre usam o agente principal (visível/abortável); **o dream isolado não pode ser abortado pela UI**. Se `subagents`/`spawn` faltar, o plugin volta ao dream do agente principal; **uma rejeição no start do filho (sync ou async — profundidade/capacidade/auth) também volta ao dream do agente principal na mesma varredura** (log `isolated-dream rejection -> main-dream fallback`). A build 0.34.0 enviava `maxDepth: 0` ao spawn, que o 0.2.1 interpretava como limite de profundidade do próprio filho e rejeitava (`SubagentDepthError`), então nenhuma consolidação automática rodava; a 0.34.1 **não envia `maxDepth`** (padrão 1 do host).

---

## Onde a memória fica: armazenamento em duas camadas (0.33)

A 0.33 transforma o "global" de "global dentro de um workspace" em armazenamento **de usuário** real:

```
<activeHomeDir>/global/memory.db        ← escopo do usuário (entre workspaces)
  soul / user / rules(globais)
<workspace>/<projectDir>/memory.db      ← escopo do workspace (um por cwd)
  project / fact / lesson / topic / rules(de projeto)
```

- **Banco global do usuário**: no diretório global (`activeHomeDir()/global/memory.db`; padrão `~/.dsh-meow/global/memory.db`, mude com `homeDir` / `MEOW_MEMORY_HOME`). Trocas de `homeDir` / `memory_home` o movem junto.
- **Banco do workspace**: continua um por cwd, com `project` / `fact` / `lesson` / `topic` / `rules` de projeto.
- **Roteamento de escrita**: `memory_remember` grava `soul` / `user`, ou `rules` com projeto global → **banco global**; o resto → **banco do workspace**. `memory_read` / `memory_update` / `memory_forget` / `memory_search` / `memory_list` / `memory_find_similar` **consultam os dois bancos e deduplicam por id**; em colisão de id **active vence archived** (a cópia arquivada migrada não esconde o original global). `memory_project` continua só no workspace.
- **Migração automática (uma vez)**: a primeira sessão confiável de cada workspace copia soul / user / regras globais existentes **com os ids originais** para o banco global e depois **arquiva** essas linhas do workspace (recuperáveis; evita contagem dupla em injeção/dream). A marca de idempotência fica no `dream_meta` do workspace (`globalmigrated:v1:<dir>`); só workspaces confiáveis migram, bancos foreign nunca são tocados.
- **Fallback**: se o banco global estiver ausente / não confiável / indisponível, o plugin volta automaticamente ao comportamento de workspace único da 0.32 (soul/user/regras globais lidos/escritos no banco do workspace), sem erro.
- **Se o banco global for apagado após a migração**: as linhas originais do workspace continuam archived e **não são reinjetadas automaticamente**. Recuperação: restaurar/fazer backup do diretório global, ou `memory_forget` com `mode:'restore'` por id.
- **Backup**: `backup.enabled` (desligado por padrão) faz backup **do banco do workspace e do banco global** ao fim do dream (cada um em `memory.db.bak`, VACUUM INTO + rotação de uma geração + incremento por mtime; banco global vazio/não confiável é ignorado e nenhum diretório é criado).
- **dream/reflexão ainda consolidam só o banco do workspace**: entradas globais são mantidas por ferramentas/reflexão, não pelas três rodadas do dream — limitação conhecida.

---

## Modelo de segurança

### Onde ficam os dados

| Dado | Local |
|---|---|
| Banco global de memória do usuário (SQLite em texto puro) | `<activeHomeDir>/global/memory.db`: padrão `~/.dsh-meow/global/memory.db` (**fora do `DSH_HOME`**; mude com `homeDir` / `MEOW_MEMORY_HOME`) |
| Banco de memória do workspace (SQLite em texto puro) | `<workspace>/<projectDir>/memory.db`, `projectDir` padrão `.dsh-meow` |
| Registro por sessão (vistos / consultados) | `<workspace>/.dsh-meow/sessions/<id>.json` |
| Marcador de confiança do banco do workspace | `<workspace>/.dsh-meow/.owner.json` |
| Marcador de confiança do banco global | `<activeHomeDir>/global/.owner.json` (marcador installId, `workspace: ''`) |
| `.gitignore` auto-ignorante | `<workspace>/.dsh-meow/.gitignore` (conteúdo `*` — o diretório se ignora, então `git add .` nunca commita memórias) |
| Diretório global de instância (logs / window index / estado de migração) | padrão `~/.dsh-meow` (**fora do `DSH_HOME`**); mude com `homeDir` ou `MEOW_MEMORY_HOME` |
| Overrides de prompt por instância | `$DSH_HOME/storages/meow-memory/prompts/<lang>/<slot>.md` (caminho fixo; `$DSH_HOME` padrão `~/.dsh`; **não segue** trocas de `homeDir`/`memory_home`) |

O `.gitignore` é escrito automaticamente (`security.autoGitignore: true`): `*` se o diretório não tiver nenhum, e **uma linha `*` é acrescentada se um `.gitignore` pré-existente não a tiver** (evita que regras `!*` de re-inclusão commit sem `memory.db`). O banco **não é criptografado**: o texto das memórias é puro e pode conter dados privados. Não guarde segredos em memórias; o `.gitignore` só barra o git, não backups, pastas sincronizadas ou outros processos locais.

### Bancos não vazios que o plugin não criou são não confiáveis (correção #64-1)

Workspaces costumam ser repositórios `git clone` — alguém pode colocar um `.dsh-meow/memory.db` ou `PROJECT.md` no repositório e fazer a IA injetar regras soul/user/globais escritas pelo atacante como se fossem memória de longo prazo do usuário.

Regras da 0.32:

- o plugin confia só em bancos **que ele criou**, ou que têm um marcador `.owner.json` válido. O marcador precisa satisfazer tudo: `schema=1`; `installId` igual ao **id de instalação aleatório** desta máquina (persistido em `$DSH_HOME/storages/meow-memory/install-id`, não é fingerprint de máquina); e `workspace` registrado igual ao workspace atual. Marcadores forjados, de outra máquina ou movidos para outro caminho de workspace são rejeitados; se o install-id não puder ser persistido, a verificação é **fail-closed**;
- caminhos de `workspace` são comparados após **normalização por realpath**: abrir o mesmo banco por junction / unidade mapeada / alias subst não é mais julgado foreign (corrige o "lockout ao entrar por outro caminho"); aliases que o realpath não resolve continuam fail-closed (melhor esforço);
- **só quando o arquivo `memory.db` não existe mesmo** ele é criado e confiado. **Qualquer `memory.db` pré-existente — mesmo schema-only / sem linhas — é não confiável por padrão** (fecha o caminho de envenenamento "banco vazio pré-instalado + triggers do SQLite");
- um banco não confiável **nunca é aberto por rodadas normais de chat**: sem upgrade de schema, sem criação de índices, sem migração, sem leitura — apenas uma sonda readonly toca o arquivo. Seu conteúdo não é injetado, e **todas as ferramentas de memória (leitura e escrita), dream e reflexão são recusados**; um aviso único explica como confiar (`security.trustWorkspaceMemory: true`);
- até você confiar explicitamente ou apagar/renomear o banco. Só ative a confiança para um banco que você sabe que é seu;
- `autoMigrate` **agora tem padrão `false`**: o `PROJECT.md` do workspace não é mais importado automaticamente.
- **O banco global também passa pelo portão de confiança**: `<activeHomeDir>/global/.owner.json` (marcador installId, `workspace: ''` sem vínculo de workspace); ausente → criado e confiado, pré-existente sem marcador válido → **foreign**. Banco global foreign volta automaticamente ao comportamento de workspace único da 0.32 (sem leituras/escritas globais); **não há override de configuração estilo `trustWorkspaceMemory` para o banco global**; um diretório global copiado/sincronizado de outra máquina é julgado foreign.

### `memory_home` é somente consulta por padrão (correção #64-2)

`memory_home` é uma ferramenta que o modelo pode chamar diretamente. O upstream deixava mover todo o diretório global (onde ficam logs / window index / estado de migração) — um efeito colateral de filesystem que o modelo não deveria ter.

Desde a 0.32:

- `security.allowHomeSwitch: false` por padrão; `memory_home` só **consulta**, e pedidos de troca são recusados explicitamente;
- ative `security.allowHomeSwitch: true` só se quiser que o modelo possa trocar de diretório;
- o diretório de override de prompts resolve de `$DSH_HOME/storages/meow-memory/prompts/` **fixo**, **não** de `homeDir` / `memory_home` / `MEOW_MEMORY_HOME`, e o local antigo não é mais lido (sem fallback) — trocar de diretório nunca muda as instruções injetadas.

### Rede e autenticação

- O plugin **não faz requisições de rede de saída** (sem telemetria). As requisições de modelo do dream/reflexão passam pelas rodadas de agent existentes do host, não pelo plugin.
- As 3 rotas locais do cliente (`/meow-memory/dreamed-sessions` etc.) passam pelo portão de autenticação `connection.requestRejection` desde 0.31.1: requisições cross-site recebem 401/403; 503 quando o serviço de auth falta.
- **As rotas de dados também passam pelo portão de confiança (0.32.1)**: `GET /meow-memory/dreamed-sessions` e `GET/POST /meow-memory/skip-dreams` não abrem bancos untrusted / ainda não julgados; POST retorna **403** para workspace untrusted (nenhum conteúdo de memória é exposto; auth inalterada).
- O portão de confiança também cobre **o rastreio de atividade de janelas e a restauração do window-index no boot**: nada abre/atualiza um banco untrusted só para registrar bookkeeping de janela; só a sonda readonly e o julgamento da cadeia de injeção tocam nele.
- `security.debugLogs` padrão `false`: `perf.log` e dumps de diagnóstico de settings/configEditor não são gravados por padrão (ative `security.debugLogs: true` ou `MEOW_MEMORY_DEBUG=1` ao investigar). `dream-debug.log` **continua sendo gravado por padrão**, mas só com info mínima (ids de sessão / contagens / motivos de skip, sem texto de memória), com limpeza de 48h e rotação em 5MB na inicialização; `apply-error.log` / `settings-register-error.log` são error-only. **Não leia isto como "zero logs por padrão".**

### Desinstalar deixa dados (limpe manualmente)

Desinstalar não apaga memórias. Quando não precisar mais:

```
<workspace>/.dsh-meow/                       # memory.db, memory.db.bak, sessions/, .owner.json, .gitignore
~/.dsh-meow/                              # ou seu homeDir: global/memory.db, global/memory.db.bak, logs, window-index, migrate-state
$DSH_HOME/storages/meow-memory*           # install-id, overrides de prompt, ponteiro de troca (meow-memory-home.json)
```

---

## Recursos

- **Sete níveis de memória**: `soul` (a própria IA) / `user` / `project` (com `subcategory`) / `fact` / `lesson` / `topic` (com frase-objetivo) / `rules`. Uma tabela SQLite por nível, ids com prefixo de tempo.
- **Armazenamento em duas camadas (0.33)**: `soul` / `user` / `rules` globais ficam no **banco global do usuário**, compartilhado entre workspaces; `project` / `fact` / `lesson` / `topic` / rules de projeto ficam no banco do workspace. Veja [Onde a memória fica](#onde-a-memória-fica-armazenamento-em-duas-camadas-033).
- **Injeção da primeira rodada**: soul / user / regras globais / guia de memória são injetados antes da primeira mensagem como snapshot de plugin, **sem reescrever o prompt do usuário**; soul / user / regras globais vêm do banco global com o banco do workspace como fallback; **sem acertos na primeira rodada** (começam na segunda).
- **Acertos por palavra-chave + piso léxico híbrido + piso semântico opcional (0.35)**: a partir da segunda mensagem, fact/lesson/rules/topic são casados pelas **palavras-chave da entrada**, no escopo global + ancoragem no projeto atual, injetando até `hitTopK`. A 0.33 adiciona um complemento léxico offline — Jaccard de bigramas de caracteres + 0,25×Jaccard de trigramas (seguro para CJK, NFKC) — usado como **piso** quando o BM25 é fraco: `score = max(BM25, 0,55·fuzzy·recency·importance)`, piso de ruído 0,2. A 0.35 permite `retrieval.semantic` (desligado por padrão): com ela ativa, a similaridade de cosseno entre a query e os embeddings das entradas é **também um piso** (`relevance = max(léxico, fuzzy, cos·weight·importance)`, cos < 0,25 conta como 0), cobrindo parte das paráfrases; **não é rerank e não garante qualidade semântica** (veja as limitações abaixo).
- **Ancoragem no projeto atual**: passar `project` ancora o projeto atual da sessão; sem ancoragem os acertos buscam só o global.
- **Amigável a cache**: a section estática `meow-memory:guide` é registrada uma vez no system prompt, texto constante, não quebra o cache de prefixo do provider.
- **Reinjeção pós-compactação**: a rodada seguinte reinjeta o snapshot, os panoramas consultados nesta sessão e as entradas escritas nesta sessão (limitado por `reinjectMaxChars`).
- **Realidade da deduplicação**: só entradas do **mesmo nível** com Jaccard de bigramas ≥ 0.8 (quase idênticas) se fundem automaticamente. **Paráfrases não se fundem** e contradições entre níveis não são detectadas — use `memory_find_similar` + `memory_update`/`memory_forget`.
- **Dream por janela**: com a janela ociosa ≥ `idleMinutes` (padrão 3 h), fora do pico e com live agent, o agente principal dela consolida em três rodadas (atômicas / topic / resumo de projeto). Desde a 0.32 o dream automático **não chama mais `agents.resume()`** para ressuscitar agent bare (#49), tem limites de contexto e frequência, exclui entradas arquivadas e limita as listas. A 0.34 permite `dream.isolated: true`: o dream automático roda numa **sessão filha spawnada de contexto vazio** (crescimento zero do contexto principal, tokens do filho ainda cobrados), com fallback ao agente principal em falha/timeout; `/dream` manual sempre usa o agente principal. `/dream` ou `memory_dream` consolidam sob demanda.
- **Reflexão**: depois de ≥ `reflectTurns` passos de ferramenta seguidos na mesma tarefa, pergunta ao modelo se há algo a memorizar; se a última ferramenta foi `memory_*`, suprime. A 0.32 adiciona limite diário e intervalo mínimo.
- **UI do cliente**: o texto injetado dobra numa barra, rodadas de reflexão/dream dobram num cartão, a lista de sessões mostra ícones de dream. Depende de internals do host 0.2.x e é "melhor esforço" — um patch do host pode desativar silenciosamente (só estética).
- **Zero dependências de runtime**: `node:sqlite` + bundle esbuild autocontido, sem módulos nativos.

### O que ele não faz (não se engane)

- **A busca semântica vem desligada**: sem `retrieval.semantic` não há recall semântico (só BM25 + fuzzy da 0.33). Quando ativada é um **piso experimental** (só cosseno ≥0,25 participa, sem rerank, correspondências fracas podem entrar), depende de um **endpoint externo de embeddings** (nenhum modelo local é empacotado), degrada silenciosamente para o léxico em falha/timeout, **não é exposta na página de settings** (só arquivo de config) e trocar o modelo de embedding invalida os vetores armazenados (vetores são específicos do modelo; dimensões diferentes contam como 0, então reescreva/refaça o backfill).
- **Memória de nível de projeto continua por workspace**: `project` / `fact` / `lesson` / `topic` / rules de projeto seguem o cwd (workspace novo = memória de projeto nova). Só `soul` / `user` / regras globais são compartilhados entre workspaces (banco global do usuário, 0.33).
- **O banco global não participa do dream**: as três rodadas do dream continuam consolidando só o banco do workspace; entradas globais são mantidas por ferramentas/reflexão.
- **Trade-offs do dream isolado**: com `dream.isolated: true` o contexto principal fica estável, mas o filho recebe só o prompt do dream + digest recente + listas de entradas (sem resultados de ferramenta), então **a qualidade da consolidação é menor que o caminho principal**; **o dream isolado não pode ser abortado pela UI**; o filho **herda o agent preset do pai**, então a visibilidade de `memory_*` depende desse preset (risco residual); `isolatedArchiveChild` arquiva o filho depois que ele assenta (**sucesso e falha**, deixando uma cópia plaintext da sessão filha); se `subagents`/`spawn` faltar ou o start for rejeitado, volta ao dream do agente principal.
- **O dream ainda deixa suas instruções/respostas/chamadas no histórico da sessão principal (caminho principal)**: dobrar é só visual, os tokens persistem; o caminho isolado deixa só fatos log-only, sem turno de dream visível ao modelo.
- **A migração arquiva as cópias do workspace**: após atualizar para 0.33, as linhas originais de soul/user/regras globais no workspace ficam archived (conteúdo preservado); se o banco global se perder, elas não são reinjetadas automaticamente — restaure o diretório global ou `memory_forget mode=restore` por id.
- **O esquecimento é uma meia-vida exponencial, não uma curva de revisão de Ebbinghaus**: `retrieval.halfLifeDays` padrão 30 dias, `exp(-ln2 × dias/30)` com piso 0.85 para importance≥3. O dream carimba `updated_at` na consolidação, então a entrada da decaída é afetada pela própria consolidação.
- **O dream ainda deixa suas instruções/respostas/chamadas no histórico da sessão principal**: dobrar é só visual, os tokens persistem.
- **A troca do `memory_home` está desligada por padrão**; quando ligada, continua sendo uma ferramenta chamável pelo modelo — avalie o risco.

---

## Instalação

**Este fork não foi publicado no registry npm.** Três caminhos; `npm install meow-memory` instala o **upstream 0.31.1**, não este repositório.

### Caminho A: diretório local / tarball (recomendado, sem GitHub)

1. Compile uma vez no repositório (este repo não commita `lib/`):

   ```sh
   npm install
   npm run build        # → lib/index.js, lib/client.js, lib/prompts/
   ```

2. Escolha:
   - **diretório local**: GUI **Plugins → Add plugin**, informe o **caminho absoluto** deste repositório;
   - **tarball**: `npm pack` gera `meow-memory-0.35.0.tgz`; informe o caminho absoluto do `.tgz`.
3. Reinicie `dsh web` (ou recarregue o plugin). Novas sessões carregam automaticamente.

> Instalações locais `file:`/`link:` não rodam `prepare`, então **compile primeiro**; um tarball já contém `lib/`.

### Caminho B: instalação manual no profile

1. Copie (ou symlink/junction) para `~/.dsh/profiles/<profile>/node_modules/meow-memory`:

   ```sh
   mkdir -p ~/.dsh/profiles/<profile>/node_modules
   ln -s /caminho/absoluto/meow-memory ~/.dsh/profiles/<profile>/node_modules/meow-memory
   ```

   Windows: `New-Item -ItemType Junction ...` (junction NTFS, sem admin).

2. Adicione `meow-memory` ao `dsh.profile.bundles` do `package.json` do profile.
3. Reinicie `dsh web`.

### Caminho C: one-liner `github:` (**não recomendado**)

```sh
dsh plugin --profile <profile> add github:<url-do-seu-fork>
```

⚠️ Dependência `github:`/git instala **devDependencies e roda `prepare` (build esbuild)**. Precisa de GitHub acessível, aprovação de scripts de build no pnpm (≥10 bloqueia; adicione `allowBuilds`) e devDeps `@deepseek-ai/dsh-*` resolvíveis. Qualquer falha faz rollback. Use o caminho A, a menos que esteja validando a cadeia de build.

### ⚠️ Atualizando do upstream 0.31: o banco antigo é não confiável por padrão

Um `memory.db` criado pelo upstream 0.31 não tem o marcador `.owner.json`, então na primeira execução este fork o classifica como **foreign / não confiável**: seu conteúdo não é injetado, as ferramentas de memória (leitura/escrita), dream e reflexão são recusados e um aviso único de "banco de memória do workspace não confiável" aparece. **Mesmo um banco upstream vazio conta como pré-existente e é não confiável por padrão.**

Para manter as memórias antigas, faça uma das opções:

- defina explicitamente `security.trustWorkspaceMemory: true` na configuração do profile e recarregue o plugin (só depois de confirmar que o banco é seu);
- ou apague/renomeie o `memory.db` antigo e comece do zero (faça backup antes — a exclusão é irreversível).

### Remover

```sh
dsh plugin --profile <profile> remove meow-memory
```

**Os dados de memória não são apagados**; veja [modelo de segurança](#modelo-de-segurança) para os caminhos.

---

## Compatibilidade

O ambiente em que este fork foi realmente verificado (não é uma promessa de "compatível com tudo"):

| Item | Valor |
|---|---|
| Host | **DSH Desktop 0.2.1-rc.2** (Windows 11) |
| Runtime | Electron 44.7.0 / Node **24.21.0**, `node:sqlite` disponível |
| Verificado | Instância isolada carrega; 3 rotas `/meow-memory/*` retornam 200 com auth / 401 sem; namespace de settings aparece; sem erro de apply. O live load da 0.34 com `dream.isolated: true` só verificou o carregamento; o bug de start do filho da 0.34.0 (`maxDepth: 0`) foi achado em re-auditoria e corrigido na 0.34.1. A 0.35 também rodou live loads com config padrão e com semântica ativa: as duas carregaram sem erro de apply, **zero requisições de embedding no boot quando desativada**, sem writes no home real. **Modelo real / dream de sessão filha e endpoint de embedding real não foram exercitados na instância isolada** (sem credenciais; a camada semântica é coberta por testes unitários com servidor mock de embeddings) |
| Não verificado | **Hosts 0.1.x** (este fork não testou; a alegação "suporta dsh 0.1.5" foi removida); outros patch releases 0.2.x |

Riscos de compatibilidade conhecidos (achados do upstream, inalterados por este fork):

- **Caminho de salvamento de settings**: após a reformulação do serviço de settings no 0.2.x o plugin usa um caminho degradado. A página renderiza, mas "editar → salvar → recarregar → aplicado" não foi verificado neste fork; no pior caso os valores aparecem mas não chegam ao apply. Rode a [verificação pós-instalação](#verificação-pós-instalação).
- **UI do cliente** (barras de dobra / ícones de lua / painel de menu) depende de internals `ChatSnapshot` do 0.2.x e observação de DOM; um patch do host pode desativar silenciosamente (só estética).
- `node:sqlite` exige **Node ≥ 22.13** (22.5–22.12 precisa de `--experimental-sqlite`).

---

## Configuração

Todos os campos são opcionais. **Os novos grupos `security` / `budget` / `retrieval` da 0.32 só funcionam via arquivo de configuração** (profile patch ou `cordis.patch.yml`); a página de settings continua cobrindo os campos da 0.31 (o código da página está fora desta rodada de endurecimento).

```yaml
- id: meow-memory
  name: 'meow-memory'
  config:
    enabled: true
    projectDir: '.dsh-meow'
    promptLang: 'zh'          # defina explicitamente no primeiro uso
    hitTopK: 2
    autoMigrate: false        # mudou na 0.32: sem importação automática de PROJECT.md
    security:
      trustWorkspaceMemory: false   # confiar num memory.db pré-existente (inclusive vazio/schema-only)
      allowHomeSwitch: false        # permitir memory_home trocar o diretório global (padrão: só consulta)
      autoGitignore: true           # escrever/completar .dsh-meow/.gitignore (auto-ignorante)
      debugLogs: false              # diagnóstico perf/settings desligado (dream-debug ainda grava mínimo)
    budget:
      snapshotMaxChars: 6000        # limite do snapshot da primeira rodada (caracteres)
      hitMaxChars: 1500             # limite por entrada de acerto (caracteres)
      reinjectMaxChars: 8000        # limite da reinjeção pós-compactação (caracteres)
      dreamMaxContextTokens: 40000  # pular dream/reflexão automáticos acima deste contexto estimado
      dreamMaxPerWindowPerDay: 1    # frequência máxima de dream automático (por janela/dia)
      dreamMaxPerDayTotal: 12       # limite de processo do dream automático/dia (24h rolantes; zera no restart; 0 = off)
      reflectMaxPerDay: 6           # limite diário de reflexões (por janela)
      reflectMaxPerDayTotal: 24     # limite de processo de reflexões automáticas/dia (24h rolantes; zera no restart)
      reflectMinIntervalMinutes: 20 # intervalo mínimo entre reflexões
    retrieval:
      halfLifeDays: 30              # meia-vida exponencial (dias)
      minScore: 0.35                # limiar de injeção de acertos
      hitBoost: true                # reforço por contagem de acertos
      importanceWeight: true        # importance participa do ranking
      semantic:                     # 0.35 busca semântica opcional (off = zero rede)
        enabled: false              # só um true explícito requisita o endpoint
        baseUrl: ''                 # base compatível com OpenAI, ex.: http://127.0.0.1:11434/v1
        model: ''                   # nome do modelo de embedding
        apiKeyEnv: 'MEOW_MEMORY_EMBEDDING_KEY' # variável com a chave; padrão ausente = requisições sem chave
        timeoutMs: 5000             # timeout por requisição (ms; falha cai silenciosamente no léxico)
        weight: 0.8                 # peso do piso semântico (0..1; 0 = desliga o piso semântico)
    dream:
      enabled: true
      idleMinutes: 180
      isolated: false             # 0.34: dream automático numa sessão filha spawnada isolada (desligado por padrão)
      isolatedProvider: 'spawn'   # provider do filho (precisa de inheritsParentContext=false)
      isolatedTimeoutMinutes: 20  # timeout → dispose do filho, libera lease, retenta
      isolatedMaxPromptChars: 20000 # limite de caracteres do prompt único do filho
      isolatedArchiveChild: true  # arquiva o filho depois que ele assenta (sucesso e falha; melhor esforço)
```

**Todos os campos, tipos, padrões e efeitos estão em [docs/configuration-reference.md](docs/configuration-reference.md)** (inclui `titleMax` / `homeDir` / `disabledWorkspaces` / `backup` / `delegate`).

> ⚠️ **Defina `promptLang` explicitamente no primeiro uso.** Ele decide o idioma dos prompts injetados/reflexão/dream e das descrições das ferramentas, e molda o idioma em que o modelo escreve entradas — as palavras-chave são extraídas no idioma da entrada. Idiomas embutidos: `zh` / `en` / `pt-br`. O valor *é* o nome do subdiretório e casa **literalmente**: um valor inexistente (ex.: `pt`) não gera erro e cai silenciosamente no chinês.

### Idioma da interface

O texto de UI segue Configurações → Geral → Idioma do DSH (中文 / English / Português (Brasil)) — uma camada separada do `promptLang`.

---

## Como funciona

```
Primeira mensagem (rodada 1)     Cada mensagem a partir da 2ª            ocioso ≥3h + fora do pico + live agent
┌────────────────────┐          ┌────────────────────┐                   ┌──────────────────────┐
│ ===== longo prazo ====│          │ possivelmente relev.  │                   │ dream por janela:    │
│ [sobre você] (soul)  │          │ para referência:     │                   │ três rodadas (inclui │
│ [sobre user]         │          │ acertos por palavra- │                   │ resumo de projeto)   │
│ [princípios] (rules) │          │ chave top-K+minScore │                   │ limites de contexto/ │
│ [guia de memória]    │          │ (global + projeto)   │                   │ frequência           │
└────────────────────┘          └────────────────────┘                   └──────────────────────┘
snapshot independente           vistos por sessão                        rodadas de consolidação ficam
↓ prompt do usuário intacto     sessions/<id>.json                       no histórico principal
uma vez por sessão,             compactação → libera vistos + reinjeta   (dobrar ≠ não gastar tokens)
sem acertos na rodada 1
```

> Desde a 0.33 o snapshot da primeira rodada lê soul / user / regras globais do banco global do usuário (`<activeHomeDir>/global/memory.db`), com o banco do workspace como fallback; panorama de projeto e reinjeção continuam somente no workspace.

### Ferramentas (10 na 0.35)

| Ferramenta | Faixa | Uso |
|---|---|---|
| `memory_remember` | escrita | Grava uma memória (content/project/keywords/importance obrigatórios; **soul/user/regras globais vão para o banco global do usuário, o resto para o do workspace**; duplicatas quase idênticas fundem) |
| `memory_search` | leitura | Busca híbrida (BM25 + piso de n-gramas de caracteres + piso semântico opcional) × recência exponencial, com `explain` (opcional `fuzzy` / `semantic`) e filtros level/project/status/days; consulta os dois bancos; com semântica ativa a query envia uma requisição de embedding |
| `memory_project` | leitura | Recupera o parágrafo de injeção completo de um projeto (`project` obrigatório); **só o banco do workspace** |
| `memory_find_similar` | leitura | Detecção de duplicatas e conflitos; consulta os dois bancos |
| `memory_read` | leitura | Lê os metadados completos de uma entrada por id; consulta os dois bancos |
| `memory_update` | escrita | Corrige status / importance / goal / keywords / content; grava no banco dono da entrada |
| `memory_list` | leitura | **nova na 0.32**: lista ids/títulos/palavras-chave/status/timestamps, sem corpos; mescla os dois bancos e deduplica por id |
| `memory_forget` | escrita | **nova na 0.32**: arquivar/restaurar/apagar por id. Arquivar é o padrão; `mode:'delete'` apaga de vez e exige `confirm:true`; consulta os dois bancos |
| `memory_dream` | escrita | Dispara manualmente a consolidação desta janela (igual a `/dream`; só o banco do workspace; **sempre o caminho do agente principal** — o modo isolado da 0.34 vale só para dream automático) |
| `memory_home` | diretório | Consulta o diretório global; **só consulta por padrão desde a 0.32**, exige `security.allowHomeSwitch: true` para trocar (na 0.33 a troca move o banco global também, fechando a conexão antes) |

**Parâmetros, retornos e efeitos colaterais: [docs/tool-reference.md](docs/tool-reference.md)**.

---

## Desenvolvimento e testes

```sh
npm install
npm run build          # bundle esbuild → lib/index.js / lib/client.js (autocontido)
npm run test           # build + checagem dos pacotes de idioma + asserções (host + cliente)
node scripts/check-lang.mjs en       # checa um pacote de prompt
```

Asserções de teste: `npm test` **1219 todas verdes** (host 859 + cliente 360), 0 falhas; mais 29 em `node smoke.mjs`; `scripts/check-lang.mjs` valida os pacotes en/pt-br (11 slots alinhados).

Os pacotes `@deepseek-ai/*` ficam no workspace pnpm dsh-meow, não no `node_modules` deste pacote. No Windows, `npm run link-workspace` cria junctions para o esbuild resolver (só em tempo de build).

### Verificação pós-instalação

1. Uma rodada normal de conversa: a primeira rodada mostra a barra de memória de longo prazo? (Não → o plugin não está rodando.)
2. Mude uma configuração → salve → recarregue o plugin → o valor foi aplicado? (Checa o drift de settings do 0.2.x.)
3. Depois de `/dream`, continue conversando: o número de ferramentas está normal? (Guarda #66.)
4. Depois de uma rodada de reflexão, veja o seletor de modelo: continua o modelo principal? (#71 só dispara com `delegate.model` definido.)
5. Abra uma sessão num repositório clonado e não confiável: não deve aparecer memória de longo prazo que você não escreveu (banco não confiável + sem auto-migração);
6. Abra uma sessão em outro workspace: `soul` / `user` / regras globais devem continuar lá (banco global do usuário), enquanto `project` / `fact` são do novo workspace (verifica as duas camadas);
7. Com `dream.isolated: true`: depois de um dream automático não deve haver turno de dream na sessão principal (só fatos log-only) e a sessão filha deve estar arquivada (após assentar, sucesso ou falha); um `/dream` manual ainda deve gerar um turno de dream do agente principal. Se o start do filho for rejeitado, o dream do agente principal deve continuar (log `isolated-dream rejection -> main-dream fallback`; o bug `maxDepth` da 0.34.0 foi corrigido na 0.34.1).
8. Com `retrieval.semantic.enabled: true`: com `security.debugLogs` devem aparecer logs de backfill (registros históricos são preenchidos após o primeiro apply); `memory_search` com `explain:true` deve incluir um componente `semantic`; aponte o endpoint para uma URL inválida e ele deve cair silenciosamente no léxico sem bloquear injeção/ferramentas (e com semântica desligada, confirme zero requisições de embedding nos logs/rede).

---

## Documentação

| Para saber sobre | Leia |
| --- | --- |
| Parâmetros, retornos e efeitos das 10 ferramentas | [docs/tool-reference.md](docs/tool-reference.md) |
| Todos os campos de configuração, tipos e padrões | [docs/configuration-reference.md](docs/configuration-reference.md) |
| Por que é projetado assim (custo e trade-offs) | [docs/design-notes.md](docs/design-notes.md) |
| Falhas de instalação, recall ruim, como ler erros | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Histórico de versões e problemas conhecidos não corrigidos | [CHANGELOG.md](CHANGELOG.md) |
| Adicionar idioma de UI | [src/i18n/README.md](src/i18n/README.md) |
| Adicionar pacote de prompt | [src/prompts/README.md](src/prompts/README.md) |

## Agradecimentos

A maior parte do código vem do upstream e destes contribuidores (atribuição original mantida):

- **[daveycodez](https://github.com/daveycodez)** — pacote de idioma inglês e tokenizador ([PR #6](https://github.com/Phant0Meow/dsh-meow-memory/pull/6), v0.22.0)
- **[chenmzh](https://github.com/chenmzh)** — injeções de memória como mensagens plugin snapshot independentes, corrigindo a poluição do título da sessão ([PR #10](https://github.com/Phant0Meow/dsh-meow-memory/pull/10))
- **[cuddly-guacamole](https://github.com/cuddly-guacamole)** — compatibilidade de Session events para dsh 0.1.2-alpha.4 ([PR #11](https://github.com/Phant0Meow/dsh-meow-memory/pull/11))
- **[coutogilson](https://github.com/coutogilson)** — pacote de prompt em português (BR) e a camada de texto de UI

As mudanças de endurecimento da 0.32 (portões de confiança, limites de orçamento, frequência de dream/reflexão, fórmula de recuperação, ferramentas de gestão, reescrita da documentação) estão no [CHANGELOG.md](CHANGELOG.md).

## Licença

MIT — veja [LICENSE](LICENSE). O copyright do upstream pertence ao autor de `Phant0Meow/dsh-meow-memory`; este fork mantém a LICENSE e a atribuição originais.
