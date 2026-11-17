/**
 * Full-page sign-in backdrop: the Braq Uni story.
 * Workshop on the left (a tailor sewing) → uniforms ride the rail across the
 * whole page → the shop on the right (assistant hands the order to a happy
 * mother and child). The sign-in card sits in the middle, on top.
 *
 * Pure SVG + CSS (transform/opacity only). The backdrop is always the dark
 * workshop, so it uses fixed colours rather than theme tokens. With reduced
 * motion the scene rests in a composed still frame.
 */

const CSS = `
.braq-scene-layer { position: fixed; inset: 0; overflow: hidden; pointer-events: none;
  background: linear-gradient(180deg, #121216 0%, #18181D 70%); }
.sc-floor { position: absolute; left: 0; right: 0; bottom: 0; height: 9vh; min-height: 56px; background: #202027; }
.sc-floor::before { content: ""; position: absolute; left: 0; right: 0; top: 0; height: 2px; opacity: 0.6;
  background: repeating-linear-gradient(90deg, #C8102E 0 10px, transparent 10px 18px); }
.sc-wall-stitch { position: absolute; left: 0; right: 0; top: 0; height: 100%;
  background: radial-gradient(ellipse at 50% 35%, rgba(200,16,46,0.08), transparent 60%); }

.sc-rail { position: absolute; left: 0; right: 0; top: 7vh; height: 4px; background: #6B6B78; border-radius: 2px; }
.sc-rail::before, .sc-rail::after { content: ""; position: absolute; top: -7vh; width: 5px; height: 7vh; background: #55555F; }
.sc-rail::before { left: 6vw; } .sc-rail::after { right: 6vw; }
.sc-garment { position: absolute; top: calc(7vh - 13px); left: 0; width: 64px; height: 74px; overflow: visible;
  animation: sc-rail-x 15s linear infinite; }
.sc-garment.g2 { animation-delay: -5s; }
.sc-garment.g3 { animation-delay: -10s; }

.sc-side { position: absolute; bottom: max(9vh, 56px); overflow: visible; height: min(50vh, 440px, 28vw); width: auto; }
.sc-workshop { left: 3vw; aspect-ratio: 232 / 250; }
.sc-shop { right: 3vw; aspect-ratio: 230 / 230; }

@media (max-width: 760px) {
  .sc-side { height: min(42vw, 30vh); }
  .sc-workshop { left: 2vw; }
  .sc-shop { right: 2vw; }
  .sc-garment { width: 44px; height: 52px; top: calc(7vh - 9px); }
}

.braq-scene-layer .needle   { animation: sc-needle 0.32s ease-in-out infinite alternate; }
.braq-scene-layer .stitches { animation: sc-feed 1.2s linear infinite; }
.braq-scene-layer .spin     { transform-box: fill-box; transform-origin: center; animation: sc-spin 1.1s linear infinite; }
.braq-scene-layer .hands    { animation: sc-guide 1.2s ease-in-out infinite alternate; }
.braq-scene-layer .tailor-head { transform-box: fill-box; transform-origin: 50% 90%; animation: sc-nod 2.4s ease-in-out infinite; }
.braq-scene-layer .sway     { transform-box: fill-box; transform-origin: 50% 0; animation: sc-sway 1.8s ease-in-out infinite alternate; }
.braq-scene-layer .handover { transform-box: view-box; transform-origin: 462px 176px; animation: sc-handover 3.2s ease-in-out infinite; }
.braq-scene-layer .receive  { transform-box: view-box; transform-origin: 556px 182px; animation: sc-receive 3.2s ease-in-out infinite; }
.braq-scene-layer .jump     { animation: sc-jump 1.6s cubic-bezier(0.34, 1.3, 0.64, 1) infinite; }
.braq-scene-layer .jump-shadow { transform-box: fill-box; transform-origin: center; animation: sc-shadow 1.6s cubic-bezier(0.34, 1.3, 0.64, 1) infinite; }
.braq-scene-layer .heart    { opacity: 0; animation: sc-heart 3.6s ease-out infinite; }
.braq-scene-layer .heart.h2 { animation-delay: -1.2s; }
.braq-scene-layer .heart.h3 { animation-delay: -2.4s; }
.braq-scene-layer .blink    { transform-box: fill-box; transform-origin: center; animation: sc-blink 4.2s infinite; }
.braq-scene-layer .blink.b2 { animation-delay: -1.3s; }
.braq-scene-layer .blink.b3 { animation-delay: -2.7s; }
.braq-scene-layer .blink.b4 { animation-delay: -0.6s; }
.braq-scene-layer .breathe  { transform-box: fill-box; transform-origin: 50% 100%; animation: sc-breathe 3s ease-in-out infinite; }

@keyframes sc-rail-x   { from { transform: translateX(-80px); } to { transform: translateX(calc(100vw + 20px)); } }
@keyframes sc-needle   { from { transform: translateY(-3px); } to { transform: translateY(3px); } }
@keyframes sc-feed     { to { stroke-dashoffset: -26; } }
@keyframes sc-spin     { to { transform: rotate(360deg); } }
@keyframes sc-guide    { from { transform: translateX(-2px); } to { transform: translateX(2px); } }
@keyframes sc-nod      { 0%, 100% { transform: rotate(0deg); } 50% { transform: rotate(3deg); } }
@keyframes sc-sway     { from { transform: rotate(-4deg); } to { transform: rotate(4deg); } }
@keyframes sc-handover { 0%, 100% { transform: rotate(-7deg); } 45%, 60% { transform: rotate(5deg); } }
@keyframes sc-receive  { 0%, 100% { transform: rotate(6deg); }  45%, 60% { transform: rotate(-4deg); } }
@keyframes sc-jump {
  0%, 100% { transform: translateY(0); }
  45%      { transform: translateY(-14px); }
  70%      { transform: translateY(0); }
}
@keyframes sc-shadow {
  0%, 100% { transform: scaleX(1);   opacity: 0.55; }
  45%      { transform: scaleX(0.6); opacity: 0.25; }
  70%      { transform: scaleX(1);   opacity: 0.55; }
}
@keyframes sc-heart {
  0%   { transform: translateY(0) scale(0.6);    opacity: 0; }
  15%  { opacity: 1; }
  100% { transform: translateY(-46px) scale(1.1); opacity: 0; }
}
@keyframes sc-blink    { 0%, 92%, 100% { transform: scaleY(1); } 95% { transform: scaleY(0.1); } }
@keyframes sc-breathe  { 0%, 100% { transform: scaleY(1); } 50% { transform: scaleY(1.025); } }

@media (prefers-reduced-motion: reduce) {
  .braq-scene-layer * { animation: none !important; }
  .braq-scene-layer .sc-garment.g1 { left: 14vw; }
  .braq-scene-layer .sc-garment.g2 { left: 47vw; }
  .braq-scene-layer .sc-garment.g3 { left: 80vw; }
  .braq-scene-layer .heart { opacity: 0.9; }
}
`

const SKIN = { tailor: '#6B4226', seller: '#4A2C1A', mother: '#8D5A3B', child: '#5A3825' }
const RED = '#C8102E'
const NAVY = '#22305A'
const CREAM = '#F2EDE4'
const INK = '#1A1A1A'

function Garment({ className, fill, trim, tie }) {
  return (
    <svg className={`sc-garment ${className}`} viewBox="-22 -12 44 52" aria-hidden="true">
      <g className="sway">
        <path d="M0 -6 C0 -11 6 -11 6 -7" stroke="#9AA0A6" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        <path d="M-16 6 L0 -2 L16 6" stroke="#9AA0A6" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
        <path d="M-13 6 L-5 2 L5 2 L13 6 L20 15 L14 20 L12 15 L12 38 L-12 38 L-12 15 L-14 20 L-20 15 Z" fill={fill} />
        {trim && <path d="M-5 2 L0 9 L5 2" stroke={trim} strokeWidth="2" fill="none" strokeLinejoin="round" />}
        {tie && <path d="M0 8 L-2.5 11 L0 24 L2.5 11 Z" fill={tie} />}
      </g>
    </svg>
  )
}

function Heart({ x, y, className }) {
  return (
    <g transform={`translate(${x} ${y})`}>
      <path className={className} d="M0 3 C0 -1.5 -6 -1.5 -6 3 C-6 7 0 10 0 13 C0 10 6 7 6 3 C6 -1.5 0 -1.5 0 3 Z" fill={RED} />
    </g>
  )
}

/** Left: a tailor in a doek sewing at her machine. */
function Workshop() {
  return (
    <svg className="sc-side sc-workshop" viewBox="10 50 232 250" aria-hidden="true">
      {/* Fabric bolts on the shelf */}
      <rect x="22" y="86" width="150" height="6" rx="3" fill="#34343E" />
      {[['#2B3A67', 26], [RED, 58], ['#E9E4DA', 90], ['#2E8B6E', 122]].map(([c, x]) => (
        <g key={x}>
          <rect x={x} y="62" width="28" height="24" rx="6" fill={c} />
          <ellipse cx={x + 28} cy="74" rx="4" ry="12" fill={c} opacity="0.7" />
        </g>
      ))}

      {/* Table */}
      <rect x="28" y="206" width="196" height="9" rx="3" fill="#A0704E" />
      <rect x="36" y="215" width="8" height="85" fill="#7A4E33" />
      <rect x="208" y="215" width="8" height="85" fill="#7A4E33" />

      {/* Sewing machine */}
      <rect x="106" y="194" width="100" height="12" rx="3" fill="#E8E2D6" />
      <rect x="178" y="150" width="22" height="46" rx="5" fill="#E8E2D6" />
      <rect x="110" y="146" width="90" height="18" rx="9" fill="#E8E2D6" />
      <rect x="110" y="146" width="26" height="40" rx="6" fill="#E8E2D6" />
      <rect x="140" y="152" width="34" height="4" rx="2" fill={RED} />
      <path d="M162 136 Q142 128 124 150" stroke={RED} strokeWidth="1.2" fill="none" />
      <rect className="spin" x="156" y="132" width="10" height="13" rx="2.5" fill={RED} />
      <circle cx="203" cy="162" r="10" fill="#CFC8BA" />
      <g className="spin">
        <circle cx="203" cy="162" r="10" fill="none" />
        <line x1="203" y1="153" x2="203" y2="171" stroke="#8C8579" strokeWidth="2" />
        <line x1="194" y1="162" x2="212" y2="162" stroke="#8C8579" strokeWidth="2" />
      </g>
      <rect className="needle" x="121" y="184" width="3" height="10" fill="#9AA0A6" />
      <rect x="116" y="191" width="13" height="3" rx="1" fill="#9AA0A6" />

      {/* Fabric being sewn — the stitches feed through */}
      <rect x="56" y="188" width="86" height="7" rx="2" fill="#2B3A67" />
      <line className="stitches" x1="58" y1="191.5" x2="140" y2="191.5" stroke={CREAM} strokeWidth="1.4" strokeDasharray="6 7" />

      {/* Stool */}
      <rect x="34" y="248" width="56" height="8" rx="4" fill="#5C3B28" />
      <rect x="58" y="256" width="8" height="44" fill="#4A2F20" />

      {/* Tailor */}
      <ellipse cx="80" cy="300" rx="34" ry="4" fill="#000" opacity="0.35" />
      <path d="M58 247 L98 250 L100 294" stroke="#2A2F45" strokeWidth="12" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      <ellipse cx="106" cy="296" rx="10" ry="4.5" fill="#111" />
      <g className="breathe">
        <rect x="46" y="184" width="42" height="66" rx="17" fill="#E0A526" />
        <rect x="60" y="204" width="27" height="42" rx="7" fill={CREAM} opacity="0.92" />
      </g>
      <g className="hands">
        <path d="M76 200 Q96 220 100 196" stroke="#55331D" strokeWidth="7.5" fill="none" strokeLinecap="round" />
        <path d="M82 197 Q102 212 113 193" stroke={SKIN.tailor} strokeWidth="8" fill="none" strokeLinecap="round" />
      </g>
      <rect x="64" y="174" width="11" height="13" fill={SKIN.tailor} />
      <g className="tailor-head">
        <circle cx="70" cy="160" r="18" fill={SKIN.tailor} />
        <ellipse cx="57" cy="163" rx="3" ry="4.5" fill="#5A361F" />
        <circle cx="57" cy="171" r="2.2" fill="#F5C542" />
        {/* Doek (headwrap) */}
        <ellipse cx="70" cy="147" rx="21" ry="12" fill="#D4462F" />
        <circle cx="83" cy="134" r="7.5" fill="#D4462F" />
        <circle cx="76" cy="132" r="5" fill="#B9361F" />
        {[[60, 144], [70, 140], [80, 146], [66, 151], [86, 135]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="1.6" fill="#F5C542" />
        ))}
        <g className="blink"><circle cx="75" cy="163" r="2" fill={INK} /><circle cx="83" cy="163" r="2" fill={INK} /></g>
        <path d="M75 170 Q80 174.5 85 170" stroke="#2A160C" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      </g>
    </svg>
  )
}

/** Right: the shop counter, the assistant, and a happy mother and child. */
function Shop() {
  return (
    <svg className="sc-side sc-shop" viewBox="372 70 230 230" aria-hidden="true">
      {/* Awning */}
      {Array.from({ length: 10 }, (_, i) => (
        <rect key={`s${i}`} x={384 + i * 21} y="84" width="21" height="24" fill={i % 2 ? CREAM : RED} />
      ))}
      {Array.from({ length: 10 }, (_, i) => (
        <circle key={`c${i}`} cx={394.5 + i * 21} cy="108" r="10.5" fill={i % 2 ? CREAM : RED} />
      ))}
      <rect x="380" y="78" width="218" height="7" rx="3" fill="#34343E" />

      {/* Assistant (behind the counter) */}
      <g className="breathe">
        <rect x="424" y="164" width="42" height="56" rx="15" fill={RED} />
        <path d="M437 166 L445 176 L453 166" stroke={CREAM} strokeWidth="3" fill="none" strokeLinejoin="round" />
      </g>
      <rect x="440" y="154" width="10" height="12" fill={SKIN.seller} />
      <circle cx="445" cy="140" r="17" fill={SKIN.seller} />
      <ellipse cx="429" cy="142" rx="3" ry="4.5" fill="#3A2214" />
      <path d="M428 137 Q429 120 445 121 Q462 120 462 137 Q456 128 445 128 Q434 128 428 137 Z" fill="#121212" />
      <g className="blink b2"><circle cx="450" cy="141" r="2" fill={INK} /><circle cx="458" cy="141" r="2" fill={INK} /></g>
      <path d="M449 148 Q454 152.5 459 148" stroke="#1A0C06" strokeWidth="1.7" fill="none" strokeLinecap="round" />
      <path d="M430 178 Q426 200 440 212" stroke="#3A2214" strokeWidth="8" fill="none" strokeLinecap="round" />

      {/* Hand-over: the assistant's arm with the Braq bag */}
      <g className="handover">
        <path d="M460 176 Q480 186 496 183" stroke={SKIN.seller} strokeWidth="8" fill="none" strokeLinecap="round" />
        <path d="M499 176 Q506 165 513 176" stroke={RED} strokeWidth="2" fill="none" />
        <rect x="494" y="175" width="25" height="29" rx="3" fill={CREAM} />
        <circle cx="506.5" cy="190" r="6" fill="#0E0E10" stroke={RED} strokeWidth="1.2" strokeDasharray="2 1.6" />
      </g>

      {/* Counter */}
      <rect x="402" y="194" width="26" height="18" rx="2.5" fill="#DCD6CA" />
      <rect x="405" y="197" width="20" height="6" rx="1" fill="#1E7F4F" />
      <rect x="396" y="211" width="128" height="9" rx="3" fill="#A0704E" />
      <rect x="402" y="220" width="116" height="80" fill="#7A4E33" />
      <circle cx="460" cy="258" r="17" fill="#0E0E10" stroke={RED} strokeWidth="1.6" strokeDasharray="3 2.5" />
      <text x="460" y="261" textAnchor="middle" fontSize="8.5" fontWeight="700" fill={CREAM} style={{ fontFamily: 'inherit' }}>Braq</text>

      {/* Mother */}
      <ellipse cx="568" cy="300" rx="22" ry="3.5" fill="#000" opacity="0.35" />
      <rect x="557" y="262" width="8" height="36" rx="3" fill={SKIN.mother} />
      <rect x="571" y="262" width="8" height="36" rx="3" fill={SKIN.mother} />
      <ellipse cx="560" cy="298" rx="7" ry="3.5" fill="#111" />
      <ellipse cx="575" cy="298" rx="7" ry="3.5" fill="#111" />
      <g className="breathe">
        <path d="M552 172 Q568 164 584 172 L593 266 Q568 273 543 266 Z" fill="#2E8B6E" />
        {[[556, 190], [574, 184], [566, 206], [584, 214], [552, 232], [572, 240], [588, 252], [560, 256]].map(([x, y]) => (
          <circle key={`${x}-${y}`} cx={x} cy={y} r="2.4" fill="#F5C542" opacity="0.85" />
        ))}
      </g>
      <g className="receive">
        <path d="M556 182 Q537 194 520 189" stroke={SKIN.mother} strokeWidth="7" fill="none" strokeLinecap="round" />
      </g>
      <rect x="563" y="154" width="10" height="13" fill={SKIN.mother} />
      <path d="M580 136 L588 192 M584 134 L593 186 M576 140 L582 196" stroke="#1A1A1A" strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="588" cy="193" r="2" fill="#F5C542" />
      <circle cx="593" cy="187" r="2" fill="#F5C542" />
      <circle cx="582" cy="197" r="2" fill="#F5C542" />
      <circle cx="568" cy="141" r="16" fill={SKIN.mother} />
      <path d="M552 141 Q552 121 568 121 Q586 121 585 141 Q578 131 568 131 Q558 131 552 141 Z" fill="#1A1A1A" />
      <circle cx="581" cy="148" r="2.1" fill="#F5C542" />
      <g className="blink b3"><circle cx="557" cy="143" r="2" fill={INK} /><circle cx="564" cy="143" r="2" fill={INK} /></g>
      <path d="M555 150 Q560 154.5 565 150" stroke="#3A1A0C" strokeWidth="1.7" fill="none" strokeLinecap="round" />

      {/* Child in a new school uniform, jumping for joy */}
      <ellipse className="jump-shadow" cx="528" cy="300" rx="15" ry="3" fill="#000" opacity="0.55" />
      <g className="jump">
        <rect x="520" y="278" width="7" height="20" rx="2" fill={NAVY} />
        <rect x="530" y="278" width="7" height="20" rx="2" fill={NAVY} />
        <ellipse cx="523" cy="298" rx="5.5" ry="3" fill="#111" />
        <ellipse cx="534" cy="298" rx="5.5" ry="3" fill="#111" />
        <path d="M515 250 L504 233 M541 250 L552 233" stroke={SKIN.child} strokeWidth="5" strokeLinecap="round" />
        <rect x="513" y="242" width="31" height="38" rx="10" fill={NAVY} />
        <path d="M522 243 L528.5 256 L535 243 Z" fill={CREAM} />
        <path d="M528.5 247 L526 250 L528.5 261 L531 250 Z" fill={RED} />
        <circle cx="538" cy="259" r="2.6" fill="#F5C542" />
        <circle cx="517" cy="214" r="7.5" fill="#151515" />
        <circle cx="540" cy="214" r="7.5" fill="#151515" />
        <circle cx="528.5" cy="228" r="13" fill={SKIN.child} />
        <path d="M516 225 Q517 213 528.5 213 Q540 213 541 225 Q535 219 528.5 219 Q522 219 516 225 Z" fill="#151515" />
        <circle cx="520" cy="233" r="2.6" fill={RED} opacity="0.3" />
        <circle cx="537" cy="233" r="2.6" fill={RED} opacity="0.3" />
        <g className="blink b4"><circle cx="524" cy="228" r="1.8" fill={INK} /><circle cx="533" cy="228" r="1.8" fill={INK} /></g>
        <path d="M523.5 233 Q528.5 240.5 533.5 233 Z" fill="#2A120A" />
      </g>

      {/* Happiness */}
      <Heart x={506} y={214} className="heart" />
      <Heart x={530} y={196} className="heart h2" />
      <Heart x={548} y={216} className="heart h3" />
    </svg>
  )
}

export default function LoginScene() {
  return (
    <div
      className="braq-scene-layer"
      role="img"
      aria-label="A tailor sews school uniforms in the workshop, the finished garments travel along a rail to the Braq Uni shop, and a smiling shop assistant hands the order to a happy mother and her excited child in a new school uniform."
    >
      <style>{CSS}</style>
      <div className="sc-wall-stitch" />
      <div className="sc-rail" />
      <Garment className="g1" fill={CREAM} trim="#C9C2B4" tie={RED} />
      <Garment className="g2" fill={NAVY} trim={CREAM} />
      <Garment className="g3" fill={RED} trim={CREAM} />
      <div className="sc-floor" />
      <Workshop />
      <Shop />
    </div>
  )
}
