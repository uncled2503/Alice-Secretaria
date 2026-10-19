import { prisma } from "../db/client.js";
import { logActivity } from "../crm/activity.js";
import { wallClockInZone } from "../scheduling/time.js";

// ---------------------------------------------------------------------------
// JORNADAS DAS PROFISSIONAIS DA LISBOA (informadas pela clinica em 16/10/2026): Suelen 12h-21h, Adriana 12h-21h, Talita 8h-17h.
// Mecanismo IDEMPOTENTE e restrito a UMA clinica (a Lisboa, escolhida por quem chama), com PREVIA (dryRun) e sem adivinhar identidade:
//   - so altera a profissional quando existe EXATAMENTE UMA ativa com aquele primeiro nome nesta clinica (ou quando quem opera informa o id
//     escolhido, e o id pertence a esta clinica e tem aquele primeiro nome); duplicata/ambiguidade vira PENDENCIA com os dados pra resolver;
//   - so toca o inicio/fim da jornada (hora e minuto). Dias trabalhados, almoco, ferias, bloqueios e agendamentos ficam como estao;
//   - o que ficar incompativel com a nova jornada (almoco colado no inicio/fim, agendamento futuro fora do novo horario) e SINALIZADO, nao corrigido;
//   - as importacoes do Clinica Experts nao escrevem jornada (so criam/vinculam profissional), entao nada restaura o valor antigo depois.
// Esta previa/aplicacao so mexe no banco quando chamada por um admin; nada roda sozinho.
// ---------------------------------------------------------------------------

export interface JornadaAlvo { primeiroNome: string; inicio: [number, number]; fim: [number, number] }
export const LISBOA_JORNADAS: JornadaAlvo[] = [
  { primeiroNome: "suelen", inicio: [12, 0], fim: [21, 0] },
  { primeiroNome: "adriana", inicio: [12, 0], fim: [21, 0] },
  { primeiroNome: "talita", inicio: [8, 0], fim: [17, 0] },
];

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
// Primeiro nome sem tratamento ("Dra. Suelen Souza" -> "suelen").
const firstNameOf = (name: string) => fold(name).replace(/^(dra|dr|doutora|doutor)\s+/, "").split(" ")[0] ?? "";
const hhmm = (h: number, m = 0) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
const minutesLabel = (min: number) => hhmm(Math.floor(min / 60), min % 60);

export interface JornadaCandidata {
  id: string;
  nome: string;
  ativa: boolean;
  vinculadaAoCE: boolean;
  jornadaAtual: string; // "08:00-18:00" ou "herda da clinica"
  agendamentosFuturos: number;
}

export interface JornadaItem {
  alvo: string; // "Suelen"
  jornadaNova: string; // "12:00-21:00"
  status: "atualizar" | "sem_mudanca" | "pendente";
  pendencia?: string;
  profissionalId?: string;
  profissional?: string;
  antes?: string;
  candidatas: JornadaCandidata[];
  conflitos: string[]; // o que ficou incompativel com a nova jornada (nao e corrigido aqui)
  aplicada?: boolean;
}

export interface JornadasResult {
  clinicId: string;
  clinica: string;
  dryRun: boolean;
  itens: JornadaItem[];
  atualizadas: number;
  pendentes: number;
}

export interface JornadasOptions {
  dryRun: boolean;
  // Resolve ambiguidade explicitamente: { suelen: "<id da profissional>" }. O id precisa ser desta clinica e ter aquele primeiro nome.
  escolhas?: Record<string, string>;
  actorName?: string | null;
}

export async function ajustarJornadasLisboa(clinicId: string, opts: JornadasOptions): Promise<JornadasResult> {
  const clinic = await prisma.clinic.findUniqueOrThrow({ where: { id: clinicId } });
  const tz = clinic.timezone || "America/Sao_Paulo";
  const pros = await prisma.professional.findMany({
    where: { clinicId },
    include: { appointments: { where: { status: "confirmed", scheduledAt: { gte: new Date() } }, select: { scheduledAt: true, procedure: { select: { durationMin: true } } } } },
    orderBy: { createdAt: "asc" },
  });

  const jornadaTexto = (p: (typeof pros)[number]) =>
    p.workStartHour != null && p.workEndHour != null ? `${hhmm(p.workStartHour, p.workStartMinute)}-${hhmm(p.workEndHour, p.workEndMinute)}` : "herda da clínica";

  const itens: JornadaItem[] = [];
  for (const alvo of LISBOA_JORNADAS) {
    const nome = alvo.primeiroNome[0].toUpperCase() + alvo.primeiroNome.slice(1);
    const jornadaNova = `${hhmm(...alvo.inicio)}-${hhmm(...alvo.fim)}`;
    const matches = pros.filter((p) => firstNameOf(p.name) === alvo.primeiroNome);
    const candidatas: JornadaCandidata[] = matches.map((p) => ({
      id: p.id, nome: p.name, ativa: p.active, vinculadaAoCE: !!p.ceUuid, jornadaAtual: jornadaTexto(p), agendamentosFuturos: p.appointments.length,
    }));
    const item: JornadaItem = { alvo: nome, jornadaNova, status: "pendente", candidatas, conflitos: [] };

    // 1) quem e a profissional? Nunca adivinha entre duas.
    let chosen: (typeof pros)[number] | undefined;
    const escolha = opts.escolhas?.[alvo.primeiroNome];
    if (escolha) {
      chosen = matches.find((p) => p.id === escolha);
      if (!chosen) item.pendencia = `O id informado para ${nome} não é uma profissional desta clínica com esse primeiro nome.`;
    } else {
      const ativas = matches.filter((p) => p.active);
      if (matches.length === 0) item.pendencia = `Nenhuma profissional chamada ${nome} nesta clínica. Confira o cadastro (ou sincronize o catálogo do Clínica Experts) e rode de novo.`;
      else if (ativas.length === 0) item.pendencia = `Só há cadastro INATIVO para ${nome}. Reative a profissional certa antes de ajustar a jornada.`;
      else if (ativas.length > 1) item.pendencia = `Mais de uma profissional ATIVA chamada ${nome} (${ativas.map((p) => `${p.name} [${p.id}]${p.ceUuid ? " ligada ao CE" : ""}`).join("; ")}). Informe o id da correta em "escolhas" (ex.: {"${alvo.primeiroNome}": "<id>"}) ou desative a duplicada.`;
      else chosen = ativas[0];
    }
    if (!chosen) { itens.push(item); continue; }

    item.profissionalId = chosen.id;
    item.profissional = chosen.name;
    item.antes = jornadaTexto(chosen);
    item.pendencia = undefined;

    // 2) o que fica incompativel com a nova jornada (so sinaliza)
    const novoIni = alvo.inicio[0] * 60 + alvo.inicio[1];
    const novoFim = alvo.fim[0] * 60 + alvo.fim[1];
    const almIni = chosen.lunchStartHour != null ? chosen.lunchStartHour * 60 + chosen.lunchStartMinute : clinic.lunchStartHour != null ? clinic.lunchStartHour * 60 + clinic.lunchStartMinute : null;
    const almFim = chosen.lunchEndHour != null ? chosen.lunchEndHour * 60 + chosen.lunchEndMinute : clinic.lunchEndHour != null ? clinic.lunchEndHour * 60 + clinic.lunchEndMinute : null;
    if (almIni != null && almFim != null) {
      const origem = chosen.lunchStartHour != null ? "da profissional" : "herdado da clínica";
      if (almIni <= novoIni && almFim > novoIni) item.conflitos.push(`Intervalo ${origem} ${minutesLabel(almIni)}-${minutesLabel(almFim)} cobre o INÍCIO da nova jornada (${minutesLabel(novoIni)}): a profissional só poderia começar às ${minutesLabel(almFim)}. Confirme se esse intervalo vale pra ela.`);
      if (almFim >= novoFim && almIni < novoFim) item.conflitos.push(`Intervalo ${origem} ${minutesLabel(almIni)}-${minutesLabel(almFim)} cobre o FIM da nova jornada (${minutesLabel(novoFim)}).`);
    }
    const dias = chosen.workDays ? `dias ${chosen.workDays}` : "dias herdados da clínica";
    const fora = chosen.appointments.filter((a) => {
      const wc = wallClockInZone(a.scheduledAt, tz);
      const ini = wc.hour * 60 + wc.minute;
      return ini < novoIni || ini + a.procedure.durationMin > novoFim;
    });
    if (fora.length) {
      const exemplos = fora.slice(0, 5).map((a) => { const wc = wallClockInZone(a.scheduledAt, tz); return `${String(wc.day).padStart(2, "0")}/${String(wc.month).padStart(2, "0")} ${hhmm(wc.hour, wc.minute)}`; });
      item.conflitos.push(`${fora.length} agendamento(s) futuro(s) dela ficam FORA da nova jornada (ex.: ${exemplos.join(", ")}). Eles não são alterados; a recepção decide.`);
    }
    item.conflitos.push(`Não alterado: ${dias}${chosen.lunchStartHour != null ? " e intervalo próprio" : ""}.`);

    // 3) idempotente: ja esta igual?
    const igual = chosen.workStartHour === alvo.inicio[0] && chosen.workStartMinute === alvo.inicio[1] && chosen.workEndHour === alvo.fim[0] && chosen.workEndMinute === alvo.fim[1];
    item.status = igual ? "sem_mudanca" : "atualizar";
    itens.push(item);
  }

  let atualizadas = 0;
  if (!opts.dryRun) {
    for (const it of itens) {
      if (it.status !== "atualizar" || !it.profissionalId) continue;
      const alvo = LISBOA_JORNADAS.find((a) => a.primeiroNome === it.alvo.toLowerCase())!;
      // updateMany com a clinica na condicao: nunca altera profissional de outra clinica, mesmo com id errado.
      const r = await prisma.professional.updateMany({
        where: { id: it.profissionalId, clinicId },
        data: { workStartHour: alvo.inicio[0], workStartMinute: alvo.inicio[1], workEndHour: alvo.fim[0], workEndMinute: alvo.fim[1] },
      });
      it.aplicada = r.count === 1;
      if (r.count === 1) {
        atualizadas++;
        await logActivity({
          clinicId, type: "professional_hours_updated", area: "equipe",
          title: `Jornada de ${it.profissional} atualizada`,
          description: `${it.antes} → ${it.jornadaNova}. Dias trabalhados, intervalo e agendamentos não foram alterados.${it.conflitos.length > 1 ? ` Atenção: ${it.conflitos.filter((c) => !c.startsWith("Não alterado")).join(" ")}` : ""}`,
          actorName: opts.actorName ?? null,
        });
      }
    }
  }
  return { clinicId, clinica: clinic.name, dryRun: opts.dryRun, itens, atualizadas, pendentes: itens.filter((i) => i.status === "pendente").length };
}
