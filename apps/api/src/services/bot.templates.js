// ─────────────────────────────────────────────────────────────────────────────
// Braq Connect™ — Message Templates
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATES = {

  // ── WELCOME / MENUS ────────────────────────────────────────────────────────

  MAIN_MENU: () =>
    `Welcome to *Braq Uni* — Your Uniform Stylist. 👋\n\n` +
    `*Braq Connect™* is your direct link to our manufacturing, retail, branding, and support services.\n\n` +
    `Please select an option:\n\n` +
    `1️⃣  Shop / Retail\n` +
    `2️⃣  School / Corporate / Bulk Orders\n` +
    `3️⃣  Request a Quotation\n` +
    `4️⃣  Track my Order\n` +
    `5️⃣  Branding & Embroidery\n` +
    `6️⃣  Store Information\n` +
    `7️⃣  Speak to a Consultant\n\n` +
    `💡 You can also type *hours*, *branding*, *store*, *po*, *quote*, or *track* at any time.`,

  RETAIL_MENU: () =>
    `Welcome to the Braq Uni Shop! 😊\n\n` +
    `1️⃣  Product pricing\n` +
    `2️⃣  School uniform information\n` +
    `3️⃣  Store trading hours\n` +
    `4️⃣  Collection status\n` +
    `5️⃣  Lay-by information\n` +
    `6️⃣  Size availability\n\n` +
    `Reply *back* or *0* for the main menu | *9* to speak to a consultant.`,

  CORPORATE_MENU: () =>
    `Thank you for contacting Braq Uni for your bulk order enquiry.\n\n` +
    `Please select an option:\n\n` +
    `1️⃣  Repeat previous order\n` +
    `2️⃣  New uniform development\n` +
    `3️⃣  Manufacturing update\n` +
    `4️⃣  Delivery schedule\n` +
    `5️⃣  Account queries\n` +
    `6️⃣  Speak to a consultant\n\n` +
    `Reply *back* or *0* for the main menu.\n` +
    `Type *quote* at any time to request a quotation.`,

  // ── BUSINESS HOURS / BUSY MODE ─────────────────────────────────────────────

  OUTSIDE_HOURS_ACK: () =>
    `Thanks for reaching out to Braq Uni! 🌙\n\n` +
    `It's currently outside our trading hours, so responses may be slightly delayed. ` +
    `We'll attend to your enquiry as soon as possible during business hours.\n\n` +
    `In the meantime, here's how we can help:`,

  HIGH_VOLUME_NOTICE: () =>
    `Thank you for contacting Braq Uni.\n\n` +
    `We are currently experiencing a high volume of enquiries and production orders.\n\n` +
    `Response times may be slightly delayed. A consultant will assist you as soon as possible.\n\n` +
    `In the meantime, here's how we can help:`,

  // ── RETAIL ─────────────────────────────────────────────────────────────────

  RETAIL_PRODUCT_LIST: ({ products }) => {
    if (!products || !products.length) {
      return `Our product catalog is currently being updated. Please speak to a consultant for pricing.\n\nReply *0* to return to the main menu.`;
    }
    const CATEGORY_ORDER = ['knitwear', 'medical_wear', 'outdoor_wear', 'corporate_wear', 'safety_wear'];
    const formatCat = (key) =>
      key.split('_').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const byCategory = {};
    for (const p of products) {
      if (!byCategory[p.category]) byCategory[p.category] = [];
      byCategory[p.category].push(p);
    }
    const orderedKeys = [
      ...CATEGORY_ORDER.filter((k) => byCategory[k]),
      ...Object.keys(byCategory).filter((k) => !CATEGORY_ORDER.includes(k) && k !== 'school_wear'),
    ];
    let msg = `🛍️ *Braq Uni — Product Pricing*\n\n`;
    for (const key of orderedKeys) {
      msg += `*${formatCat(key)}*\n`;
      for (const item of byCategory[key]) {
        msg += `• ${item.name} — R ${Number(item.price).toFixed(2)}\n`;
        if (Array.isArray(item.sizes) && item.sizes.length) {
          msg += `  Sizes: ${item.sizes.join(', ')}\n`;
        }
      }
      msg += '\n';
    }
    msg += `To place an order or ask about availability, reply *9* to speak to a consultant.\n`;
    msg += `Reply *back* for the shop menu | *0* for the main menu.`;
    return msg;
  },

  RETAIL_SCHOOL_SELECT: ({ schools }) =>
    `🏫 *School Uniform Information*\n\n` +
    `We carry uniforms for the following schools. Please reply with the number:\n\n` +
    schools.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    `\n\nReply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_SCHOOL_UNIFORMS: ({ schoolName, uniforms }) => {
    let msg = `🏫 *${schoolName} — Available Uniforms*\n\n`;
    for (const u of uniforms) {
      msg += `• *${u.name}* — R ${Number(u.price).toFixed(2)}\n`;
      if (Array.isArray(u.sizes) && u.sizes.length) {
        msg += `  Sizes: ${u.sizes.join(', ')}\n`;
      }
      if (u.description) msg += `  ${u.description}\n`;
    }
    msg += `\nTo purchase or ask about availability, reply *9* to speak to a consultant.\n`;
    msg += `Reply *back* for school list | *0* for the main menu.`;
    return msg;
  },

  RETAIL_SCHOOL_NOT_FOUND: () =>
    `Sorry, we don't have that school in our catalog yet.\n\n` +
    `Reply *9* to speak to a consultant who can assist you, or *back* to try another school.`,

  RETAIL_SIZE_ASK: () =>
    `👕 *Size Availability*\n\n` +
    `Ask me about size availability for any of our products — just type your question.\n\n` +
    `_Example: "Do you have polo shirts in size XL?"_\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_HOURS: () =>
    `🕐 *Braq Uni — Trading Hours*\n\n` +
    `Mon – Fri: *8:00 AM – 5:00 PM*\n` +
    `Saturday:  *8:00 AM – 1:00 PM*\n` +
    `Sunday & Public Holidays: *Closed*\n\n` +
    `We look forward to seeing you!\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_LAYBY: () =>
    `We offer lay-by on selected items.\n\n` +
    `A *30% deposit* is required to secure your items. The balance is due before collection.\n\n` +
    `To start a lay-by, reply *9* to speak to a consultant.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_COLLECTION_ASK: () =>
    `Please share your *order reference number* and we will check the status for you right away.\n\n` +
    `Reply *back* for the shop menu | *0* for the main menu.`,

  RETAIL_COLLECTION_READY: ({ reference }) =>
    `✅ *Good news!*\n\n` +
    `Your order *${reference}* is ready for collection at our store.\n\n` +
    `📍 754B Voortrekker Road, Dalview, Brakpan, Gauteng\n\n` +
    `Please bring your order reference number when collecting.`,

  RETAIL_COLLECTION_NOT_READY: ({ reference, stage }) =>
    `Your order *${reference}* is currently in progress.\n\n` +
    `Current stage: *${stageLabel(stage)}*\n\n` +
    `We will notify you as soon as it is ready for collection.`,

  // ── CORPORATE / BULK ───────────────────────────────────────────────────────

  CORPORATE_REPEAT_ORDER_ASK: () =>
    `Please share the *order reference number* of the previous order you'd like to repeat.`,

  CORPORATE_MANUFACTURING_ASK: () =>
    `Please share your *order reference number* and we will check the manufacturing status for you.`,

  CORPORATE_DELIVERY_ASK: () =>
    `Please share your *order reference number* and we will check the delivery schedule for you.`,

  CORPORATE_DELIVERY_STATUS: ({ reference, stage, trackingNumber }) =>
    `Your order *${reference}* is currently at: *${stageLabel(stage)}*\n\n` +
    (trackingNumber ? `*Tracking number: ${trackingNumber}*\n\n` : ``) +
    `We will notify you of any further updates.`,

  CORPORATE_ACCOUNT_QUERY_ASK: () =>
    `What is your account query about?\n\n` +
    `_e.g. invoice, payment, order status, or anything else — just describe it and we'll follow up._\n\n` +
    `Reply *back* or *0* for the main menu.`,

  CORPORATE_ACCOUNT_QUERY_LOGGED: () =>
    `Thank you. Your account query has been logged and a consultant will follow up with you shortly. 🎫\n\n` +
    `Reply *9* if you need to speak to someone immediately.`,

  // ── QUOTATION FLOW ─────────────────────────────────────────────────────────

  QUOTATION_ASK_DESCRIPTION: ({ name } = {}) =>
    `Hello${name ? ` *${name}*` : ''}! 😊\n\n` +
    `Please describe what you need a quotation for. You can write it however you like, for example:\n\n` +
    `_"300 crew-neck T-shirts, cotton, logo printed on front\n` +
    `150 polo shirts, logo embroidered on chest\n` +
    `100 hoodies, fleece, logo printed on back"_\n\n` +
    `I'll help fill in any missing details before we prepare your quote.`,

  QUOTATION_DRAFT_ACK: ({ reference, unmatched = [] }) => {
    const unmatchedBlock = unmatched.length > 0
      ? `Some items need to be checked and priced by our team:\n` +
        unmatched.map((t) => `• ${t}`).join('\n') + `\n\n`
      : '';
    return (
      `📋 *Quotation received — Ref: ${reference}*\n\n` +
      unmatchedBlock +
      `A consultant will review your quotation and send you a formal PDF within *4 business hours*.\n\n` +
      `Reply *9* at any time to speak to a consultant directly.`
    );
  },

  QUOTATION_AUTO_APPROVED: ({ reference }) =>
    `🤖✅ *Instant Quotation Generated — Ref: ${reference}*\n\n` +
    `All the items you requested are in our catalog, so we've prepared your quotation automatically!\n\n` +
    `📄 Your PDF quotation has been sent to this WhatsApp.\n\n` +
    `To confirm your order, reply *accept* or speak to a consultant.\n\n` +
    `Reply *9* to speak to a consultant | *0* for the main menu.`,

  QUOTE_ACCEPTED: ({ reference }) =>
    `✅ *Quotation Accepted — Ref: ${reference}*\n\n` +
    `Thank you! Your quotation has been accepted.\n\n` +
    `A consultant will be in touch shortly to confirm production details and collect your *60% deposit* to kick off manufacturing.\n\n` +
    `Reply *9* to speak to a consultant now | *0* for the main menu.`,

  NO_PENDING_QUOTE: () =>
    `Hmm, we couldn't find an open quotation to accept on your account. 🤔\n\n` +
    `If you've already received a quotation PDF, please share the *reference number* (e.g. BRQ-Q-…) and we'll sort it out.\n\n` +
    `Reply *3* to request a new quotation | *9* to speak to a consultant.`,

  // ── ORDER TRACKING ─────────────────────────────────────────────────────────

  ORDER_TRACKING_ASK: () =>
    `Please share your *order reference number* (e.g. BRQ-O-20250101-0001) and we'll give you a live update.\n\n` +
    `Reply *back* or *0* for the main menu.`,

  // ── REGISTRATION ──────────────────────────────────────────────────────────

  REGISTRATION_ASK_NAME: () =>
    `Before we continue, let's get a few details on file. 📝\n\nWhat is your *full name*?`,

  REGISTRATION_ASK_ORG_OR_SCHOOL: ({ clientType }) =>
    clientType === 'school' || clientType === 'retail'
      ? `Which *school* are the uniforms for? (Reply "N/A" if this doesn't apply.)`
      : `What is your *company / organisation name*, and who is the *contact person*?`,

  REGISTRATION_ASK_ADDRESS: ({ clientType }) =>
    clientType === 'retail' || clientType === 'school'
      ? `We are located at *754B Voortrekker Road, Dalview, Brakpan, Gauteng*. Will you be collecting from our store?`
      : `What is your *physical delivery address*?`,

  REGISTRATION_COMPLETE: () =>
    `Thanks, you're all set! ✅ Let's continue with your request.`,

  // ── TICKETS / COMPLAINTS ──────────────────────────────────────────────────

  TICKET_ASK_CATEGORY: () =>
    `We're sorry to hear there's an issue. Please select the category that best fits:\n\n` +
    `1️⃣  Wrong item received\n` +
    `2️⃣  Defective item\n` +
    `3️⃣  Missing item\n` +
    `4️⃣  Other\n\n` +
    `Reply *back* or *0* for the main menu.`,

  TICKET_ASK_DESCRIPTION: () =>
    `Please describe what happened, including your order reference if you have one.`,

  TICKET_LOGGED: () =>
    `Thank you for letting us know. 🎫 Your issue has been logged and a consultant will follow up with you shortly.`,

  TICKET_NEEDS_MORE_DETAIL: () =>
    `That description is a bit brief. Please include:\n\n` +
    `• *Which item* has the issue (e.g. blue polo shirt, size L)\n` +
    `• *What exactly is wrong* (e.g. wrong size, seam split, missing from parcel)\n\n` +
    `_Example: "5 of the 20 blue polo shirts have split seams."_`,

  // ── PAYMENTS ────────────────────────────────────────────────────────────────

  DEPOSIT_REQUIRED: ({ amount, percentage }) =>
    `💰 *Payment required*\n\n` +
    `A *${percentage}% deposit* of *R ${amount}* is required before production can begin. ` +
    `Please arrange payment and our team will confirm receipt.`,

  DEPOSIT_RECEIVED: ({ amount, balance }) =>
    `✅ *Deposit received — thank you!*\n\nAmount: R ${amount}\n` +
    (balance && balance !== '0.00'
      ? `Remaining balance: R ${balance} (due before completion).`
      : `Your order is fully paid.`),

  BALANCE_OUTSTANDING: ({ amount }) =>
    `Reminder: a balance of *R ${amount}* remains outstanding on your order. ` +
    `Please settle this before collection/delivery.`,

  PAID_IN_FULL: () =>
    `✅ *Payment complete — thank you!* Your order is now fully paid.`,

  // ── ORDER STAGE NOTIFICATIONS ──────────────────────────────────────────────

  STAGE_1_QUOTATION_REQUESTED: ({ reference }) =>
    `Thank you for your enquiry. 📋\n\n` +
    `Your quotation request has been received and assigned to a consultant who will be in touch shortly.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_2_QUOTATION_SUBMITTED: ({ reference }) =>
    `Your quotation has been prepared and sent for your review. 📄\n\n` +
    `Please contact us if you require any amendments.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_3_PO_RECEIVED: ({ reference }) =>
    `Thank you. ✅\n\n` +
    `Your purchase order has been received and processing has commenced.\n\n` +
    `We will keep you updated at every step.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_4_MATERIALS: ({ reference }) =>
    `Materials and trims are being allocated or sourced for your order. 🧵\n\n` +
    `*Ref: ${reference}*`,

  STAGE_5_PRODUCTION_SCHEDULED: ({ reference, estimatedCompletion }) =>
    `Your order has been scheduled for manufacturing. 📅\n\n` +
    `*Estimated completion: ${estimatedCompletion || 'To be confirmed'}*\n\n` +
    `*Ref: ${reference}*`,

  STAGE_6_MANUFACTURING: ({ reference }) =>
    `Your garments are currently in production. 🏭\n\n` +
    `Our team is working to your approved specifications.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_7_BRANDING: ({ reference }) =>
    `Your garments are undergoing branding, embroidery, sublimation, or printing. 🎨\n\n` +
    `*Ref: ${reference}*`,

  STAGE_8_QC: ({ reference }) =>
    `Your order is undergoing final quality inspection. 🔍\n\n` +
    `*Ref: ${reference}*`,

  STAGE_9_DISPATCH: ({ reference }) =>
    `Your order is being packed and prepared for collection or delivery. 📦\n\n` +
    `*Ref: ${reference}*`,

  STAGE_10_COMPLETED_COLLECTION: ({ reference }) =>
    `✅ *Good news!*\n\n` +
    `Your order has been completed and is ready for collection.\n\n` +
    `📍 *754B Voortrekker Road, Dalview, Brakpan, Gauteng*\n\n` +
    `Please bring your reference number when collecting.\n` +
    `*Ref: ${reference}*\n\n` +
    `Thank you for choosing Braq Uni. 🙏`,

  STAGE_10_COMPLETED_DELIVERY: ({ reference, trackingNumber }) =>
    `✅ *Your order has been dispatched!*\n\n` +
    (trackingNumber ? `*Tracking number: ${trackingNumber}*\n\n` : ``) +
    `Should you need assistance, please contact our team.\n\n` +
    `*Ref: ${reference}*\n\nThank you for choosing Braq Uni. 🙏`,

  // ── MISC NOTIFICATIONS ─────────────────────────────────────────────────────

  SUPPLIER_DELAY: ({ reference }) =>
    `⚠️ *Order update — ${reference}*\n\n` +
    `We are currently awaiting fabric allocation from our supplier.\n\n` +
    `Your order remains active and production will continue immediately upon receipt of materials.\n\n` +
    `We appreciate your patience and understanding.`,

  CONSULTANT_ASSIGNED: ({ consultantName }) =>
    `You have been connected to *${consultantName}*, your dedicated consultant. They will be with you shortly.`,

  AWAITING_CONSULTANT: () =>
    `Your message has been received. 📩\n\n` +
    `A consultant will be with you shortly. Please hold on.\n\n` +
    `Reply *0* to return to the main menu while you wait.`,

  UNKNOWN_INTENT: () =>
    `I didn't quite catch that. 😊\n\n` +
    `Reply *menu* or *0* to return to the main menu, or type your question and a consultant will assist you.`,

  ORDER_NOT_FOUND: () =>
    `We couldn't find an order with that reference number. ` +
    `Please double-check and try again, or reply *9* to speak to a consultant.`,

  BRANDING_INFO: () =>
    `We offer the following branding services:\n\n` +
    `🧵 *Embroidery* — logos, names, and crests\n` +
    `🖨️ *Sublimation printing* — full-colour designs\n` +
    `🖋️ *Screen printing* — large quantity runs\n` +
    `🏷️ *Heat transfer* — name badges and numbers\n\n` +
    `Reply *3* to request a quotation or *9* to speak to a consultant.`,

  STORE_INFO: () =>
    `📍 *Braq Uni — Store Information*\n\n` +
    `*754B Voortrekker Road*\n` +
    `Dalview, Brakpan, Gauteng\n\n` +
    `🕐 *Trading Hours*\n` +
    `Mon – Fri: 8:00 AM – 5:00 PM\n` +
    `Saturday:  8:00 AM – 1:00 PM\n` +
    `Sunday & Public Holidays: Closed\n\n` +
    `Reply *0* to return to the main menu.`,

  ORDER_TRACKING_RESULT: ({ reference, stage, trackingNumber, estimatedCompletion }) =>
    `📦 *Order Status — ${reference}*\n\n` +
    `Current stage: *${stageLabel(stage)}*\n\n` +
    (estimatedCompletion ? `Estimated completion: *${estimatedCompletion}*\n\n` : ``) +
    (trackingNumber ? `Tracking number: *${trackingNumber}*\n\n` : ``) +
    `Reply *0* for the main menu or *9* to speak to a consultant.`,
};

// ── Stage label helper ────────────────────────────────────────────────────────
export function stageLabel(stage) {
  const labels = {
    quotation_requested:   'Quotation requested',
    quotation_submitted:   'Quotation submitted',
    po_received:           'Purchase order received',
    materials_procurement: 'Materials procurement',
    production_scheduled:  'Production scheduled',
    manufacturing:         'Manufacturing in progress',
    branding_embroidery:   'Branding & embroidery',
    quality_control:       'Quality control',
    packing_dispatch:      'Packing & dispatch',
    completed:             'Completed',
  };
  return labels[stage] || stage;
}

// ── Stage index (1-based) ─────────────────────────────────────────────────────
export const STAGE_ORDER = [
  'quotation_requested',
  'quotation_submitted',
  'po_received',
  'materials_procurement',
  'production_scheduled',
  'manufacturing',
  'branding_embroidery',
  'quality_control',
  'packing_dispatch',
  'completed',
];

export function nextStage(current) {
  const idx = STAGE_ORDER.indexOf(current);
  if (idx === -1 || idx === STAGE_ORDER.length - 1) return null;
  return STAGE_ORDER[idx + 1];
}

// ── Map order stage → WhatsApp notification template key ──────────────────────
export function templateForStage(stage) {
  const map = {
    quotation_requested:   'STAGE_1_QUOTATION_REQUESTED',
    quotation_submitted:   'STAGE_2_QUOTATION_SUBMITTED',
    po_received:           'STAGE_3_PO_RECEIVED',
    materials_procurement: 'STAGE_4_MATERIALS',
    production_scheduled:  'STAGE_5_PRODUCTION_SCHEDULED',
    manufacturing:         'STAGE_6_MANUFACTURING',
    branding_embroidery:   'STAGE_7_BRANDING',
    quality_control:       'STAGE_8_QC',
    packing_dispatch:      'STAGE_9_DISPATCH',
    completed:             'STAGE_10_COMPLETED_COLLECTION',
  };
  return map[stage] || null;
}
