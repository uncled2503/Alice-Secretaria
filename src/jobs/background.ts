// ---------------------------------------------------------------------------
// TAREFAS EM SEGUNDO PLANO (disparar e seguir): sincronizar etiquetas, espelhar no Google/Clinica Experts, buscar o nome do anuncio, atualizar a memoria do lead.
// Antes eram `void promessa` soltos: ao encerrar o processo (ou, nos testes, ao APAGAR o banco temporario) elas continuavam rodando e falhavam usando um recurso destruido
// ("table Tag does not exist"). Agora cada uma e REGISTRADA aqui e quem encerra (desligamento do servidor, fim de um arquivo de teste) espera todas terminarem antes de soltar
// o banco: drainBackground(). Nada e suprimido: a tarefa roda ate o fim, so que antes do recurso ser destruido.
// ---------------------------------------------------------------------------

const live = new Set<Promise<unknown>>();

export function trackBackground<T>(task: Promise<T>): Promise<T> {
  live.add(task);
  const done = () => { live.delete(task); };
  task.then(done, done); // (o erro continua com quem chamou; aqui so se tira da lista)
  return task;
}

export function backgroundCount(): number {
  return live.size;
}

// Espera as tarefas em andamento (inclusive as que elas mesmas disparam) terminarem. Devolve quantas ainda restavam se o prazo acabou.
export async function drainBackground(timeoutMs = 20_000): Promise<{ pending: number }> {
  const end = Date.now() + timeoutMs;
  while (live.size > 0 && Date.now() < end) {
    await Promise.race([Promise.allSettled([...live]), new Promise((r) => setTimeout(r, 100))]);
  }
  return { pending: live.size };
}
