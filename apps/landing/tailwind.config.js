/**
 * Orbit Field — visual system.
 *
 * The palette comes from the product's own subject: ruggedised field
 * instruments and the state machine that actually runs inside the app. Amber
 * is the colour of work queued on a device with no signal; cyan is the colour
 * of work that has reconciled. Those are not decoration — they are the two
 * states the system has, and they carry the page.
 *
 * Deliberately not the warm-cream-and-terracotta or acid-green-on-black that
 * every other technical landing page reaches for. The dark ground is
 * instrument housing at night; the light theme is a printed datasheet, cold
 * rather than papery.
 *
 * **Themes are channels, not variants.** An earlier version had components
 * write `text-paper dark:text-paper`, which put the decision in ~40 places and
 * got it wrong in most of them — light mode rendered near-white headings on a
 * near-white ground, invisible. Semantic names resolving to CSS variables mean
 * a component says what a colour is *for* and the theme decides what it is, so
 * the mistake is unavailable.
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        canvas: 'rgb(var(--canvas) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        hairline: 'rgb(var(--hairline) / <alpha-value>)',
        fg: 'rgb(var(--fg) / <alpha-value>)',
        subtle: 'rgb(var(--subtle) / <alpha-value>)',
        /* Queued, offline, waiting. High-visibility field amber. */
        signal: 'rgb(var(--signal) / <alpha-value>)',
        /* Reconciled with the server. */
        sync: 'rgb(var(--sync) / <alpha-value>)',
        /* The Client Portal's own green, so the architecture diagram shows
           which box is which product rather than colouring them alike. */
        portal: 'rgb(var(--portal) / <alpha-value>)',
      },
      fontFamily: {
        display: ['"Space Grotesk"', 'system-ui', 'sans-serif'],
        sans: ['"IBM Plex Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      letterSpacing: { widest: '0.24em' },
      keyframes: {
        'sync-pulse': { '0%,100%': { opacity: '0.35' }, '50%': { opacity: '1' } },
        sweep: {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(200%)' },
        },
      },
      animation: {
        'sync-pulse': 'sync-pulse 2.4s ease-in-out infinite',
        sweep: 'sweep 3.5s linear infinite',
      },
    },
  },
  plugins: [],
};
