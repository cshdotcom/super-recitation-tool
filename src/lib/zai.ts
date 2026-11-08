// Singleton wrapper for the z-ai-web-dev-sdk.
// MUST only be imported by server-side code (API routes / server components).
import ZAI from 'z-ai-web-dev-sdk'

type ZAIInstance = Awaited<ReturnType<typeof ZAI.create>>

let zaiInstance: ZAIInstance | null = null

export async function getZAI(): Promise<ZAIInstance> {
  if (!zaiInstance) {
    zaiInstance = await ZAI.create()
  }
  return zaiInstance
}
