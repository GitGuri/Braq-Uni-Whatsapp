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
    `4️⃣  Make an Order\n` +
    `5️⃣  Track my Order\n` +
    `6️⃣  Branding & Embroidery\n` +
    `7️⃣  Store Information\n` +
    `8️⃣  Speak to a Consultant`,

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
    `Reply *back* or *0* for the main menu.`,

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

  // ── MAKE ORDER FLOW ────────────────────────────────────────────────────────

  ORDER_ASK_METHOD: () =>
    `🛒 *Make an Order*\n\n` +
    `How would you like to place your order?\n\n` +
    `1️⃣  I have a quotation reference (BRQ-Q-...)\n` +
    `2️⃣  Order catalog items directly\n\n` +
    `Reply *back* or *0* for the main menu.`,

  ORDER_ASK_REFERENCE: () =>
    `Please share your *quotation reference number* (e.g. *BRQ-Q-20250101-0001*).\n\n` +
    `You can find it in the PDF we sent to this WhatsApp.\n\n` +
    `Reply *back* to go back.`,

  ORDER_QUOTE_NOT_FOUND: () =>
    `We couldn't find a quotation with that reference on your account. 🔍\n\n` +
    `Please double-check the reference and try again, or reply *9* to speak to a consultant.`,

  ORDER_QUOTE_NOT_READY: ({ status } = {}) =>
    status === 'draft'
      ? `Your quotation is still being reviewed by our team. 🕐\n\n` +
        `We'll send you the PDF as soon as it's ready. Reply *9* to follow up with a consultant.`
      : `This quotation has already been converted to an order or is no longer available.\n\n` +
        `Reply *5* to track your existing order, or *9* to speak to a consultant.`,

  ORDER_CONFIRM_QUOTE: ({ reference, items = [], subtotal, vat, total, deposit }) => {
    const lines = items.map((i) => {
      const colour = i.colour ? ` — ${i.colour}` : '';
      const sizes  = Array.isArray(i.sizes) && i.sizes.filter(s => s.size !== 'TBC').length
        ? '\n   ' + i.sizes.map((s) => `${s.size}×${s.qty}`).join('  ')
        : '';
      return `• ${i.name}${colour}  ×${i.quantity}  — R ${Number(i.lineTotal ?? i.unitPrice * i.quantity ?? 0).toFixed(2)}${sizes}`;
    }).join('\n');
    return (
      `📋 *Quotation: ${reference}*\n\n` +
      lines + `\n\n` +
      `Subtotal:  R ${Number(subtotal).toFixed(2)}\n` +
      `VAT (15%): R ${Number(vat).toFixed(2)}\n` +
      `*Total:    R ${Number(total).toFixed(2)}*\n\n` +
      `💳 *Deposit required (60%): R ${Number(deposit).toFixed(2)}*\n\n` +
      `Ready to place this order?\n` +
      `1️⃣  Yes, confirm order\n` +
      `2️⃣  No, cancel\n\n` +
      `Reply *9* to speak to a consultant first.`
    );
  },

  ORDER_ASK_ITEMS: ({ name } = {}) =>
    `Great! What would you like to order${name ? `, *${name}*` : ''}? 😊\n\n` +
    `Please describe the items, colours, and sizes you need, for example:\n\n` +
    `_"50 polo shirts, navy blue, S×10 M×20 L×20\n` +
    `30 hoodies, black, M×15 L×15"_\n\n` +
    `*Note:* For custom items not in our catalog, please request a quotation first (option 3).\n\n` +
    `I'll help fill in any missing details.`,

  ORDER_CUSTOM_ITEMS_NOT_ALLOWED: ({ unmatched = [] }) =>
    `⚠️ Some items you requested aren't in our standard catalog:\n` +
    unmatched.map((u) => `• ${u}`).join('\n') +
    `\n\nFor custom items we need to prepare a quotation first so our team can price them correctly.\n\n` +
    `Reply *3* to request a quotation | *back* to try a different order.`,

  ORDER_CONFIRM_DIRECT: ({ items = [], subtotal, vat, total, deposit }) => {
    const lines = items.map((i) => {
      const colour = i.colour ? ` — ${i.colour}` : '';
      const sizes  = Array.isArray(i.sizes) && i.sizes.filter(s => s.size !== 'TBC').length
        ? '\n   ' + i.sizes.map((s) => `${s.size}×${s.qty}`).join('  ')
        : '';
      return `• ${i.name}${colour}  ×${i.quantity}  — R ${Number(i.lineTotal ?? 0).toFixed(2)}${sizes}`;
    }).join('\n');
    return (
      `🛒 *Your Order Summary*\n\n` +
      lines + `\n\n` +
      `Subtotal:  R ${Number(subtotal).toFixed(2)}\n` +
      `VAT (15%): R ${Number(vat).toFixed(2)}\n` +
      `*Total:    R ${Number(total).toFixed(2)}*\n\n` +
      `💳 *Deposit required (60%): R ${Number(deposit).toFixed(2)}*\n\n` +
      `Ready to place this order?\n` +
      `1️⃣  Yes, place order\n` +
      `2️⃣  No, cancel\n\n` +
      `Reply *9* to speak to a consultant first.`
    );
  },

  ORDER_CREATED: ({ reference, deposit }) =>
    `✅ *Order Placed — Ref: ${reference}*\n\n` +
    `Your order has been received! 🎉\n\n` +
    `A consultant will contact you shortly to arrange your *60% deposit of R ${Number(deposit).toFixed(2)}* — this kicks off your production run.\n\n` +
    `Track your order at any time by typing *track* or sending your reference: *${reference}*\n\n` +
    `Reply *9* to speak to a consultant now | *0* for the main menu.`,

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

  // ── ORDER STAGE NOTIFICATIONS (4 stages) ──────────────────────────────────

  STAGE_DEPOSIT_PENDING: ({ reference, items = [], deposit }) => {
    const lines = formatItemsSummary(items);
    return (
      `✅ *Order Received — Ref: ${reference}*\n\n` +
      (lines ? `Your order:\n${lines}\n\n` : '') +
      `💳 *60% Deposit required: R ${Number(deposit ?? 0).toFixed(2)}*\n\n` +
      `A consultant will contact you shortly to arrange payment and kick off your production run.\n\n` +
      `Reply *9* to speak to a consultant now.`
    );
  },

  STAGE_IN_PRODUCTION: ({ reference, items = [], estimatedCompletion }) => {
    const lines = formatItemsSummary(items);
    return (
      `🏭 *In Production — Ref: ${reference}*\n\n` +
      `Your deposit has been received — your garments are now in production! 🎉\n\n` +
      (lines ? `In production:\n${lines}\n\n` : '') +
      (estimatedCompletion ? `📅 *Estimated completion: ${estimatedCompletion}*\n\n` : '') +
      `We'll notify you as soon as your order is ready.\n\n` +
      `Reply *9* to speak to a consultant.`
    );
  },

  STAGE_READY_COLLECTION: ({ reference, items = [] }) => {
    const lines = formatItemsSummary(items);
    return (
      `✅ *Ready for Collection — Ref: ${reference}*\n\n` +
      `Your order has passed quality inspection and is ready for collection! 🎉\n\n` +
      (lines ? lines + '\n\n' : '') +
      `📍 *754B Voortrekker Road, Dalview, Brakpan, Gauteng*\n\n` +
      `Please bring your order reference when collecting.\n\n` +
      `Reply *9* if you need assistance.`
    );
  },

  STAGE_READY_DELIVERY: ({ reference, items = [], trackingNumber }) => {
    const lines = formatItemsSummary(items);
    return (
      `🚚 *Order Dispatched — Ref: ${reference}*\n\n` +
      `Your order is on its way! 🎉\n\n` +
      (lines ? lines + '\n\n' : '') +
      (trackingNumber ? `📦 *Tracking number: ${trackingNumber}*\n\n` : '') +
      `Reply *9* if you need assistance.`
    );
  },

  STAGE_COMPLETED: ({ reference }) =>
    `✅ *Order Complete — Ref: ${reference}*\n\n` +
    `Thank you for choosing Braq Uni! We hope you love your new uniforms. 🙏\n\n` +
    `Reply *3* to request a new quotation | *0* for the main menu.`,

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

  // ── DIGITAL PROOF APPROVAL ─────────────────────────────────────────────────

  PROOF_SENT: ({ reference, proofUrl, notes }) =>
    `🎨 *Design Proof Ready — Ref: ${reference}*\n\n` +
    (notes ? `${notes}\n\n` : '') +
    `Please review your design proof:\n${proofUrl}\n\n` +
    `*Reply:*\n` +
    `✅ *approve* — I'm happy with this design\n` +
    `✏️ *revise* — I need changes (please describe what to change)\n\n` +
    `We'll hold production until you confirm.`,

  PROOF_APPROVED: ({ reference }) =>
    `✅ *Proof Approved — Ref: ${reference}*\n\n` +
    `Thank you! Your design has been approved and we're moving into full production. 🎉\n\n` +
    `We'll notify you when your order is ready.\n\n` +
    `Reply *0* for the main menu or *9* to speak to a consultant.`,

  PROOF_REVISION_REQUESTED: ({ reference }) =>
    `✏️ *Revision Noted — Ref: ${reference}*\n\n` +
    `Thank you for your feedback. Our design team will make the requested changes and send you an updated proof shortly.\n\n` +
    `Reply *9* if you'd like to speak to a consultant directly.`,

  PROOF_REVISION_ASK: ({ reference }) =>
    `Please describe the changes you'd like made to the design for order *${reference}*.\n\n` +
    `Reply *back* to cancel.`,
};

// ── Items summary formatter for stage notifications ───────────────────────────
function formatItemsSummary(items = []) {
  if (!Array.isArray(items) || !items.length) return '';
  return items.map((i) => {
    const name   = i.name ?? i.description ?? 'Item';
    const colour = i.colour ? ` — ${i.colour}` : '';
    const qty    = i.quantity ?? 0;
    const activeSizes = Array.isArray(i.sizes)
      ? i.sizes.filter((s) => s.size !== 'TBC' && s.qty > 0)
      : [];
    const sizeStr = activeSizes.length
      ? '\n   ' + activeSizes.map((s) => `${s.size}×${s.qty}`).join('  ')
      : '';
    return `• ${name}${colour}  ×${qty}${sizeStr}`;
  }).join('\n');
}

// ── Stage label helper ────────────────────────────────────────────────────────
export function stageLabel(stage) {
  const labels = {
    deposit_pending: 'Awaiting Deposit',
    in_production:   'In Production',
    ready:           'Ready / Dispatched',
    completed:       'Completed',
  };
  return labels[stage] || stage;
}

// ── 4-stage order pipeline ────────────────────────────────────────────────────
export const STAGE_ORDER = [
  'deposit_pending',
  'in_production',
  'ready',
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
    deposit_pending: 'STAGE_DEPOSIT_PENDING',
    in_production:   'STAGE_IN_PRODUCTION',
    ready:           'STAGE_READY_COLLECTION',
    completed:       'STAGE_COMPLETED',
  };
  return map[stage] || null;
}
