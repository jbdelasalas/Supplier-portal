import type { Config } from 'tailwindcss';
import defaultTheme from 'tailwindcss/defaultTheme';

// Brand colours sampled from the Art Fresh badge itself: red #f01010 and
// yellow #f0e000. The scales are built around those two so buttons, links and
// accents match the printed logo rather than approximating it.
const config: Config = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        // Outfit, matching the ERP. The CSS variable is set by next/font in
        // layout.tsx; the system stack behind it covers the load window.
        sans: ['var(--font-outfit)', ...defaultTheme.fontFamily.sans],
      },
      colors: {
        brand: {
          50:  '#fef2f2', 100: '#fee2e2', 200: '#fecaca', 300: '#fca5a5',
          400: '#f87171', 500: '#f01010', 600: '#d40d0d', 700: '#b00b0b',
          800: '#910f0f', 900: '#781212',
        },
        accent: {
          50:  '#fefce8', 100: '#fef9c3', 200: '#fef08a', 300: '#fde047',
          400: '#f7e600', 500: '#f0e000', 600: '#ccbe00', 700: '#a39700',
          800: '#867c00', 900: '#726a00',
        },
      },
    },
  },
  plugins: [],
};

export default config;
