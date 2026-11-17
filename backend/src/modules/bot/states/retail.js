// School uniforms for parents (the retail shop): price list, school uniforms
// (pick from the list or just type the school's name), hours, "is my order
// ready?", lay-by and the AI size FAQ. The price list / hours / lay-by screens
// keep the shop menu numbers working.
import { TEMPLATES } from '../templates.js';
import { answerFaq } from '../../../integrations/ai.client.js';
import { listProducts, listSchoolNames, listProductsBySchool } from '../../catalog/service.js';
import { startTracking } from './order.js';

// Canonical school list — always shown even before the catalog is populated
export const SCHOOLS = [
  'Laerskool Dalview',
  'Hoerskool Stoffberg',
  'Laerskool Brakpan Oos',
  'Tsakane Secondary',
  'Dalpark Primary',
  'Dalpark Secondary',
  'Anzac Primary',
  'Sonneveld Akademie',
  'Exed Privaat Skool',
  'Laerskool Die Arend',
  'Brakpan Educational Centre',
  'Brakpan Educational Primary',
];

async function allSchools() {
  const dbSchools = await listSchoolNames();
  return [...SCHOOLS, ...dbSchools.filter((s) => !SCHOOLS.includes(s))];
}

// Words that say "school" but don't tell schools apart (plus the town name).
const GENERIC_WORDS = new Set([
  'laerskool', 'hoerskool', 'hoërskool', 'primary', 'secondary', 'school', 'skool', 'high', 'privaat', 'private',
  'akademie', 'academy', 'centre', 'center', 'educational', 'die', 'the', 'oos', 'brakpan', 'college', 'prep',
]);
const norm = (s) => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

/** Schools the text names: the whole name, or a distinctive word of it ("dalview"). */
export async function findSchools(text) {
  const t = ` ${norm(text)} `;
  if (t.trim().length < 3) return [];
  const schools = await allSchools();
  const full = schools.filter((s) => t.includes(` ${norm(s)} `));
  if (full.length) return full;
  return schools.filter((s) => norm(s).split(' ').some((w) => w.length >= 4 && !GENERIC_WORDS.has(w) && t.includes(` ${w} `)));
}

/** One school's uniforms (or "a consultant will send the list"). */
export async function showSchool(c, schoolName) {
  const uniforms = await listProductsBySchool(schoolName);
  c.setState('retail_menu', { parent: true });
  if (!uniforms.length) return c.R(TEMPLATES.RETAIL_SCHOOL_NO_CATALOG, { schoolName });
  return c.R(TEMPLATES.RETAIL_SCHOOL_UNIFORMS, { schoolName, uniforms });
}

/** Several schools match what was typed — let the client pick. */
export function showSchoolMatches(c, schools) {
  c.setState('retail_school_select', { schoolList: schools, parent: true });
  return c.R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
}

const notAnOption = (c) => {
  c.setState('retail_menu');
  return c.say(`Sorry, that's not one of the options. 🙂\n\n${TEMPLATES.RETAIL_MENU()}`);
};

/** retail_menu (also retail_pricing / retail_hours / retail_layby: the shop menu numbers keep working). */
export async function retailMenu(c) {
  if (c.intent.type !== 'menu') {
    const { handleFreeText } = await import('../freeText.js');
    return handleFreeText(c, 'retail');
  }
  switch (c.intent.value) {
    case 1: {
      const products = await listProducts({ activeOnly: true });
      c.setState('retail_pricing');
      return c.R(TEMPLATES.RETAIL_PRODUCT_LIST, { products });
    }
    case 2: {
      const schools = await allSchools();
      c.setState('retail_school_select', { schoolList: schools });
      return c.R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
    }
    case 3:
      c.setState('retail_hours');
      return c.R(TEMPLATES.RETAIL_HOURS);
    case 4:
      // "Is my order ready?" — the client's open orders, no reference needed
      return startTracking(c);
    case 5:
      c.setState('retail_layby');
      return c.R(TEMPLATES.RETAIL_LAYBY);
    case 6:
      c.setState('retail_size_ask');
      return c.R(TEMPLATES.RETAIL_SIZE_ASK);
    default:
      return notAnOption(c);
  }
}

/** True when `text` picks a school from the list (so "9" is a school, not "consultant"). */
export function ownsNumber(c, text) {
  return c.state === 'retail_school_select'
    && /^\d+$/.test(text)
    && Number(text) >= 1
    && Number(text) <= (c.convo.context.schoolList || []).length;
}

export async function retailSchoolSelect(c) {
  const schools = c.convo.context.schoolList || [];
  const text = c.body.trim();
  const num = /^\d+$/.test(text) ? parseInt(text, 10) : NaN;
  if (num >= 1 && num <= schools.length) return showSchool(c, schools[num - 1]);
  if (!/^\d+$/.test(text)) {
    const matches = await findSchools(text);
    if (matches.length === 1) return showSchool(c, matches[0]);
    if (matches.length > 1) return showSchoolMatches(c, matches);
  }
  return c.R(TEMPLATES.RETAIL_SCHOOL_SELECT, { schools });
}

/** Size availability via the AI FAQ. */
export async function retailSizeAsk(c) {
  const products = await listProducts({ activeOnly: true });
  const result = (await answerFaq(c.body, {
    products,
    hoursText: TEMPLATES.RETAIL_HOURS(),
    laybyText: TEMPLATES.RETAIL_LAYBY(),
  })) || {};

  if (result.type === 'answer' && typeof result.text === 'string' && result.text.trim()) {
    return c.R(TEMPLATES.RETAIL_SIZE_ANSWER, { text: result.text });
  }
  return c.R(TEMPLATES.RETAIL_SIZE_UNKNOWN);
}

// Older conversations waiting for a reference here: show their open orders instead.
export const retailCollectionAsk = (c) => startTracking(c);
