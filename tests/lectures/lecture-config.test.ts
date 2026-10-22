import { describe, expect, test } from 'bun:test'
import { isLecturesEnabled, isLecturesEnabledForProgram, parseLecturePilotProgramIds } from '../../src/lib/lectures/config'

describe('lectures configuration', () => {
  test('disabled by default', () => {
    expect(isLecturesEnabled({})).toBe(false)
    expect(isLecturesEnabledForProgram('program-1', {})).toBe(false)
    expect(isLecturesEnabled({ LECTURES_ENABLED: '1' })).toBe(false)
  })

  test('enabled explicitly and unrestricted when pilot list is empty', () => {
    const env = { LECTURES_ENABLED: 'true', LECTURES_PILOT_PROGRAM_IDS: '' }
    expect(isLecturesEnabledForProgram('program-1', env)).toBe(true)
    expect(isLecturesEnabledForProgram('program-2', env)).toBe(true)
    expect(isLecturesEnabledForProgram('', env)).toBe(false)
  })

  test('restricts to selected pilot programs', () => {
    const env = { LECTURES_ENABLED: 'true', LECTURES_PILOT_PROGRAM_IDS: ' program-1, program-2,program-1 ' }
    expect(parseLecturePilotProgramIds(env.LECTURES_PILOT_PROGRAM_IDS)).toEqual(['program-1', 'program-2'])
    expect(isLecturesEnabledForProgram('program-1', env)).toBe(true)
    expect(isLecturesEnabledForProgram('program-3', env)).toBe(false)
  })
})
