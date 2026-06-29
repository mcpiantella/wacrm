import { chatCompleteJson } from './chat'

/**
 * AI generation of a WhatsApp message-template draft from a plain-language
 * briefing. Produces the fields the template editor needs (name, category,
 * body). The user reviews/edits and then submits it for Meta approval — this
 * is a starting point, not an auto-submit.
 */

export type TemplateCategory = 'Marketing' | 'Utility'

export interface GeneratedTemplate {
  /** snake_case, [a-z0-9_], Meta's template-name rule. */
  name: string
  category: TemplateCategory
  /** Body text; may include `{{1}}` as the contact-name placeholder. */
  body_text: string
}

const GEN_SYSTEM = `Você cria rascunhos de template de mensagem do WhatsApp Business a partir de um briefing curto.

Devolva SOMENTE um objeto JSON, sem texto fora dele, com estas chaves:
{"name": "<nome em snake_case, só letras minúsculas/números/underscore>", "category": "Marketing" | "Utility", "body_text": "<o texto da mensagem>"}

Regras:
- "body_text": mensagem clara e cordial em português do Brasil. Pode usar {{1}} UMA vez para o nome do contato (ex.: "Olá {{1}}, ..."). Não use outros placeholders. Máx ~600 caracteres. Sem markdown.
- "category": "Marketing" para promoções/novidades; "Utility" para avisos transacionais (pedido, agendamento, lembrete).
- "name": resuma o tema em snake_case (ex.: "promo_imoveis_zona_sul").`

interface RawGen {
  name?: unknown
  category?: unknown
  body_text?: unknown
}

function toSnakeName(v: unknown): string {
  const s = typeof v === 'string' ? v : ''
  const cleaned = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining accents
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60)
  return cleaned || 'template_ia'
}

export async function generateTemplate(briefing: string): Promise<GeneratedTemplate> {
  const raw = await chatCompleteJson<RawGen>({
    system: GEN_SYSTEM,
    messages: [{ role: 'user', content: briefing.trim() }],
    model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
    json: true,
    maxTokens: 500,
  })

  return {
    name: toSnakeName(raw.name),
    category: raw.category === 'Utility' ? 'Utility' : 'Marketing',
    body_text: typeof raw.body_text === 'string' ? raw.body_text.trim().slice(0, 1024) : '',
  }
}
