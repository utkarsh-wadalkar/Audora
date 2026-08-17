/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Brand ramp. Violet is the accent spine; fuchsia only pairs with it
        // in the wordmark gradient.
        audora: {
          950: '#120726',
          900: '#1a0b2e',
          800: '#2d1b4e',
          700: '#432c7a',
          600: '#5b3fa0',
          500: '#7c5cbf',
          400: '#9f8ad9',
          300: '#c4b5f0',
          100: '#f0ebfa',
        },
        // Layered dark surfaces. `void` matches electron/main.js backgroundColor
        // so first paint never flashes a different dark.
        surface: {
          void: '#0a0a0f',
          base: '#0e0e16',
          raised: '#12121a',
          lifted: '#181822',
        },
        // Analog panel tones for the radio-style download console.
        console: {
          shell: '#2a2d3a',
          shellDark: '#212431',
          readout: '#0d1a14',
          readoutText: '#5ef0a8',
          amber: '#f0a85e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
        mono: ['JetBrains Mono', 'Cascadia Code', 'Consolas', 'ui-monospace', 'monospace'],
        // The wordmark face. Self-hosted Caveat (see @font-face in index.css);
        // used only for the "Audora" lockup, never for interface text.
        wordmark: ['Caveat', 'cursive'],
      },
      boxShadow: {
        // Offset + soft blur. No zero-offset halos.
        glass: '0 8px 32px -8px rgba(0, 0, 0, 0.6)',
        lifted: '0 16px 48px -12px rgba(0, 0, 0, 0.7)',
        console: '0 24px 64px -16px rgba(0, 0, 0, 0.8)',
        knob: '0 6px 16px -4px rgba(0, 0, 0, 0.75)',
      },
      transitionTimingFunction: {
        // Exponential ease-out: the one authored curve for the whole app.
        out: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
      keyframes: {
        'slide-in-left': {
          from: { opacity: '0', transform: 'translateX(-24px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        'rise-in': {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'cursor-blink': {
          '0%, 49%': { opacity: '1' },
          '50%, 100%': { opacity: '0' },
        },
        // Indeterminate sweep for work whose duration cannot be measured (a
        // FLAC conversion before ffmpeg reports a count). Deliberately not a
        // percentage: the bar shows activity without claiming progress.
        'console-sweep': {
          '0%': { transform: 'translateX(-100%)' },
          '100%': { transform: 'translateX(300%)' },
        },
      },
      animation: {
        'slide-in-left': 'slide-in-left 520ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'rise-in': 'rise-in 420ms cubic-bezier(0.16, 1, 0.3, 1) both',
        'cursor-blink': 'cursor-blink 1.1s step-end infinite',
        'console-sweep': 'console-sweep 1.4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
