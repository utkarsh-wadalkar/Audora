/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        audora: {
          900: '#1a0b2e',
          800: '#2d1b4e',
          700: '#432c7a',
          600: '#5b3fa0',
          500: '#7c5cbf',
          400: '#9f8ad9',
          300: '#c4b5f0',
          100: '#f0ebfa',
        },
      },
    },
  },
  plugins: [],
};
