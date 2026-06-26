import { describe, it, expect } from 'vitest'
import { parseEvolutionInbound } from './evolution-parse'

function upsert(overrides: Record<string, unknown> = {}) {
  return {
    event: 'messages.upsert',
    instance: 'imobquest',
    data: {
      key: {
        remoteJid: '5511999999999@s.whatsapp.net',
        fromMe: false,
        id: 'BAE5ABC',
      },
      pushName: 'João',
      message: { conversation: 'olá' },
      messageType: 'conversation',
      messageTimestamp: 1719360000,
    },
    ...overrides,
  }
}

describe('parseEvolutionInbound', () => {
  it('parses a conversation text message', () => {
    const r = parseEvolutionInbound(upsert())
    expect(r).toEqual({
      instance: 'imobquest',
      senderPhone: '5511999999999',
      senderName: 'João',
      providerMessageId: 'BAE5ABC',
      text: 'olá',
      timestamp: new Date(1719360000 * 1000),
    })
  })

  it('reads extendedTextMessage text', () => {
    const body = upsert({
      data: {
        key: { remoteJid: '551188@s.whatsapp.net', fromMe: false, id: 'X' },
        message: { extendedTextMessage: { text: 'oi de novo' } },
        messageTimestamp: '1719360000',
      },
    })
    expect(parseEvolutionInbound(body)?.text).toBe('oi de novo')
  })

  it('accepts data as an array (takes the first entry)', () => {
    const body = upsert({ data: [ (upsert().data) ] })
    expect(parseEvolutionInbound(body)?.providerMessageId).toBe('BAE5ABC')
  })

  it('falls back to the phone when pushName is missing', () => {
    const body = upsert({
      data: { key: { remoteJid: '5511777@s.whatsapp.net', fromMe: false, id: 'Y' }, message: { conversation: 'hi' } },
    })
    expect(parseEvolutionInbound(body)?.senderName).toBe('5511777')
  })

  it('ignores our own outbound echo (fromMe=true)', () => {
    const body = upsert({
      data: { key: { remoteJid: '5511@s.whatsapp.net', fromMe: true, id: 'Z' }, message: { conversation: 'echo' } },
    })
    expect(parseEvolutionInbound(body)).toBeNull()
  })

  it('ignores group messages (@g.us)', () => {
    const body = upsert({
      data: { key: { remoteJid: '12036304@g.us', fromMe: false, id: 'G' }, message: { conversation: 'grp' } },
    })
    expect(parseEvolutionInbound(body)).toBeNull()
  })

  it('ignores non-text messages (no follow-up media support yet)', () => {
    const body = upsert({
      data: { key: { remoteJid: '5511@s.whatsapp.net', fromMe: false, id: 'M' }, message: { imageMessage: { url: 'x' } } },
    })
    expect(parseEvolutionInbound(body)).toBeNull()
  })

  it('ignores non-upsert events', () => {
    expect(parseEvolutionInbound(upsert({ event: 'connection.update' }))).toBeNull()
  })

  it('returns null for a body with no instance', () => {
    expect(parseEvolutionInbound(upsert({ instance: undefined }))).toBeNull()
  })
})
