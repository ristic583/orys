/**
 * Orys mark, "Always moving": three steps going forward on their own, the newest in lime.
 * The favicon (web/public/favicon.svg) uses the same three chevrons.
 */
const CHEVRONS = ["#7a4dff", "#a387ff", "#d4f26a"];

/** The lockup used in the top bar: chevrons sized to the capitals and sitting on the same baseline. */
export function Brand() {
  return (
    <span className="brand-lockup">
      <svg className="brand-chevrons" viewBox="0 0 30 20" aria-hidden="true">
        <g fill="none" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round">
          {CHEVRONS.map((c, i) => (
            <path key={c} d={`M${2 + i * 9} 2l8 8-8 8`} stroke={c} />
          ))}
        </g>
      </svg>
      <span className="brand-word">Orys</span>
    </span>
  );
}
