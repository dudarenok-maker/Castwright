/* Tailwind theme tokens — keeps DS values out of inline scripts.
   Loaded after the Tailwind CDN; assigns to tailwind.config. */
tailwind.config = {
  theme: {
    extend: {
      colors: {
        canvas:  { DEFAULT: "#FFFDFB", warm: "#FCDED7" },
        ink:     { DEFAULT: "#0F0E0D", soft: "#1A1A1A" },
        peach:   { DEFAULT: "#F79A83", soft: "#FCDED7" },
        magenta: "#A43C6C",
        purple:  { deep: "#3C194F" },
      },
      fontFamily: {
        sans:  ['"General Sans"', '"Neue Montreal"', 'Inter', 'system-ui', 'sans-serif'],
        serif: ['Lora', 'Georgia', 'serif'],
        mono:  ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },
      backgroundImage: {
        /* All gradient + shadow values live in styles.css (CSS custom
           properties). These Tailwind utilities just reference them so
           there's one source of truth. */
        "gradient-cta":            "var(--gradient-cta)",
        "gradient-cta-horizontal": "var(--gradient-cta-horizontal)",
        "gradient-progress":       "var(--gradient-progress)",
        "gradient-hero-wash":      "var(--gradient-hero-wash)",
        "gradient-image-wash":     "var(--gradient-image-wash)",
      },
      boxShadow: {
        card:         "var(--shadow-card)",
        'card-hover': "var(--shadow-card-hover)",
        float:        "var(--shadow-float)",
        drawer:       "var(--shadow-drawer)",
      },
      borderRadius: { sm: "8px", md: "12px", lg: "20px", xl: "28px", "2xl": "40px", "3xl": "56px" },
    },
  },
};
