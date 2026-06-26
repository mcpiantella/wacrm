import { describe, it, expect } from 'vitest'
import { channelCapabilities } from './capabilities'

describe('channelCapabilities', () => {
  it('Cloud supports templates and freeform', () => {
    expect(channelCapabilities('cloud')).toEqual({ templates: true, freeform: true })
  })

  it('Evolution supports freeform only (no Meta templates)', () => {
    expect(channelCapabilities('evolution')).toEqual({
      templates: false,
      freeform: true,
    })
  })
})
