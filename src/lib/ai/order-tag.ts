import type { SupabaseClient } from '@supabase/supabase-js'
import { ORDER_TAG_COLOR, ORDER_TAG_NAME } from './defaults'

/**
 * Called by the auto-reply bot after the customer confirmed an order.
 * Finds (or creates) the "New Order" tag for the account, puts it on the
 * contact, and leaves an internal note with the order summary so the
 * team can place the order quickly.
 *
 * Best-effort: owns its try/catch and never throws, so a tagging problem
 * can never disturb the reply that was already sent.
 */
export async function tagConfirmedOrder(
  db: SupabaseClient,
  args: {
    accountId: string
    contactId: string
    /** Audit user for the created tag / note (the WhatsApp config owner). */
    userId: string
    summary: string | null
  },
): Promise<void> {
  const { accountId, contactId, userId, summary } = args
  try {
    // Reuse an existing tag with the same name (case-insensitive).
    const { data: existing } = await db
      .from('tags')
      .select('id')
      .eq('account_id', accountId)
      .ilike('name', ORDER_TAG_NAME)
      .limit(1)
      .maybeSingle()

    let tagId: string | null = existing?.id ?? null
    if (!tagId) {
      const { data: created, error: createErr } = await db
        .from('tags')
        .insert({
          account_id: accountId,
          user_id: userId,
          name: ORDER_TAG_NAME,
          color: ORDER_TAG_COLOR,
        })
        .select('id')
        .single()
      if (createErr || !created) {
        console.error('[ai order-tag] could not create tag:', createErr)
        return
      }
      tagId = created.id
    }

    // Lazy import: keeps the automations engine out of this module's
    // load path (and out of the auto-reply unit tests).
    const { addContactTagAndDispatch } = await import(
      '@/lib/contacts/tag-events'
    )
    await addContactTagAndDispatch({
      db,
      accountId,
      contactId,
      tagId: tagId as string,
    })

    const noteText = summary
      ? `🤖 New order request (AI): ${summary}`
      : '🤖 New order request confirmed by the customer (AI). See the chat for details.'
    const { error: noteErr } = await db.from('contact_notes').insert({
      contact_id: contactId,
      account_id: accountId,
      user_id: userId,
      note_text: noteText,
    })
    if (noteErr) console.error('[ai order-tag] could not add note:', noteErr)
  } catch (err) {
    console.error('[ai order-tag] failed:', err)
  }
}
