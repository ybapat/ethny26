/** NyxMark — the nyx logo: a crescent moon (a nod to Nyx, goddess of night)
 * glowing inside a dark "night" tile. Subtle luminous gradient, no noise. */
export function NyxMark() {
  return (
    <span className="brand-mark">
      <svg className="brand-moon" viewBox="0 0 24 24" aria-hidden="true">
        <defs>
          <linearGradient id="nyxMoon" x1="5" y1="2.5" x2="18" y2="22" gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="var(--green-bright)" />
            <stop offset="0.55" stopColor="var(--green)" />
            <stop offset="1" stopColor="var(--green-dim)" />
          </linearGradient>
        </defs>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z" fill="url(#nyxMoon)" />
      </svg>
    </span>
  );
}
