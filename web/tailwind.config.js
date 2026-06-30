/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // coordinated petrol-tinted neutrals (depth, not flat white/gray)
        canvas: "#E8EEEC",
        panel: "#FFFFFF",
        panel2: "#EFF4F2", // inset / raised / inputs
        line: "#D8E4E0",
        line2: "#C4D5CF",
        fg: "#0B1F1B", // deep petrol-ink
        muted: "#4E635E",
        faint: "#8AA09A",
        // deep petrol hero surface
        deep: "#0C2A24",
        deep2: "#103A31",
        // brand petrol + complementary amber signal
        brand: "#0F766E",
        brandDeep: "#0B5A52",
        brandSoft: "#DEEFEB",
        amber: "#E08600", // on-air / counter (signal)
        amberSoft: "#FAEAD1",
        go: "#1B873F", // accepted
        goSoft: "#E1F2E7",
        rose: "#C2412F", // declined
        roseSoft: "#F9E8E4",
        sky: "#0A7EA4", // inbound
        skySoft: "#DEF0F6",
        violet: "#6D4AC0", // confirmed
        violetSoft: "#ECE5F8",
      },
      fontFamily: {
        display: ["'Space Grotesk'", "system-ui", "sans-serif"],
        sans: ["Inter", "system-ui", "sans-serif"],
        mono: ["'JetBrains Mono'", "ui-monospace", "monospace"],
      },
      fontWeight: { 500: "500", 600: "600", 700: "700", 800: "800" },
      boxShadow: {
        card: "0 1px 2px rgba(11,31,27,0.05), 0 6px 18px -8px rgba(11,31,27,0.12)",
        cardhover: "0 2px 4px rgba(11,31,27,0.06), 0 16px 36px -12px rgba(11,31,27,0.22)",
        hero: "0 24px 60px -22px rgba(12,42,36,0.55)",
        lift: "0 2px 6px -1px rgba(11,31,27,0.18), 0 8px 20px -8px rgba(15,118,110,0.35)",
        glow: "0 0 0 4px rgba(15,118,110,0.12)",
      },
      keyframes: {
        "ping-ring": {
          "0%": { transform: "scale(0.8)", opacity: "0.5" },
          "100%": { transform: "scale(2.4)", opacity: "0" },
        },
        bar: { "0%,100%": { transform: "scaleY(0.28)" }, "50%": { transform: "scaleY(1)" } },
        sweep: { "0%": { transform: "rotate(0deg)" }, "100%": { transform: "rotate(360deg)" } },
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(8px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        "pulse-dot": { "0%,100%": { opacity: "1" }, "50%": { opacity: "0.3" } },
        dash: { to: { "stroke-dashoffset": "-16" } },
        // rubber-stamp thud: lands big + askew, settles to rest angle
        "stamp-in": {
          "0%": { opacity: "0", transform: "scale(1.6) rotate(-16deg)" },
          "55%": { opacity: "1", transform: "scale(0.92) rotate(-3deg)" },
          "75%": { transform: "scale(1.04) rotate(-7deg)" },
          "100%": { opacity: "1", transform: "scale(1) rotate(-6deg)" },
        },
        "ticker-in": {
          "0%": { opacity: "0", transform: "translateY(-4px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
      },
      animation: {
        "ping-ring": "ping-ring 1.7s cubic-bezier(0,0,0.2,1) infinite",
        bar: "bar 0.9s ease-in-out infinite",
        sweep: "sweep 4.5s linear infinite",
        "fade-up": "fade-up 0.45s cubic-bezier(0.16,1,0.3,1) both",
        "pulse-dot": "pulse-dot 1.2s ease-in-out infinite",
        dash: "dash 0.6s linear infinite",
        "stamp-in": "stamp-in 0.5s cubic-bezier(0.34,1.56,0.64,1) both",
        "ticker-in": "ticker-in 0.3s ease-out both",
      },
    },
  },
  plugins: [],
};
