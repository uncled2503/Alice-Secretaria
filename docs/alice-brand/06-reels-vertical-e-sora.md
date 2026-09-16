# Alice | Corte vertical nativo para Reels + guia do Sora

Complemento a `04-roteiro-motion.md` e `05-producao-chatgpt-claude.md`. Escrito em 16/09/2026, depois de o dono confirmar que o destino é Instagram/Reels (9:16) e que quer usar Sora (geração de vídeo por IA) e Claude juntos. Não substitui os arquivos 01–05: usa a mesma marca, os mesmos limites de honestidade e o mesmo CTA.

## 1. Por que um roteiro à parte, e não só "cortar" o de 60s

O roteiro de `04-roteiro-motion.md` foi desenhado como master 16:9 com uma recomposição 9:16 (ver §6 daquele arquivo). Isso funciona bem para o filme principal, mas Reels tem comportamento de consumo diferente: a pessoa decide em ~1-2s se continua olhando, o som costuma estar desligado, e composições pensadas para tela larga primeiro (assunto no centro, respiro nas laterais) ficam com elementos pequenos demais quando só recompostas. Este roteiro é **vertical desde o quadro zero** — pensa em blocos empilhados, não em recorte.

Isto é uma peça adicional, mais curta e mais direta, para a estreia no Reels. O filme de 60s (com cortes de 30 e 15) continua valendo para site, apresentação comercial e outros formatos.

## 2. Roteiro vertical de 22 segundos

Estrutura: gancho (0–3s) → dor nomeada (3–8s) → Alice resolvendo (8–17s) → convite (17–22s). Cada cena é UM bloco de tela cheia, sem dividir a atenção em colunas.

| Cena | Tempo | Texto em tela (grande, centralizado) | Locução (opcional — o corte funciona mudo) | Visual |
|---|---|---|---|---|
| 1 · Gancho | 0–3s | "Quantos desses você não respondeu hoje?" | (silêncio, ou a mesma frase sussurrada) | Tela cheia com 3 balões de mensagem chegando em sequência rápida (0.3s de intervalo), sobrepostos, como notificação empilhando. Fictícios: "Quanto custa a consulta?", "Tem horário quinta?", "Oi, ainda dá pra marcar?" |
| 2 · Dor | 3–8s | "Todo lead sem resposta rápida é um lead que esfria." | "Cada mensagem que demora é uma chance que esfria." | Um dos balões (o do meio) fica cinza/opaco e desce para o rodapé, como "perdido". Linha âmbar tenta alcançá-lo e não chega — corta antes de resolver. |
| 3 · Virada | 8–10s | "Conheça a Alice." | "A Alice responde por você." | Personagem (asset real) surge centralizado, fundo creme, sem movimento brusco. |
| 4 · Resolvendo | 10–17s | (texto de interface, não título) | "Ela entende o que a pessoa precisa, confere sua agenda de verdade e já confirma." | Sequência rápida, um elemento por vez, tela cheia: (a) balão da Alice respondendo a dúvida fictícia, (b) dia da semana sendo oferecido ("Consigo quinta ou sexta"), (c) card de agendamento fechando com um selo de check. Ritmo de corte seco (0.6–0.8s por elemento), sem pausa — é a cena que prova o produto. |
| 5 · Consequência | 17–19s | "Nenhuma conversa fica esperando." | (silêncio) | O balão "perdido" da cena 2 reaparece, agora colorido e com o selo de "respondido" — fecha o arco visual aberto no gancho. |
| 6 · Convite | 19–22s | "Alice. Agende uma demonstração." | "Alice. Agende uma demonstração." | Logo + assinatura + CTA estático nos últimos 2s inteiros, sem nenhum elemento se movendo por cima do texto. |

Regra de ouro do corte vertical: **um assunto por tela**. Nunca reaproveitar um frame do 16:9 com faixas pretas ou conteúdo espremido nas laterais — isso é o erro mais comum e mais visível de quem só exporta o mesmo projeto em outra proporção.

### Variante ainda mais curta (Stories / anúncio, 12–15s)

Para teste de anúncio ou Stories, cortar direto da cena 1 pra cena 4 pra cena 6: gancho (0–3s) → Alice resolvendo (3–11s, só o card de agendamento fechando) → convite (11–15s). Sacrifica o arco narrativo da cena 2/5 em troca de velocidade — testar as duas versões antes de escalar mídia paga.

## 3. Parâmetros específicos de Reels

- Formato: 1080×1920, 9:16, 30fps (60fps se a plataforma de destino comprimir menos nessa taxa — testar antes de decidir).
- Zona seura de UI do Instagram: deixe **250px livres no topo** (ícones e nome de usuário) e **320px livres embaixo** (legenda, botões de ação, música). Nada de texto essencial nessas faixas.
- Legenda embutida sempre, mesmo com locução: maioria assiste sem som.
- Primeiro frame não pode ser uma tela vazia ou um logo estático — tem que já mostrar o gancho (Instagram usa o primeiro frame como thumbnail no feed).
- Duração-alvo: 15–25s tem a melhor taxa de conclusão para conteúdo institucional/B2B; acima de 30s, a queda de retenção costuma ser acentuada nesse tipo de peça.

## 4. Onde o Sora entra (e onde não deve entrar)

Aviso de precisão: minha informação sobre o Sora tem um corte de conhecimento e o produto muda rápido — confirme na conta de vocês a interface, os limites de duração por geração e o plano de acesso atual antes de produzir. O que é estável e vale para qualquer versão do Sora:

**O que o Sora faz bem:** clipes curtos, fotorrealistas ou estilizados, de cenas genéricas e ambientes — mãos digitando num celular, movimento de uma recepção de clínica, luz ambiente quente, uma pessoa checando o WhatsApp com expressão de cansaço. É o tipo de "atmosfera" que dá textura ao filme sem precisar filmar.

**O que o Sora NÃO deve gerar neste projeto:**
- **O personagem da Alice.** É um asset de marca (`public/assets/logo-personagem.webp`). Gerar uma versão "parecida" por IA quebra a identidade visual e pode sair inconsistente entre clipes — mesma regra que já está em `04-roteiro-motion.md` §2 e `05-producao-chatgpt-claude.md` §4 para qualquer ferramenta de IA generativa.
- **A interface do produto** (balões de mensagem, agenda, cards). Geração de vídeo por IA ainda erra texto legível, alinhamento e consistência entre quadros — exatamente os três elementos que carregam a promessa do produto. É por isso que `05-producao-chatgpt-claude.md` recomenda Remotion (código) para essa parte, não geração de vídeo.
- **Qualquer métrica, depoimento ou tela de "resultado".** Mesma regra de honestidade do resto do pacote (`01-posicionamento-e-comunicacao.md` §12): nada de número ou prova social que o produto não comprova.

### Fluxo híbrido recomendado

1. **Sora** gera só os 2-3 planos de atmosfera do roteiro acima (cena 1 de fundo, textura da cena 2, eventualmente um plano de abertura antes do gancho se quiser um "estabelecimento" de cena). Peça clipes de 3-5s cada, mudos — a trilha/locução entra depois.
2. **Claude Code** (com o projeto Remotion de `05-producao-chatgpt-claude.md` §5) recebe os clipes do Sora como camada de fundo e desenha por cima, em código, tudo que precisa ser fiel: balões de mensagem, texto, logo, CTA. Isso resolve exatamente a fraqueza do vídeo gerado por IA (texto/UI) usando a força dele (atmosfera).
3. Exportar como um vídeo só, com o Remotion compondo as duas camadas.

### Prompts prontos para o Sora (atmosfera, não produto)

Use como ponto de partida; ajuste a redação para a interface real do Sora no momento em que for gerar.

```text
Plano 1 — abertura/gancho:
Close-up de uma mão segurando um celular, tela iluminada com notificações
chegando uma atrás da outra. Ambiente de recepção de clínica ao fundo,
fora de foco, luz quente. Sem texto legível na tela do celular. Sem marcas
ou logotipos visíveis. 4 segundos, sem áudio, tom realista e levemente
corrido — transmite acúmulo, não pânico.
```

```text
Plano 2 — textura da dor:
Uma pessoa em uma recepção de clínica de estética, de costas ou fora de
foco no primeiro plano, checando o celular com expressão levemente
cansada. Luz natural quente, paleta laranja e creme. Sem rostos
identificáveis em destaque, sem texto na tela, sem logotipos. 3-4
segundos, câmera parada ou com leve movimento lateral.
```

```text
Plano 3 (opcional) — transição para a marca:
Plano aberto e calmo de uma mesa de recepção organizada, luz quente da
tarde entrando pela janela, sem pessoas. 3 segundos, câmera parada.
Deve funcionar como fundo neutro atrás de um logotipo sobreposto depois.
```

Depois de gerar, baixe os clipes e leve-os para o projeto Remotion (ou para o editor que estiver usando) como camada de fundo — nunca como o vídeo final por si só.

## 5. Checklist antes de publicar este corte

Além dos 7 itens de `04-roteiro-motion.md` §8:

1. O primeiro frame já comunica o gancho (não é logo nem tela vazia)?
2. Testado mudo, com legenda, do início ao fim?
3. Nenhum texto essencial cai nas zonas de UI do Instagram (topo/rodapé)?
4. Os clipes do Sora (se usados) aparecem só como fundo/atmosfera — nenhum deles mostra a interface do produto, o personagem ou qualquer número?
5. Duração final entre 15–25s (ou a variante de 12–15s testada à parte)?
