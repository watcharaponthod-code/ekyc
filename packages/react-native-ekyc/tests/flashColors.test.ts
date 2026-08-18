import { FLASH_DISPLAY, flashHex } from '../src/ui/flashColors'

describe('flashHex', () => {
  it('maps every server palette name to a bright display colour', () => {
    expect(flashHex('red')).toBe('#FF2626')
    expect(flashHex('green')).toBe('#26FF26')
    expect(flashHex('blue')).toBe('#2626FF')
    expect(flashHex('white')).toBe('#FFFFFF')
  })

  it('falls back to white for an unknown name rather than crashing', () => {
    expect(flashHex('chartreuse')).toBe('#FFFFFF')
  })

  it('covers exactly the four server palette names', () => {
    expect(Object.keys(FLASH_DISPLAY).sort()).toEqual(['blue', 'green', 'red', 'white'])
  })
})
