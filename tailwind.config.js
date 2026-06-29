/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        kai: ['"KaiTi"', '"STKaiti"', '"AR PL UKai CN"', 'serif'],
      },
    },
  },
  plugins: [],
}
