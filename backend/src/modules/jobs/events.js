/**
 * job_events writer — lifecycle events without a table of their own, for the
 * job history timeline. Always pass the transaction client of the domain write.
 *
 * (Creation of quotations / orders comes from their own rows.)
 * Types: quotation.sent, quotation.accepted, quotation.declined,
 * quotation.revised, quotation.expired, quotation.resent, proof.sent, proof.approved,
 * proof.revision_requested, po.recorded, ticket.resolved.
 */
export async function recordJobEvent(client, { quotationId = null, orderId = null, type, actorId = null, data = {} }) {
  if (!quotationId && !orderId) return null;
  const { rows } = await client.query(
    `INSERT INTO job_events (quotation_id, order_id, type, actor_id, data)
     VALUES ($1, $2, $3, $4, $5::jsonb) RETURNING id`,
    [quotationId, orderId, type, actorId, JSON.stringify(data ?? {})]
  );
  return rows[0]?.id ?? null;
}
