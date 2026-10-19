-- Contexto minimo da geracao da resposta (19/10/2026). A entrega valida o texto que vai sair (inclusive o reescrito pela revisao por IA) com o que as ferramentas
-- fizeram e devolveram NA GERACAO. Esse contexto ficava so em memoria e sumia no reinicio ou depois de 15 min. Agora um resumo compacto (so flags, horarios devolvidos
-- pela agenda e o que foi feito na rodada; NUNCA o texto das conversas) acompanha a mensagem ainda nao entregue e e apagado quando ela chega a um estado final.
-- Coluna anulavel: o codigo anterior ignora.

ALTER TABLE "Message" ADD COLUMN "replyContext" TEXT;
