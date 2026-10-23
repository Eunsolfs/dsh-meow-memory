# textos das ferramentas do meow-memory (linhas chave-valor: `- key: value`; o primeiro dois-pontos ASCII + espaço é o separador, o valor é mantido literalmente; uma linha que começa com dois espaços continua o valor anterior. Os títulos `###` são apenas para leitura e são ignorados pelo parser.
# Convenção de chaves: <tool>.description / <tool>.param.<name> / <tool>.out.<path>. Uma chave ausente gera erro; chaves novas precisam ser espelhadas em src/tools.ts.)

### memory_remember

- memory_remember.description: Escreva algo que valha a pena lembrar entre sessões no armazenamento de memória deste workspace (SQLite, uma tabela por level). Obrigatórios: content / project ("global", ou um nome de projeto; separe vários por vírgula) / keywords (8 a 13 palavras-chave de recuperação) / importance. Omitir um deles gera um erro pedindo que você o preencha. Levels: soul=a própria IA (use com parcimônia); user=fatos básicos e preferências de base do usuário; project=um projeto (ex.: femwa/meow-memory/meow-eyes/dsh); rules=princípios de design / diretrizes de comportamento (uma regra global usa project "global" e, com importance>=2, é injetada por completo no primeiro turno; uma regra específica de projeto usa o nome desse projeto e é injetada com memory_project; todo o resto aparece pela busca); fact=fatos atômicos pequenos (uma frase simples, <=30 palavras); lesson=o que você aprendeu, sua própria experiência (tudo em que você foi corrigido entra aqui); topic=um assunto (dê a ele uma frase de objetivo; recuperado por palavras-chave). Regra rígida: quando o usuário explica o pensamento de design de um projeto, o framework ou o raciocínio por trás de uma decisão, o content deve preservar as palavras do próprio usuário — não parafraseie nem resuma isso. Entradas que se sobrepõem muito a uma existente são mescladas automaticamente (atualizadas, não duplicadas). A ferramenta confirma em caso de sucesso — não é preciso chamá-la de novo.
- memory_remember.param.content: O que lembrar; fact/lesson uma frase <=30 palavras; topic <=180 palavras; onde as palavras do próprio usuário estiverem envolvidas, mantenha a redação dele.
- memory_remember.param.level: Nível de memória, padrão fact.
- memory_remember.param.project: Obrigatório. Nome do projeto (deve ser um nome concreto de projeto quando level=project); use "global" para informações aplicáveis globalmente; separe vários projetos por vírgula, ex.: "dsh,femwa".
- memory_remember.param.subcategory: subcategoria de project: overview=propósito e resumo / structure=arquitetura / decisions=decisões técnicas / quotes=as palavras do próprio usuário / ops=implantação e dados / todo=em andamento.
- memory_remember.param.goal: A frase de objetivo do topic (recomendada quando level=topic, ex.: "fazer a integração do femGen funcionar").
- memory_remember.param.importance: Importância (qualquer número, sem limite superior; orientação suave 1-4: 4=linha vermelha fatal / saúde e segurança, 3=enfatizado pelo usuário / aplicável globalmente, 2=uma decisão do usuário ou uma conclusão abstrata, 1=trivialidade).
- memory_remember.param.corrected: Se isto é algo que o usuário corrigiu (para level=lesson).
- memory_remember.param.keywords: Obrigatório. As 8-13 palavras-chave de busca (uma mesclagem as atualiza para o valor mais recente); omiti-las gera erro — não há extração automática como fallback.
- memory_remember.out.keywords: As palavras-chave realmente armazenadas (após uma mesclagem, o valor mais recente).
- memory_remember.out.project: O projeto realmente registrado (se houver).

### memory_search

- memory_search.description: Pesquisa no armazenamento de memória deste workspace (BM25 x peso de recência). query é obrigatória e não pode ficar vazia — passe as palavras-chave ou a frase que você procura, ex.: memory_search({query: "implantação do plugin de memória"}); para navegar um projeto inteiro use memory_project (não precisa de query), não chame esta ferramenta com query vazia. O que volta (decisão do usuário): top 10 padrão = as 5 primeiras direto do ranking de relevância (nada excluído, incluindo entradas já injetadas/pesquisadas/criadas nesta sessão) + 5 mais tiradas de mais abaixo no ranking, pulando entradas já injetadas/já pesquisadas (assim você recebe material novo). Escopo padrão = fact+lesson+topic+rules; level aceita uma lista separada por vírgulas (ex.: fact,lesson); passe level=project para a visão do projeto inteiro. Os resultados são pegos por top-k de relevância e depois reordenados pelo timestamp da memória (antigo -> novo), para você ver como as coisas evoluíram e qual de duas entradas conflitantes é mais nova.
- memory_search.param.query: Palavras-chave ou frase de busca (obrigatória, não pode ficar vazia; ex.: "implantação do plugin de memória").
- memory_search.param.level: Restringe a levels, separados por vírgula: fact/lesson/topic/rules/project/soul/user (padrão fact,lesson,topic,rules).
- memory_search.param.project: Filtra por nome de projeto (separados por vírgula, semântica OR, ex.: "dsh,femwa"; entradas "global" e sem rótulo são sempre incluídas).
- memory_search.param.status: Filtra por status (separados por vírgula: active/archived/stale/all; padrão active, em que um todo stale conta como concluído e ainda participa; incluir all = sem filtro).
- memory_search.param.days: Apenas entradas criadas nos últimos N dias (por tempo de criação).
- memory_search.param.k: Número máximo de resultados.
- memory_search.param.content_max: Trunca o content de cada entrada neste comprimento, 0=texto completo.
- memory_search.param.explain: Interruptor de recuperação explicável (padrão desativado). Com true, cada hit traz uma decomposição de pontuação em explain (pontuação bm25 de palavras-chave, importance, peso recencyWeight de meia-vida exponencial, status), para depurar "por que não foi recuperado / por que foi recuperado"; a ordem não muda.
- memory_search.out.note: Nota de conflito.
- memory_search.out.hits.id: id completo da memória (passe-o para memory_read/memory_update/memory_find_similar).
- memory_search.out.hits.keywords: As palavras-chave da entrada (extraídas por um LLM ou automaticamente).
- memory_search.out.hits.project: Projeto ao qual a entrada pertence; ""=sem rótulo; entradas aplicáveis globalmente mostram "global".
- memory_search.out.hits.updated_at: Timestamp da memória (última atualização, em milissegundos).
- memory_search.out.hits.explain: Pontuação bruta BM25 de palavras-chave (importance/recencyWeight/status voltam juntos no mesmo objeto).

### memory_find_similar

- memory_find_similar.description: Encontra entradas semelhantes a um dado id de memória (cosseno sobre vetores de frequência de termos) — para detectar duplicatas, encontrar conflitos e verificar se já existe algo próximo desta entrada. Como a busca, ela olha apenas memórias criadas em outras sessões; tudo que já foi visto nesta sessão (injetado ou pesquisado) é excluído automaticamente.
- memory_find_similar.param.id: O id de memória de referência (o id completo dos resultados de memory_read/search, ou seus 12 primeiros caracteres).
- memory_find_similar.param.k: Número de resultados.
- memory_find_similar.param.content_max: Trunca o content de cada entrada neste comprimento, 0=texto completo.
- memory_find_similar.out.hits.similarity: Similaridade de cosseno 0-1; quanto maior, mais próxima.

### memory_read

- memory_read.description: Lê uma memória por completo (incluindo os metadados title/keywords/importance/status).
- memory_read.param.id: id da memória (do bloco de injeção ou de um resultado de memory_search).

### memory_update

- memory_update.description: Atualiza uma memória (content / importance / status / project / frase de objetivo do topic / keywords, ...). Valores de status: active / stale (finalizado: um todo concluído, um topic que atingiu seu objetivo -> stale significa done) / archived (excluído: entradas desatualizadas, inválidas, duplicadas ou substituídas).
- memory_update.param.id: id da memória.
- memory_update.param.content: Novo content (ao reescrever um topic: causa, percurso, desenvolvimento, resultado, <=180 palavras).
- memory_update.param.status: Novo status.
- memory_update.param.importance: Nova importância (qualquer número, sem limite superior; orientação suave 1-4: 4=linha vermelha fatal / saúde e segurança, 3=enfatizado pelo usuário / aplicável globalmente, 2=uma decisão do usuário ou uma conclusão abstrata, 1=trivialidade).
- memory_update.param.goal: Nova frase de objetivo (topic).
- memory_update.param.project: Novo nome de projeto (project/fact/lesson/rules/topic); use "global" para informações aplicáveis globalmente; separe vários projetos por vírgula; uma string vazia limpa o campo (sem rótulo).
- memory_update.param.keywords: Palavras-chave que você escolhe (corrija-as ou amplie-as sempre que notar que estão erradas; omitir o parâmetro ou passar um array vazio deixa as palavras-chave intactas).

### memory_project

- memory_project.description: Recupera do armazenamento de memória o bloco de injeção completo de um projeto (texto puro, agrupado por subcategoria, todas as entradas que não estão desatualizadas de uma vez). project é obrigatório: qual projeto você quer ver? Chamar sem ele gera um erro, então defina o nome do projeto primeiro. Chame-a quando o usuário mencionar um projeto (femwa/meow-memory/meow-eyes/dsh, ...) e perguntar sobre seu histórico de design, decisões técnicas, suas próprias palavras passadas ou onde ele está; também sempre que você precisar do panorama do projeto antes de responder. Regras: dentro de um grupo, as entradas vão de antigas -> novas pelo timestamp da memória; a subcategoria todo imprime "Concluído:" (as 5 concluídas mais recentemente) seguido de "Lista de tarefas:"; cada entrada traz seu id completo, seu timestamp de última atualização e seu texto.
- memory_project.param.project: Nome do projeto (o guia de memória no início da sessão lista todos os projetos que o usuário tem — escolha a partir dele).
- memory_project.out.text: O bloco de memória do projeto, agrupado por subcategoria (texto puro).

### memory_list

- memory_list.description: Lista os metadados das entradas de memória (id / level / título / palavras-chave / importance / status / projeto / timestamp da memória), **sem o texto completo** — uma visão de baixo custo em tokens para inventariar memórias e achar ids para entregar a memory_read / memory_update / memory_forget. Por padrão lista apenas entradas active; level / project / status aceitam múltiplos valores separados por vírgula; limit / offset paginam. Use memory_read para o texto e memory_project para o panorama do projeto.
- memory_list.param.level: Limita aos níveis, separados por vírgula: soul/user/project/fact/lesson/topic/rules; padrão all = todos os níveis.
- memory_list.param.project: Filtra por nome de projeto (separados por vírgula, OR); entradas "global" / não marcadas entram naturalmente.
- memory_list.param.status: Filtro de status: active (padrão) / stale / archived / all.
- memory_list.param.limit: Número máximo de entradas retornadas (1-100, padrão 20).
- memory_list.param.offset: Deslocamento de paginação (começa em 0, padrão 0).
- memory_list.out.note: Dica sobre o filtro atual e a contagem de resultados.
- memory_list.out.total: Total de entradas que casam com o filtro (não limitado por limit).
- memory_list.out.items.id: Id completo da memória (pode ser passado a memory_read / memory_update / memory_forget).
- memory_list.out.items.level: Nível da memória.
- memory_list.out.items.title: Título de exibição (truncado a partir do content).
- memory_list.out.items.keywords: Lista de palavras-chave.
- memory_list.out.items.importance: Importância.
- memory_list.out.items.status: Status (active / stale / archived).
- memory_list.out.items.project: Projeto; "" = não marcado; informação global é "global".
- memory_list.out.items.updated_at: Timestamp da memória (última atualização, milissegundos).

### memory_forget

- memory_forget.description: Trata uma memória por id: o padrão mode=archive a arquiva (recuperável); mode=restore desfaz o arquivamento voltando para active; mode=delete apaga permanentemente (irreversível, exige confirm=true). Afeta apenas uma entrada; para limpeza em lote chame várias vezes ou liste ids com memory_list primeiro. Prefira arquivar; apague de vez só quando o usuário pedir explicitamente para "excluir completamente".
- memory_forget.param.id: Id da memória (id completo ou id curto de 12 caracteres).
- memory_forget.param.mode: archive = arquivar (padrão, recuperável) / restore = desarquivar / delete = apagar de vez (irreversível, precisa de confirm=true).
- memory_forget.param.confirm: Obrigatório true quando mode=delete, senão a chamada é recusada; ignorado nos outros modos.
- memory_forget.out.note: Dica do resultado (arquivada / restaurada / apagada).
- memory_forget.out.id: O id da entrada tratada.

### memory_dream

- memory_dream.description: Agenda agora mesmo uma consolidação de memória (dream) para esta janela: tudo que esta janela criou ou trouxe à tona é enviado ao agente principal rodada a rodada para ser arrumado e guardado (rodada 1 = memórias atômicas, project/fact/lesson/rules/soul/user; rodada 2 = memórias de topic; rodada 3 = resumo de projeto, acrescentado apenas quando esta janela realmente mexeu com um projeto). Ela dispara automaticamente após 3+ horas de ociosidade da janela (suprimida nos horários de pico, 09:00-12:00 e 14:00-18:00 no horário de Pequim, mais os 15 minutos antes de cada um); esta ferramenta é o gatilho manual.

### memory_home

- memory_home.description: Visualiza o diretório global de dados do meow-memory (onde ficam dados em nível de instância, como logs, o ledger da janela de dream e o estado de migração; o armazenamento de memória em si fica dentro de cada projeto e não é afetado; as overrides de prompt NÃO ficam aqui — elas resolvem de `$DSH_HOME/storages/meow-memory/prompts/` fixo). **Somente consulta por padrão**: com `security.allowHomeSwitch: false` esta ferramenta apenas informa o diretório atual, os três presets e se a troca está habilitada; passar um target é recusado com explicação — esse é o portão de segurança: mover o diretório muda onde os dados de instância ficam, então o modelo não deve poder movê-lo. A troca só é permitida depois que o usuário define explicitamente `security.allowHomeSwitch: true` na configuração. A troca move automaticamente o conteúdo do diretório antigo (mover no mesmo disco / copiar entre discos). Após uma cópia entre discos, o diretório antigo é mantido, não excluído — lembre o usuário de apagá-lo manualmente depois de verificar; se várias instâncias do dsh compartilharem um mesmo diretório, lembre o usuário de atualizá-las em conjunto. Chame isto quando o usuário quiser mover os dados de memória ou os logs para fora do disco do sistema ou para outro local (primeiro confirme que a troca está habilitada, senão explique que a configuração precisa mudar). A troca persiste entre reinícios por meio de um arquivo de ponteiro em $DSH_HOME/storages/meow-memory-home.json.
- memory_home.param.target: Local de destino. Ou um marcador de preset: default = home do usuário do sistema (o padrão), dsh-storage = pasta meow-memory dentro das storages da home do DSH, plugin-root = pasta de storage ao lado do próprio plugin; ou um caminho absoluto. Omita para visualizar o estado atual sem alterar nada; passar um target é recusado enquanto `security.allowHomeSwitch: false`.
- memory_home.out.note: Resultado da visualização/troca: o diretório atual ou o novo, quantos arquivos foram movidos e o que fazer com o diretório antigo.
