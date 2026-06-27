import { chatCompleteJson } from './chat'

/**
 * AI generation of an SDR configuration from a plain-language briefing.
 *
 * The user describes their campaign ("imobiliária em SP, quero qualificar
 * quem busca alugar/comprar…") and the model drafts the three fields the
 * SDR needs: the system prompt (persona + objective), the qualification
 * criteria, and the handoff keywords. The user reviews and edits before
 * saving — this is a starting point, not a black box.
 *
 * Runs in the web app (an API route), so it uses the same OpenAI→Anthropic
 * `chat` layer as the worker.
 */

export interface GeneratedSdrConfig {
  system_prompt: string
  qualification_criteria: string[]
  handoff_keywords: string[]
}

const GEN_SYSTEM = `Você é um especialista em pré-vendas (SDR) por WhatsApp. A partir de um briefing curto de uma campanha, você redige a configuração de um agente de IA que vai qualificar leads que respondem à campanha.

Devolva um único objeto JSON, sem texto fora dele, exatamente com estas chaves:
{
  "system_prompt": "<instruções para o agente: quem ele é, o tom (cordial, objetivo, em português do Brasil), o objetivo de qualificação, e a regra de fazer UMA pergunta por vez e nunca inventar informação>",
  "qualification_criteria": ["<critério 1>", "<critério 2>", "..."],
  "handoff_keywords": ["<palavra/frase que indica que o lead quer um humano>", "..."]
}

Regras:
- "system_prompt": um parágrafo prático e direto, na 2ª pessoa ("Você é..."), pronto para uso. Inclua o objetivo de descobrir os critérios de qualificação conversando naturalmente.
- "qualification_criteria": 3 a 6 itens curtos, cada um uma informação a descobrir sobre o lead (ex.: "Orçamento disponível", "Prazo de decisão", "É o decisor").
- "handoff_keywords": 3 a 6 gatilhos de transferência para humano (ex.: "falar com atendente", "falar com humano", "reclamação").
- Escreva tudo em português do Brasil. Seja específico ao contexto do briefing.`

interface RawGen {
  system_prompt?: unknown
  qualification_criteria?: unknown
  handoff_keywords?: unknown
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v
    .filter((x): x is string => typeof x === 'string')
    .map((s) => s.trim())
    .filter(Boolean)
}

export async function generateSdrConfig(
  briefing: string,
): Promise<GeneratedSdrConfig> {
  const raw = await chatCompleteJson<RawGen>({
    system: GEN_SYSTEM,
    messages: [{ role: 'user', content: briefing.trim() }],
    json: true,
    maxTokens: 1500,
  })

  return {
    system_prompt:
      typeof raw.system_prompt === 'string' ? raw.system_prompt.trim() : '',
    qualification_criteria: toStringArray(raw.qualification_criteria),
    handoff_keywords: toStringArray(raw.handoff_keywords),
  }
}
