// Single source of truth for colour, spacing and motion. The stylesheet reads these as
// custom properties (applyThemeVars) and the canvas reads the same objects, so a token
// change cannot land on one side only — which is how "one cell colour" turns into forty.

export const Palette = {
  // 黑目 is played on paper: the board is a light sheet with ink squares punched out of it,
  // inside a dark page. These two are the sheet and the ink.
  paper: '#F3EFE6',
  paperVeil: 'rgba(11,11,13,0.10)',
  paperEdge: '#D8D2C4',
  shade: '#121216',
  shadeEdge: '#33333C',
  clueInk: '#141419',

  bgTop: '#0B0B0D',
  bgBottom: '#17171C',
  surface: '#111115',
  surfaceLift: '#1A1A21',
  line: '#2A2A33',
  lineHeavy: '#43434F',
  ink: '#F2F2F5',
  inkDim: 'rgba(242,242,245,0.62)',
  inkFaint: 'rgba(242,242,245,0.34)',

  // Amber is the player's own hand: the stroke being dragged and the cell a hint just named both
  // borrow it, so "this is what you are doing" reads as one idea.
  accent: '#FFC85C',
  accentEdge: '#FFE3A6',
  accentSoft: 'rgba(255,200,92,0.14)',

  // Which of these a number wears is never decided here: the engine says which clues are violated
  // and which are satisfied, and the renderer only paints that answer.
  info: '#7FB2E8',
  pencilStrong: '#9AA3B5',
  pencil: 'rgba(242,242,245,0.30)',

  success: '#3DDC91',
  error: '#FF5C7A',
  warn: '#FFB05C',
  focus: 'rgba(127,178,232,0.16)',
  hint: '#7FB2E8',
};

export const Space = { page: 20, card: 16, inner: 12, gutter: 10 };
export const Radius = { card: 20, button: 12, chip: 8, cell: 3 };

export const Font = {
  title: "700 24px/1.25 -apple-system, 'SF Pro Display', system-ui, sans-serif",
  mono: "'SF Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  sans: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'PingFang SC', system-ui, sans-serif",
};

// Durations obey the 150–350 ms discipline; anything longer blocks the next move.
export const Motion = {
  tap: 150,
  base: 220,
  pop: 260,
  ink: 300,
  win: 900,
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  ease: 'cubic-bezier(0.22, 0.61, 0.36, 1)',
};

// cell: the layout contract. clueScale: how big a number's disc is, inkScale: the hairline weight.
export const Cell = { min: 26, max: 62, clueScale: 0.36, inkScale: 0.055 };

export function applyThemeVars() {
  const root = document.documentElement.style;
  const kebab = (s) => s.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase());
  for (const [k, v] of Object.entries(Palette)) {
    // Arrays get their own loop below, one property per entry.
    if (Array.isArray(v)) continue;
    root.setProperty('--' + kebab(k), v);
  }
  for (const [k, v] of Object.entries(Space)) root.setProperty('--space-' + k, v + 'px');
  for (const [k, v] of Object.entries(Radius)) root.setProperty('--radius-' + k, v + 'px');
  for (const [k, v] of Object.entries(Motion)) {
    if (typeof v === 'number') root.setProperty('--dur-' + kebab(k), v + 'ms');
    else root.setProperty('--ease-' + kebab(k), v);
  }
  root.setProperty('--font-mono', Font.mono);
  root.setProperty('--font-sans', Font.sans);
}

// The system preference is the floor, and the in-game toggle can only add to it — a
// player who asks for less motion should not be overruled by an OS set to "no preference".
let motionReduced = false;

export function setReduceMotion(v) {
  motionReduced = !!v;
}

export const systemPrefersReducedMotion = () =>
  typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const prefersReducedMotion = () => motionReduced || systemPrefersReducedMotion();
