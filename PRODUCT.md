# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Quem criou a extensão e um círculo pequeno de amigos e conhecidos, que recebem a pasta e instalam no Chrome pelo modo "Carregar sem compactação". Ouvem música no computador, principalmente no SoundCloud e às vezes no YouTube, com fone ou caixa de som.

O objetivo principal é deixar a música **mais encorpada, com mais graves e mais punch**: é para ouvir por diversão, não para análise técnica nem para corrigir equipamento.

Durante uma sessão eles **mexem o tempo todo**. Abrem o popup várias vezes e trocam o ajuste a cada música ou vídeo, em vez de configurar uma vez e esquecer.

## Product Purpose

Equalizador de 10 bandas para qualquer aba do Chrome. Dá para mudar o som do que está tocando em segundos, sem sair da página. O sucesso é abrir o popup, dar mais peso aos graves (ou trocar de preset) e voltar à música quase sem interrupção, com o som melhor e sem distorcer.

## Positioning

Funciona em qualquer site porque processa o áudio da aba inteira (`chrome.tabCapture`), sem depender do player do SoundCloud ou do YouTube. Por isso não quebra quando esses sites mudam. A curva desenhada é a resposta real dos filtros e o espectro é o som ao vivo: o que aparece na tela é o que se ouve.

## Operating Context

- Chrome no desktop, com o SoundCloud ou o YouTube tocando em outra aba ou na mesma.
- Uso em sessões longas de escuta, com o popup aberto e fechado várias vezes.
- A extensão é distribuída como pasta; quem instala não é necessariamente técnico e segue o README.

## Capabilities and Constraints

- 10 bandas em oitavas (31 Hz a 16 kHz), ±12 dB em passos de 0,5 dB, com pré-amplificação de ±12 dB.
- 12 predefinições prontas, presets pessoais salvos, "segure para ouvir o original" para comparação A/B e espectro ao vivo.
- Efeitos: velocidade de 0,5× a 2× (muda o `playbackRate` do player da página, via `scripting` + `activeTab` no mundo da página, e vale por aba), tom de −12 a +12 semitons (AudioWorklet próprio), ambiência 3D (mid/side + reverberação gerada no código), nivelar volume (compressor) e isolar voz/beat (cancelamento do centro por faixa de frequência).
- Um limitador no fim da cadeia evita distorção quando os graves sobem.
- Os ajustes são globais, mas cada site pode ter um perfil próprio ("lembrar para este site"), recarregado quando o popup abre naquele site. Tudo fica em `chrome.storage.local`.
- Atalho Ctrl+Shift+E liga e desliga na aba da frente sem abrir o popup.
- Manifest V3, Chrome 124+, HTML/CSS/JS puro sem etapa de build. Velocidade e tom são independentes entre si.
- Enquanto uma aba está equalizada, o Chrome mostra o próprio aviso de captura de áudio. A extensão não controla isso.
- Páginas internas (`chrome://`, Chrome Web Store) não podem ser equalizadas.
- O popup tem largura fixa de 380px.
- Interface só em português do Brasil hoje.
- **Em aberto:** publicar na Chrome Web Store (ainda não; a distribuição é por pasta) e uma versão em outros idiomas.

## Brand Commitments

- Nome: **Equalizador de Som** (no popup, "Equalizador").
- Voz: português do Brasil, direto e informal, com frases curtas no imperativo e sem jargão ("Ligue para ouvir o efeito nesta aba").

## Evidence on Hand

Nenhuma. Não existe página na loja, avaliações, depoimentos, número de usuários nem capturas oficiais. Trabalhos futuros não devem inventar nada disso.

## Product Principles

1. **Graves primeiro.** Mais peso e punch é o uso principal, então as bandas graves e os presets de graves merecem o caminho mais curto. Aumentar os graves nunca pode distorcer.
2. **Ajuste em segundos.** O popup é aberto muitas vezes por sessão: o estado atual aparece na hora, trocar de preset é um clique e não há diálogos de confirmação no caminho.
3. **Qualquer aba, zero configuração.** Nada de código específico por site; ligar tem que funcionar igual no SoundCloud, no YouTube e no resto.
4. **Instalável por quem não é técnico.** Instruções, estados e erros em português simples, que um amigo entenda sem ajuda.
5. **A tela diz a verdade.** Curva e espectro mostram o som real, nunca uma animação decorativa.
