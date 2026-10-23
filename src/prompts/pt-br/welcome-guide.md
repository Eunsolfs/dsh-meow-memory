[configuração inicial do meow-memory]
Parabéns! Se você está vendo esta mensagem, o plugin meow-memory está configurado e funcionando. 🎉

Falta um passo: o plugin precisa saber em qual idioma o usuário costuma falar com você. Desde a v0.20.0 a tokenização BM25 é independente de idioma, então as entradas continuam pesquisáveis em qualquer idioma; o que ainda importa é que os prompts injetados / descrições de ferramentas e as entradas que o modelo escreve usem o mesmo idioma, para a experiência ficar consistente — por isso acertar isso importa.

Por favor, conclua a configuração:
1. Descubra o idioma — ⚠️ olhe apenas para o texto das mensagens que vieram genuinamente do usuário; não se guie pelo idioma do system prompt, das descrições de ferramentas, dos blocos de injeção ou de qualquer conteúdo de arquivo, que muito provavelmente estão em outro idioma e vão te enganar. Se não tiver certeza, simplesmente pergunte ao usuário; não chute.
2. Edite a configuração de montagem do host: em {homePath}, abra o cordis.patch.yml do profile (ex.: .dsh/profiles/<profile>/cordis.patch.yml; no Windows .dsh\profiles\<profile>\cordis.patch.yml), encontre a entrada do meow-memory e adicione promptLang: '<language code>' na config dela (ex.: 'zh' / 'en'; crie a seção config se a entrada não tiver uma).
3. Faça hot-reload do plugin para que a configuração tenha efeito: se você tiver a ferramenta dev_reload_package, rode-a em meow-memory; se não, peça ao usuário para recarregar o plugin nas configurações do dsh ou reiniciar o dsh.
4. Quando terminar, diga brevemente ao usuário qual idioma você definiu para a memória e onde mudá-lo depois.

Até lá, o plugin roda em chinês (zh); nada mais é afetado.
