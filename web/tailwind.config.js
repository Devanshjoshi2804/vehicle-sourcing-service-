/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0A0C12",
        panel: "#10141E",
        panel2: "#141A26",
        line: "#222A3A",
        line2: "#2C3548",
        fg: "#E8ECF4",
        muted: "#8A93A6",
        faint: "#5A6275",
        amber: "#FFB020", // dispatch / active brand accent
        go: "#34D399", // accepted / available
        rose: "#FB7185", // declined
        cyan: "#38BDF8", // inbound demand
        violet: "#A78BFA", // confirmed booking
      },
      fontFamily: {
        display: ["Saira", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      keyframes: {
        "ping-ring": {
          "0%": { transform: "scale(0.7)", opacity: "0.7" },
          "100%": { transform: "scale(2.2)", opacity: "0" },
        },
        bar: {
          "0%,100%": { transform: "scaleY(0.3)" },
          "50%": { transform: "scaleY(1)" },
        },
        sweep: {
          "0%": { transform: "rotate(0deg)" },
          "100%": { transform: "rotate(360deg)" },
        },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(6px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "ping-ring": "ping-ring 1.6s cubic-bezier(0,0,0.2,1) infinite",
        bar: "bar 0.9s ease-in-out infinite",
        sweep: "sweep 4s linear infinite",
        "fade-up": "fade-up 0.35s ease-out both",
        "pulse-dot": "pulse-dot 1.2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
