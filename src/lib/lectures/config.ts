// Lectures remain disabled until explicitly enabled by an administrator.
// An empty pilot list means all programs once the feature is enabled.
export function parseLecturePilotProgramIds(raw: string | undefined): string[] {
  return [...new Set((raw ?? '').split(',').map((id) => id.trim()).filter(Boolean))]
}

export function isLecturesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.LECTURES_ENABLED === 'true'
}

export function isLecturesEnabledForProgram(
  programId: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (!programId || !isLecturesEnabled(env)) return false
  const pilotIds = parseLecturePilotProgramIds(env.LECTURES_PILOT_PROGRAM_IDS)
  return pilotIds.length === 0 || pilotIds.includes(programId)
}
