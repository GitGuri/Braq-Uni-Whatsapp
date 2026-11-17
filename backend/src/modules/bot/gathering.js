/**
 * The one AI gathering loop shared by the quotation and the direct-order flows:
 * collect the client's messages, let the AI ask for everything still missing
 * (one numbered message, at most MAX_FOLLOWUPS times), then hand the
 * consolidated request to the flow's finalise step. The AI call runs before the
 * turn commits (never inside a transaction).
 */
import { gatherQuotationInfo } from '../../integrations/ai.client.js';
import { listProducts } from '../catalog/service.js';

export const MAX_FOLLOWUPS = 2;

const clientText = (history) => history.filter((h) => h.role === 'client').map((h) => h.text).join('\n');

/**
 * @param {object} c          handler context (reply.js handlerContext)
 * @param {{ state: string, historyKey: string, followupsKey: string,
 *           finalise: (c: object, consolidatedText: string) => Promise<unknown>,
 *           text?: string, fresh?: boolean }} flow
 *   text: the client's request when it is not this message (e.g. carried over
 *   from before registration); fresh: start a new history.
 */
export async function gather(c, { state, historyKey, followupsKey, finalise, text = null, fresh = false }) {
  const history = fresh ? [] : [...(c.convo.context[historyKey] || [])];
  history.push({ role: 'client', text: text ?? c.body });

  const followupsAsked = fresh ? 0 : (c.convo.context[followupsKey] || 0);
  if (followupsAsked >= MAX_FOLLOWUPS) return finalise(c, clientText(history));

  const products = await listProducts({ activeOnly: true });
  const result = (await gatherQuotationInfo(history, { products })) || {};

  if (result.status === 'need_more_info' && typeof result.question === 'string' && result.question.trim()) {
    history.push({ role: 'bot', text: result.question });
    c.setState(state, { [historyKey]: history, [followupsKey]: followupsAsked + 1 });
    return c.R(() => result.question);
  }

  const consolidated = (typeof result.consolidatedRequest === 'string' && result.consolidatedRequest.trim())
    || clientText(history);
  return finalise(c, consolidated);
}
