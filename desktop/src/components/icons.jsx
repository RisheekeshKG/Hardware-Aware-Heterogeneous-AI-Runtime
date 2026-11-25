// Inline SVG icons (16px, stroke = currentColor). They replace the letter glyphs
// (R, X, v, ->, +) the UI used as icons. Decorative: the button carries the label.
const Svg = ({ children, size = 16 }) => <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{children}</svg>

export const RefreshIcon = () => <Svg><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" /><path d="M13.5 2.5v3h-3" /></Svg>
export const CloseIcon = () => <Svg><path d="M4 4l8 8M12 4l-8 8" /></Svg>
export const ChevronDownIcon = () => <Svg size={12}><path d="M4 6l4 4 4-4" /></Svg>
export const ArrowRightIcon = () => <Svg size={14}><path d="M3 8h10M9 4l4 4-4 4" /></Svg>
export const PlusIcon = () => <Svg size={14}><path d="M8 3v10M3 8h10" /></Svg>
export const StopIcon = () => <Svg size={14}><rect x="4" y="4" width="8" height="8" rx="1" /></Svg>
export const CopyIcon = () => <Svg size={14}><rect x="5.5" y="5.5" width="8" height="8" rx="1" /><path d="M10.5 3.5v-.5a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h.5" /></Svg>
export const DownIcon = () => <Svg size={14}><path d="M8 3v10M4 9l4 4 4-4" /></Svg>

// Navigation
export const OverviewIcon = () => <Svg><rect x="2.5" y="2.5" width="4.5" height="4.5" /><rect x="9" y="2.5" width="4.5" height="4.5" /><rect x="2.5" y="9" width="4.5" height="4.5" /><rect x="9" y="9" width="4.5" height="4.5" /></Svg>
export const ScriptsIcon = () => <Svg><path d="M5 5L2.5 8 5 11M11 5l2.5 3-2.5 3M9.2 3.5l-2.4 9" /></Svg>
export const DevicesIcon = () => <Svg><rect x="2" y="3" width="12" height="8" rx="1" /><path d="M6 14h4M8 11v3" /></Svg>
export const SettingsIcon = () => <Svg><circle cx="8" cy="8" r="2.2" /><path d="M8 1.8v1.6M8 12.6v1.6M14.2 8h-1.6M3.4 8H1.8M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1M12.4 12.4l-1.1-1.1M4.7 4.7L3.6 3.6" /></Svg>
export const BenchmarksIcon = () => <Svg><path d="M2.5 13.5h11M4.5 11V8M8 11V4.5M11.5 11V6.5" /></Svg>
export const ActivityIcon = () => <Svg><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" /></Svg>
