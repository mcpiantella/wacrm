import { describe, it, expect, vi, afterEach } from 'vitest'
import { sendEvolutionText } from './evolution-api'

function mockFetchOnce(status: number, body: unknown) {
  const fn = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }))
  vi.stubGlobal('fetch', fn)
  return fn
}

afterEach(() => vi.unstubAllGlobals())

describe('sendEvolutionText', () => {
  it('POSTs to /message/sendText/{instance} with apikey header and returns key.id', async () => {
    const fetchMock = mockFetchOnce(200, { key: { id: 'BAE5XYZ' } })

    const result = await sendEvolutionText({
      baseUrl: 'https://evo.example.com',
      apiKey: 'secret-key',
      instance: 'imobquest',
      to: '5511999999999',
      text: 'olá',
    })

    expect(result).toEqual({ messageId: 'BAE5XYZ' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      { method: string; headers: Record<string, string>; body: string },
    ]
    expect(url).toBe('https://evo.example.com/message/sendText/imobquest')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe('secret-key')
    expect(JSON.parse(init.body)).toEqual({ number: '5511999999999', text: 'olá' })
  })

  it('strips a trailing slash from baseUrl', async () => {
    const fetchMock = mockFetchOnce(201, { key: { id: 'X' } })
    await sendEvolutionText({
      baseUrl: 'https://evo.example.com/',
      apiKey: 'k',
      instance: 'inst',
      to: '1',
      text: 't',
    })
    const [calledUrl] = fetchMock.mock.calls[0] as unknown as [string]
    expect(calledUrl).toBe('https://evo.example.com/message/sendText/inst')
  })

  it('throws with the Evolution error message on non-2xx', async () => {
    mockFetchOnce(400, { response: { message: 'Connection Closed' } })
    await expect(
      sendEvolutionText({
        baseUrl: 'https://evo.example.com',
        apiKey: 'k',
        instance: 'inst',
        to: '1',
        text: 't',
      }),
    ).rejects.toThrow('Connection Closed')
  })

  it('throws when the response is missing key.id', async () => {
    mockFetchOnce(200, { status: 'PENDING' })
    await expect(
      sendEvolutionText({
        baseUrl: 'https://evo.example.com',
        apiKey: 'k',
        instance: 'inst',
        to: '1',
        text: 't',
      }),
    ).rejects.toThrow(/missing key.id/)
  })
})
