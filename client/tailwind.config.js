/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        "mines-blue": "#21314d",
        "mines-gold": "#c5b358",
        "mines-light-blue": "#4a6fa5",
      },
    },
  },
  plugins: [],
};
