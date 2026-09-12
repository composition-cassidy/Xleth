// Custom quick-window glyphs for Timeline / Piano Roll / Mixer / FX Graph,
// replacing their lucide-react stand-ins. All non-blue ink uses currentColor
// so it follows the same brightness-driven foreground token as every other
// icon in the top bar and titlebar launcher row (see appearanceTheme.js).
// FX Graph's stroke is pinned to --theme-accent instead of the shipped
// #008ed0, per the "blue -> accent, FX Graph only" rule; Piano Roll's blue
// key blocks are decorative and stay hardcoded. FX Graph's "screen" panel
// is pinned to --theme-bg-surface (the inverse-polarity anchor of
// --theme-text) so the "FX" lettering drawn on top of it stays legible at
// every brightness setting instead of collapsing into the same color.
import type { SVGProps } from 'react';

export type GlyphIconProps = SVGProps<SVGSVGElement> & { size?: number | string };

export function TimelineGlyphIcon({ size = 24, strokeWidth: _strokeWidth, ...rest }: GlyphIconProps) {
  return (
    <svg viewBox="0 0 2095.66 1865.6" width={size} height={size} aria-hidden="true" {...rest}>
      <rect fill="currentColor" stroke="currentColor" strokeMiterlimit="10" x="43.91" y="211.5" width="464.7" height="130.68" />
      <rect fill="currentColor" stroke="currentColor" strokeMiterlimit="10" x="578.6" y=".5" width="464.7" height="130.68" />
      <rect fill="currentColor" stroke="currentColor" strokeMiterlimit="10" x="1075.44" y="488.69" width="464.7" height="130.68" />
      <rect fill="currentColor" stroke="currentColor" strokeMiterlimit="10" x="1585.34" y=".5" width="464.7" height="130.68" />
      <line fill="none" stroke="currentColor" strokeWidth="32" strokeMiterlimit="10" y1="765.88" x2="2095.66" y2="765.88" />
      <rect fill="none" stroke="currentColor" strokeWidth="25" strokeMiterlimit="10" x="41.53" y="893.1" width="2023.94" height="960" />
      <line fill="none" stroke="currentColor" strokeWidth="25" strokeMiterlimit="10" x1="41.53" y1="1136.24" x2="2065.48" y2="1136.24" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="148.5" y1="1171.61" x2="148.5" y2="1813.01" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="231.31" y1="1253.36" x2="231.31" y2="1731.26" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="314.11" y1="1401.13" x2="314.11" y2="1583.49" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="396.92" y1="1304.71" x2="396.92" y2="1679.91" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="479.72" y1="1370.74" x2="479.72" y2="1613.88" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="562.53" y1="1373.88" x2="562.53" y2="1610.74" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="645.34" y1="1373.88" x2="645.34" y2="1610.74" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="728.14" y1="1583.49" x2="728.14" y2="1401.13" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="810.95" y1="1364.97" x2="810.95" y2="1619.65" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="893.76" y1="1370.74" x2="893.76" y2="1613.88" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="976.56" y1="1576.68" x2="976.56" y2="1407.94" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1059.37" y1="1399.04" x2="1059.37" y2="1585.59" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1142.17" y1="1585.18" x2="1142.17" y2="1399.44" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1224.98" y1="1460.61" x2="1224.98" y2="1524.01" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1307.79" y1="1451.96" x2="1307.79" y2="1532.66" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1390.59" y1="1445.88" x2="1390.59" y2="1538.74" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1473.4" y1="1506.26" x2="1473.4" y2="1478.37" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1556.21" y1="1481.83" x2="1556.21" y2="1502.79" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1639.01" y1="1481.83" x2="1639.01" y2="1502.79" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="193.45" y1="1735.45" x2="193.45" y2="1249.17" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="276.26" y1="1673.48" x2="276.26" y2="1311.14" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="359.07" y1="1561.44" x2="359.07" y2="1423.18" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="441.87" y1="1634.54" x2="441.87" y2="1350.08" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="524.68" y1="1584.48" x2="524.68" y2="1400.14" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="607.48" y1="1582.1" x2="607.48" y2="1402.52" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="690.29" y1="1582.1" x2="690.29" y2="1402.52" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="773.1" y1="1423.18" x2="773.1" y2="1561.44" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="855.9" y1="1588.85" x2="855.9" y2="1395.77" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="938.71" y1="1584.48" x2="938.71" y2="1400.14" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1021.52" y1="1428.35" x2="1021.52" y2="1556.27" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1104.32" y1="1563.03" x2="1104.32" y2="1421.59" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1187.13" y1="1421.9" x2="1187.13" y2="1562.72" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1269.93" y1="1516.35" x2="1269.93" y2="1468.27" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1352.74" y1="1522.9" x2="1352.74" y2="1461.72" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1435.55" y1="1527.52" x2="1435.55" y2="1457.11" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1518.35" y1="1481.74" x2="1518.35" y2="1502.88" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1601.16" y1="1500.26" x2="1601.16" y2="1484.36" />
      <line fill="none" stroke="currentColor" strokeWidth="29" strokeMiterlimit="10" x1="1683.97" y1="1500.26" x2="1683.97" y2="1484.36" />
    </svg>
  );
}

export function MixerGlyphIcon({ size = 24, strokeWidth: _strokeWidth, ...rest }: GlyphIconProps) {
  return (
    <svg viewBox="0 0 1672.72 2106.98" width={size} height={size} aria-hidden="true" {...rest}>
      <defs>
        <linearGradient id="xleth-mixer-icon-gradient" x1="264.39" y1="2030.08" x2="264.39" y2="330.68" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#fff" />
          <stop offset="0" stopColor="#2fa958" />
          <stop offset=".46" stopColor="#dbbc45" />
          <stop offset=".83" stopColor="#dc4e34" />
        </linearGradient>
      </defs>
      <rect fill="none" stroke="currentColor" strokeWidth="44" strokeMiterlimit="10" x="22" y="22" width="478.37" height="2062.98" rx="18.38" ry="18.38" />
      <line fill="none" stroke="currentColor" strokeWidth="31" strokeMiterlimit="10" x1="878.81" y1="22" x2="878.81" y2="2084.98" />
      <line fill="none" stroke="currentColor" strokeWidth="40" strokeMiterlimit="10" x1="62.58" y1="250.15" x2="459.8" y2="250.15" />
      <g>
        <path fill="url(#xleth-mixer-icon-gradient)" d="M113.83,2030.08c-10.94,0-19.84-8.9-19.84-19.84V350.53c0-10.94,8.9-19.84,19.84-19.84h130.28c.35,0,.63.28.63.63v345.96c0,27.92,22.71,50.63,50.63,50.63h138.82c.35,0,.63.28.63.63v1281.71c0,10.95-8.91,19.85-19.85,19.85H113.83Z" />
        <path fill="none" stroke="currentColor" strokeWidth="44" strokeMiterlimit="10" d="M113.83,2030.08c-10.94,0-19.84-8.9-19.84-19.84V350.53c0-10.94,8.9-19.84,19.84-19.84h130.28c.35,0,.63.28.63.63v345.96c0,27.92,22.71,50.63,50.63,50.63h138.82c.35,0,.63.28.63.63v1281.71c0,10.95-8.91,19.85-19.85,19.85H113.83Z" />
      </g>
      <line fill="none" stroke="currentColor" strokeWidth="44" strokeMiterlimit="10" x1="1441.78" y1="533.55" x2="1441.78" y2="1575.29" />
      <rect fill="none" stroke="currentColor" strokeWidth="44" strokeMiterlimit="10" x="1245.06" y="171.4" width="393.45" height="362.15" rx="49.02" ry="49.02" />
      <line fill="none" stroke="currentColor" strokeWidth="44" strokeMiterlimit="10" x1="1441.78" y1="22" x2="1441.78" y2="171.4" />
      <line fill="none" stroke="currentColor" strokeWidth="37" strokeMiterlimit="10" x1="1316.59" y1="271.7" x2="1566.97" y2="271.7" />
      <line fill="none" stroke="currentColor" strokeWidth="37" strokeMiterlimit="10" x1="1316.59" y1="349.41" x2="1566.97" y2="349.41" />
      <line fill="none" stroke="currentColor" strokeWidth="37" strokeMiterlimit="10" x1="1316.59" y1="436.97" x2="1566.97" y2="436.97" />
      <circle fill="none" stroke="currentColor" strokeWidth="69" strokeMiterlimit="10" cx="1441.78" cy="1856.54" r="196.44" />
      <line fill="none" stroke="currentColor" strokeWidth="31" strokeMiterlimit="10" x1="938.15" y1="22" x2="938.15" y2="2084.98" />
    </svg>
  );
}

export function PianoRollGlyphIcon({ size = 24, strokeWidth: _strokeWidth, ...rest }: GlyphIconProps) {
  return (
    <svg viewBox="0 0 2107.41 1766.66" width={size} height={size} aria-hidden="true" {...rest}>
      <rect fill="none" stroke="currentColor" strokeWidth="32" strokeMiterlimit="10" x="16" y="16" width="2075.41" height="1734.66" rx="73.96" ry="73.96" />
      <line fill="none" stroke="currentColor" strokeWidth="14" strokeMiterlimit="10" x1="16" y1="1331.57" x2="2084.33" y2="1331.57" />
      <line fill="none" stroke="currentColor" strokeWidth="14" strokeMiterlimit="10" x1="22.07" y1="1010.48" x2="2090.4" y2="1010.48" />
      <line fill="none" stroke="currentColor" strokeWidth="14" strokeMiterlimit="10" x1="16" y1="656.02" x2="2084.33" y2="656.02" />
      <line fill="none" stroke="currentColor" strokeWidth="14" strokeMiterlimit="10" x1="16" y1="348.48" x2="2084.33" y2="348.48" />
      <line fill="none" stroke="currentColor" strokeWidth="32" strokeMiterlimit="10" x1="885.69" y1="10.4" x2="885.69" y2="1750.66" />
      <rect fill="currentColor" x="22.69" y="1017.25" width="863" height="307.54" />
      <rect fill="currentColor" x="22.69" y="348.48" width="863" height="307.54" />
      <rect fill="#008ed0" x="933.44" y="690.97" width="461.03" height="278.02" />
      <rect fill="#008ed0" x="1527.86" y="378.6" width="526.98" height="246.5" />
    </svg>
  );
}

export function FxGraphGlyphIcon({ size = 24, strokeWidth: _strokeWidth, ...rest }: GlyphIconProps) {
  return (
    <svg viewBox="0 0 2109.71 2081.35" width={size} height={size} aria-hidden="true" {...rest}>
      <path fill="none" stroke="var(--theme-accent)" strokeWidth="33" strokeMiterlimit="10" d="M826.76,303.9c103.44,10.06,274.54,20.63,341.1,105.27,16.62,22.25,19.52,49.47,6.79,74.37-29.06,55.05-103.11,89.83-169.25,114.32-157.77,56.93-338.66,65.04-492.06,133.52-52.94,23.46-122.13,65.69-137.55,114.52-31.03,111.65,192.57,147.26,274.4,154.82,78.7,7.98,159.46,9.01,238.84,9.42,144.48.39,288.96-.23,433.43,0,105.95.64,219.94,1.93,321.41,27.97,100.2,24.4,192.17,88.88,91.32,179.12-47.12,40.1-95.28,62.18-159.13,86.29-30.03,10.9-60.61,20.22-91.55,28.68-148.73,41.51-325.97,64.35-458.24,141.35-43.56,26.45-252.5,127.5-191.08,219.95,71.23,107.23,239.88,55.07,327.67,65.13" />
      <path fill="currentColor" d="M414.61,186.18H30.55c-16.87,0-30.55,13.68-30.55,30.55v209.32c0,16.87,13.68,30.55,30.55,30.55h386.59c16.87,0,30.55,13.68,30.55,30.55v121.81c0,26.66,31.77,40.53,51.32,22.4l326.41-302.62c13.46-12.48,12.96-33.92-1.08-45.76L497.36,7.25c-19.69-16.61-49.84-2.88-50.24,22.88l-1.97,125.98c-.26,16.68-13.86,30.07-30.55,30.07Z" />
      <path fill="none" stroke="currentColor" strokeWidth="32" strokeMiterlimit="10" d="M1740.81,2062.84c-5.04,0-12.14-3.72-12.14-12v-127.32c0-28.64-23.3-51.93-51.93-51.93h-404.08c-6.58,0-11.93-5.35-11.93-11.93v-218.79c0-6.58,5.35-11.93,11.93-11.93h401.44c28.19,0,51.49-22.93,51.92-51.12l2.06-131.68c.13-8.14,7.15-11.8,12.1-11.8,2.74,0,5.27.96,7.53,2.87l341.77,288.21c3.58,3.02,4.19,6.83,4.24,8.84.05,2.01-.39,5.85-3.82,9.03l-341.17,316.31c-2.32,2.15-4.98,3.25-7.91,3.25Z" />
      <path fill="none" stroke="currentColor" strokeWidth="32" strokeMiterlimit="10" strokeLinecap="round" d="M1501.95,2065.35c-441.49,0-463.37-667.52.74-662.86" />
      <rect fill="var(--theme-bg-surface)" x="573.77" y="654.89" width="1002.6" height="673.11" rx="16.85" ry="16.85" />
      <text fontFamily="NeuzeitGro-Bol, 'Neuzeit Grotesk'" fontSize="576.73" fill="currentColor" transform="translate(765.9579 1194.496) scale(1.0229 1)">
        <tspan x="0" y="0">FX</tspan>
      </text>
    </svg>
  );
}
