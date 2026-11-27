import type { ProfileSession } from '../repositories/sqlite/sessions'
import { findProcesses, processUsesDirectory, samePath } from './process'
import type { ProcessIdentity } from './process'

/** O PID sozinho não prova que o processo ainda pertence à sessão. */
export async function recoverIdentity(session: ProfileSession): Promise<ProcessIdentity | null> {
  const owners = await findProcesses(session.userDataDir)
  const match = owners.find(
    (owner) =>
      samePath(owner.executablePath, session.executablePath) &&
      processUsesDirectory(owner, session.userDataDir) &&
      (session.pid === null || owner.pid === session.pid) &&
      (session.processStartedAt === null || owner.startedAt === session.processStartedAt),
  )
  return match ?? null
}
