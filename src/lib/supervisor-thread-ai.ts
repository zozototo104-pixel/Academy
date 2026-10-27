import { platformAgentComplete } from '@/lib/platform-agent'

// Seam for the instant AI reply inside the supervision thread. This reuses the
// established AI-supervisor reply path (platform agent, whose context assembly
// already includes supervision-scope channel history), so the in-thread reply
// builds on human messages exactly like the existing AI chat does. It is kept
// as its own module so tests can mock this seam without touching /api/chat.
// The existing AI chat (AIChatView + /api/chat) is untouched by this feature.
export async function generateSupervisorThreadReply(opts: { userId: string; content: string }): Promise<string> {
  const result = await platformAgentComplete({
    userId: opts.userId,
    messages: [{ role: 'user', content: opts.content }],
    mode: 'TEXT',
  })
  return result.reply
}
