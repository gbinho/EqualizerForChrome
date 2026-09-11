# Segurança

Este projeto existe para ser um equalizador em que dá para confiar. Por isso a segurança é regra de projeto, não detalhe.

## Compromissos

Toda mudança neste repositório precisa manter estas garantias:

- **Permissões mínimas:** só `tabCapture`, `offscreen`, `storage` e `activeTab`. Nada de `host_permissions`, `<all_urls>`, `scripting`, `tabs`, `history`, `cookies` ou `webRequest`.
- **Sem rede:** a política de segurança do `manifest.json` mantém `connect-src 'none'`. A extensão não faz requisições para lugar nenhum.
- **Sem código remoto:** só roda o que está no repositório (`script-src 'self'`). Nada de `eval`, `new Function` ou scripts baixados.
- **Sem dependências:** nenhuma biblioteca de terceiros, nenhum pacote npm, nenhuma etapa de build.
- **Sem dados:** ajustes e presets ficam só em `chrome.storage.local`, no computador de quem usa. O áudio é processado em tempo real e nunca é gravado.

Um pull request que quebre qualquer um desses pontos não é aceito, mesmo que traga uma função nova.

## Versões com suporte

Só a versão mais recente da branch `main` recebe correções.

## Como reportar uma vulnerabilidade

Se você encontrou algo que viola as garantias acima, ou que permita a uma página ou a outra extensão abusar desta:

1. Abra uma [issue](https://github.com/gbinho/EqualizerForChrome/issues) descrevendo o problema.
2. Se o problema puder ser explorado contra quem usa a extensão, **não publique o passo a passo**. Descreva só o impacto e peça um contato privado na issue.

A resposta vem assim que possível. Correções de segurança têm prioridade sobre qualquer outra mudança.

## Cuidado com cópias

A única fonte oficial é **github.com/gbinho/EqualizerForChrome**. A extensão ainda não é publicada na Chrome Web Store: qualquer versão com este nome em outra loja ou site não é deste projeto, e pode ter sido modificada.
