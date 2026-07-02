// ─────────────────────────────────────────────────────────────────────────────
// Braq Connect™ — Message Templates
// All WhatsApp messages sent by the platform
// ─────────────────────────────────────────────────────────────────────────────

export const TEMPLATES = {

  // ── WELCOME ────────────────────────────────────────────────────────────────
  MAIN_MENU: () =>
    `Welcome to *Braq Uni* — Your Uniform Stylist. 👋\n\n` +
    `*Braq Connect™* is your direct link to our manufacturing, retail, branding, and customer support services.\n\n` +
    `Please select an option:\n\n` +
    `1️⃣  Retail customer\n` +
    `2️⃣  School / corporate / bulk orders\n` +
    `3️⃣  Request a quotation\n` +
    `4️⃣  Order tracking\n` +
    `5️⃣  Branding & embroidery\n` +
    `6️⃣  Store information\n` +
    `7️⃣  Speak to a consultant`,

  // ── BUSINESS HOURS ─────────────────────────────────────────────────────────
  OUTSIDE_HOURS_ACK: () =>
    `Thanks for reaching out to Braq Uni! 🌙\n\n` +
    `It's currently outside our trading hours, so response may be slightly delayed. ` +
    `We'll attend to your enquiry as soon as possible during business hours.\n\n` +
    `In the meantime, here's how we can help:`,

  // ── RETAIL ─────────────────────────────────────────────────────────────────
  RETAIL_MENU: () =>
    `Welcome! How can we help you today? 😊\n\n` +
    `1️⃣  Product pricing\n` +
    `2️⃣  School uniform information\n` +
    `3️⃣  Store trading hours\n` +
    `4️⃣  Collection status\n` +
    `5️⃣  Lay-by information\n` +
    `6️⃣  Speak to a consultant\n\n` +
    `Reply *0* at any time to return to the main menu.`,

  RETAIL_PRODUCT_LIST: ({ products }) => {
    if (!products || !products.length) {
      return `Our product catalog is currently being updated. Please speak to a consultant for pricing.\n\nReply *0* to return to the main menu.`;
    }
    const byCategory = {};
    for (const p of products) {
      const cat = p.category.charAt(0).toUpperCase() + p.category.slice(1);
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(p);
    }
    let msg = `🛍️ *Braq Uni — Product Pricing*\n\n`;
    for (const [cat, items] of Object.entries(byCategory)) {
      msg += `*${cat}*\n`;
      for (const item of items) {
        msg += `• ${item.name} — R ${Number(item.price).toFixed(2)}\n`;
        if (Array.isArray(item.sizes) && item.sizes.length) {
          msg += `  Sizes: ${item.sizes.join(', ')}\n`;
        }
      }
      msg += '\n';
    }
    msg += `To place an order or ask about availability, reply *7* to speak to a consultant.\n`;
    msg += `Reply *0* to return to the main menu.`;
    return msg;
  },

  RETAIL_SCHOOL_SELECT: ({ schools }) =>
    `🏫 *School Uniform Information*\n\n` +
    `We carry uniforms for the following schools. Please reply with the number:\n\n` +
    schools.map((s, i) => `${i + 1}. ${s}`).join('\n') +
    `\n\nReply *0* to return to the main menu.`,

  RETAIL_SCHOOL_UNIFORMS: ({ schoolName, uniforms }) => {
    let msg = `🏫 *${schoolName} — Available Uniforms*\n\n`;
    for (const u of uniforms) {
      msg += `• *${u.uniform_type}* — R ${Number(u.price).toFixed(2)}\n`;
      if (Array.isArray(u.sizes) && u.sizes.length) {
        msg += `  Sizes: ${u.sizes.join(', ')}\n`;
      }
      if (u.description) msg += `  ${u.description}\n`;
    }
    msg += `\nTo purchase or ask about availability, reply *7* to speak to a consultant.\n`;
    msg += `Reply *0* to return to the main menu.`;
    return msg;
  },

  RETAIL_SCHOOL_NOT_FOUND: () =>
    `Sorry, we don't have a record of that school in our catalog.\n\nReply *7* to speak to a consultant who can assist you, or *0* to return to the main menu.`,

  RETAIL_HOURS: () =>
    `🕐 *Braq Uni — Trading Hours*\n\n` +
    `Mon – Fri: *8:00 AM – 5:00 PM*\n` +
    `Saturday:  *8:00 AM – 1:00 PM*\n` +
    `Sunday & Public Holidays: *Closed*\n\n` +
    `We look forward to seeing you!`,

  RETAIL_LAYBY: () =>
    `We offer lay-by on selected items.\n\n` +
    `A *30% deposit* is required to secure your items. The balance is due before collection.\n\n` +
    `To start a lay-by, reply *6* to be connected to a consultant now.`,

  RETAIL_COLLECTION_ASK: () =>
    `Please share your *order reference number* and we will check the status for you right away.`,

  RETAIL_COLLECTION_READY: ({ reference }) =>
    `✅ *Good news!*\n\nYour order is ready for collection.\n\nPlease bring your reference number when collecting.\n*Ref: ${reference}*`,

  RETAIL_COLLECTION_NOT_READY: ({ reference, stage, percent }) =>
    `Your order *${reference}* is currently in progress.\n\nCurrent stage: *${stageLabel(stage)}*` +
    (percent != null ? ` (${percent}% complete)` : ``) +
    `\n\nWe will notify you as soon as it is ready for collection.`,

  // ── CORPORATE ──────────────────────────────────────────────────────────────
  QUOTATION_ASK_DESCRIPTION: ({ name } = {}) =>
    `Hello${name ? ` *${name}*` : ''}! 😊\n\n` +
    `Please describe what you need a quotation for. You can write it however you like, for example:\n\n` +
    `_"300 crew-neck T-shirts, cotton, logo printed on front\n` +
    `150 polo shirts, logo embroidered on chest\n` +
    `100 hoodies, fleece, logo printed on back"_\n\n` +
    `I'll help you fill in any missing details before we prepare your quote.`,

  CORPORATE_MENU: () =>
    `Thank you for contacting Braq Uni for your bulk order enquiry.\n\n` +
    `Please select an option:\n\n` +
    `1️⃣  Repeat previous order\n` +
    `2️⃣  New uniform development\n` +
    `3️⃣  Manufacturing updates\n` +
    `4️⃣  Delivery schedule\n` +
    `5️⃣  Account queries\n` +
    `6️⃣  Dedicated consultant support\n\n` +
    `To request a quotation, reply *3* on the main menu or type *quote* at any time.`,

  CORPORATE_NEW_ORDER: () =>
    `Please describe what you need — garment type, quantity, branding requirements, and your preferred timeline — and we'll prepare a quotation for you.`,

  CORPORATE_REPEAT_ORDER_ASK: () =>
    `Please share the *order reference number* of the previous order you'd like to repeat.`,

  CORPORATE_MANUFACTURING_ASK: () =>
    `Please share your *order reference number* and we will check the manufacturing status for you.`,

  CORPORATE_DELIVERY_ASK: () =>
    `Please share your *order reference number* and we will check the delivery schedule for you.`,

  CORPORATE_DELIVERY_STATUS: ({ reference, stage, trackingNumber, percent }) =>
    `Your order *${reference}* is currently at: *${stageLabel(stage)}*` +
    (percent != null ? ` (${percent}% complete)` : ``) + `\n\n` +
    (trackingNumber ? `*Tracking number: ${trackingNumber}*\n\n` : ``) +
    `We will notify you of any further updates.`,

  UNIFORM_INTAKE_GARMENT: () =>
    `Let's get started on your new uniform. 🧵\n\nWhat *garment type(s)* do you need (e.g. shirts, trousers, skirts, jackets)?`,

  UNIFORM_INTAKE_SIZES: () =>
    `What *sizes or age range* are required?`,

  UNIFORM_INTAKE_BRANDING: () =>
    `Do you need any *branding* — embroidery, printing, or badges? If so, please describe.`,

  UNIFORM_INTAKE_QUANTITY: () =>
    `Finally, what *quantity* do you need and what's your *preferred timeline*?`,

  UNIFORM_INTAKE_COMPLETE: ({ reference }) =>
    `Thank you! Your new uniform development brief has been logged. 📋\n\n*Ref: ${reference}*\n\nA consultant will be in touch shortly to take this further.`,

  // ── REGISTRATION (CRM gate) ───────────────────────────────────────────────────
  REGISTRATION_ASK_NAME: () =>
    `Before we continue, let's get a few details on file. 📝\n\nWhat is your *full name*?`,

  REGISTRATION_ASK_ORG_OR_SCHOOL: ({ clientType }) =>
    clientType === 'school' || clientType === 'retail'
      ? `Which *school* are these uniforms for? (Reply "N/A" if this doesn't apply to you.)`
      : `What is your *company / organisation name*, and who is the *contact person*?`,

  REGISTRATION_ASK_ADDRESS: ({ clientType }) =>
    clientType === 'retail' || clientType === 'school'
      ? `Which *store location* do you usually visit or prefer for collection?`
      : `What is your *physical/delivery address*?`,

  REGISTRATION_COMPLETE: () =>
    `Thanks, you're all set! ✅ Let's continue with your request.`,

  // ── PURCHASE ORDERS ────────────────────────────────────────────────────────────
  PO_ASK_QUOTATION_REF: () =>
    `Please share the *quotation reference number* this purchase order relates to.`,

  PO_ASK_NUMBER: () =>
    `Thank you. Please share your *purchase order number*.`,

  PO_INVALID: () =>
    `We were unable to validate that purchase order against an active quotation. ` +
    `A consultant will follow up to confirm details with you.`,

  // ── DESIGN APPROVAL ────────────────────────────────────────────────────────────
  DESIGN_APPROVAL_REQUEST: ({ reference }) =>
    `🎨 *Design approval needed — ${reference}*\n\n` +
    `Please review the design/specifications shared with you and reply *APPROVE* to proceed to production, ` +
    `or *REJECT: <reason>* if changes are needed.`,

  DESIGN_APPROVED_ACK: ({ reference }) =>
    `✅ Thank you! Design approved for *${reference}*. Production will now begin.`,

  DESIGN_REJECTED_ACK: ({ reference }) =>
    `Noted — we've put *${reference}* on hold and a consultant will be in touch to revise the design.`,

  // ── PAYMENTS ────────────────────────────────────────────────────────────────────
  DEPOSIT_REQUIRED: ({ amount, percentage }) =>
    `💰 *Payment required*\n\nA *${percentage}% deposit* of *${amount}* is required before production can begin. ` +
    `Please arrange payment and our team will confirm receipt.`,

  DEPOSIT_RECEIVED: ({ amount, balance }) =>
    `✅ *Deposit received* — thank you!\n\nAmount: ${amount}\n` +
    (balance && balance !== '0.00' ? `Remaining balance: ${balance} (due before completion).` : `Your order is fully paid.`),

  BALANCE_OUTSTANDING: ({ amount }) =>
    `Reminder: a balance of *${amount}* remains outstanding on your order. Please settle this before collection/delivery.`,

  PAID_IN_FULL: () =>
    `✅ *Payment complete* — thank you! Your order is now fully paid.`,

  // ── COMPLAINTS / RETURNS ───────────────────────────────────────────────────────
  TICKET_ASK_CATEGORY: () =>
    `We're sorry to hear there's an issue. Please select the category that best fits:\n\n` +
    `1️⃣  Wrong item received\n` +
    `2️⃣  Defective item\n` +
    `3️⃣  Missing item\n` +
    `4️⃣  Other`,

  TICKET_ASK_DESCRIPTION: () =>
    `Please describe what happened, including your order reference if you have one.`,

  TICKET_LOGGED: () =>
    `Thank you for letting us know. 🎫 Your issue has been logged and a consultant will follow up with you shortly.`,

  // ── ORDER STAGES ───────────────────────────────────────────────────────────
  STAGE_1_QUOTATION_REQUESTED: ({ reference }) =>
    `Thank you for your enquiry. 📋\n\n` +
    `Your quotation request has been received and assigned to a consultant who will be in touch shortly.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_2_QUOTATION_SUBMITTED: ({ reference }) =>
    `Your quotation has been prepared and is ready for review. 📄\n\n` +
    `Please contact us should you require any amendments.\n\n` +
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
    `*Estimated completion date: ${estimatedCompletion || 'To be confirmed'}*\n\n` +
    `*Ref: ${reference}*`,

  STAGE_6_MANUFACTURING: ({ reference }) =>
    `Your garments are currently in production. 🏭\n\n` +
    `Our team is working according to your approved specifications.\n\n` +
    `*Ref: ${reference}*`,

  STAGE_7_BRANDING: ({ reference }) =>
    `Your garments are currently undergoing branding, embroidery, sublimation, or printing. 🎨\n\n` +
    `*Ref: ${reference}*`,

  STAGE_8_QC: ({ reference }) =>
    `Your order is undergoing final quality inspection to ensure all standards are met. 🔍\n\n` +
    `*Ref: ${reference}*`,

  STAGE_9_DISPATCH: ({ reference }) =>
    `Your order is being prepared for collection or delivery. 📦\n\n` +
    `*Ref: ${reference}*`,

  STAGE_10_COMPLETED_COLLECTION: ({ reference }) =>
    `✅ *Good news!*\n\n` +
    `Your order has been completed and is ready for collection.\n\n` +
    `Please bring your order reference number when collecting.\n` +
    `*Ref: ${reference}*\n\n` +
    `Thank you for choosing Braq Uni. 🙏`,

  STAGE_10_COMPLETED_DELIVERY: ({ reference, trackingNumber }) =>
    `✅ *Your order has been dispatched!*\n\n` +
    `*Tracking number: ${trackingNumber || 'N/A'}*\n\n` +
    `Should you require assistance, please contact our team.\n\n` +
    `*Ref: ${reference}*\n\nThank you for choosing Braq Uni. 🙏`,

  // ── NOTIFICATIONS ──────────────────────────────────────────────────────────
  HIGH_VOLUME_NOTICE: () =>
    `Thank you for contacting Braq Uni.\n\n` +
    `We are currently experiencing a high volume of enquiries and production orders.\n\n` +
    `Response times may be slightly delayed. A consultant will assist you as soon as possible.`,

  SUPPLIER_DELAY: ({ reference }) =>
    `⚠️ *Order update — ${reference}*\n\n` +
    `We are currently awaiting fabric allocation from our supplier.\n\n` +
    `Your order remains active and production will continue immediately upon receipt of materials.\n\n` +
    `We appreciate your patience and understanding.`,

  CONSULTANT_ASSIGNED: ({ consultantName }) =>
    `You have been connected to *${consultantName}*, your dedicated consultant.\n\nThey will be with you shortly.`,

  UNKNOWN_INTENT: () =>
    `I didn't quite catch that. 😊\n\nReply *menu* to return to the main menu, or type your question and a consultant will assist you.`,

  ORDER_NOT_FOUND: () =>
    `We could not find an order with that reference number. Please double-check and try again, or reply *7* to speak to a consultant.`,

  BRANDING_INFO: () =>
    `We offer the following branding services:\n\n` +
    `🧵 *Embroidery* — for logos, names, and crests\n` +
    `🖨️ *Sublimation printing* — for full-colour designs\n` +
    `🖋️ *Screen printing* — for large quantity runs\n` +
    `🏷️ *Heat transfer* — for name badges and numbers\n\n` +
    `Please reply *3* to request a quotation or *7* to speak to a consultant.`,

  STORE_INFO: () =>
    `📍 *Braq Uni — Store Information*\n\n` +
    `Address: [Your store address here]\n\n` +
    `🕐 *Trading Hours*\n` +
    `Mon – Fri: 8:00 AM – 5:00 PM\n` +
    `Saturday:  8:00 AM – 1:00 PM\n` +
    `Sunday & Public Holidays: Closed\n\n` +
    `📞 [Your phone number]\n` +
    `📧 [Your email address]`,
};

// ── Stage label helper ────────────────────────────────────────────────────────
export function stageLabel(stage) {
  const labels = {
    quotation_requested:    'Quotation requested',
    quotation_submitted:    'Quotation submitted',
    purchase_order_received:'Purchase order received',
    design_approval_pending:'Awaiting design approval',
    materials_procurement:  'Materials procurement',
    production_scheduled:   'Production scheduled',
    manufacturing:          'Manufacturing in progress',
    branding_embroidery:    'Branding & embroidery',
    quality_control:        'Quality control',
    packing_dispatch:       'Packing & dispatch',
    completed:              'Completed',
    cancelled:              'Cancelled',
    on_hold:                'On hold',
  };
  return labels[stage] || stage;
}

// ── Map order stage to template key ──────────────────────────────────────────
export function templateForStage(stage) {
  const map = {
    quotation_requested:     'STAGE_1_QUOTATION_REQUESTED',
    quotation_submitted:     'STAGE_2_QUOTATION_SUBMITTED',
    purchase_order_received: 'STAGE_3_PO_RECEIVED',
    design_approval_pending: 'DESIGN_APPROVAL_REQUEST',
    materials_procurement:   'STAGE_4_MATERIALS',
    production_scheduled:    'STAGE_5_PRODUCTION_SCHEDULED',
    manufacturing:           'STAGE_6_MANUFACTURING',
    branding_embroidery:     'STAGE_7_BRANDING',
    quality_control:         'STAGE_8_QC',
    packing_dispatch:        'STAGE_9_DISPATCH',
    completed:               'STAGE_10_COMPLETED_COLLECTION',
  };
  return map[stage] || null;
}
