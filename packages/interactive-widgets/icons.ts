// Repository-owned SVG paths. AI chooses names, never SVG markup or URLs.
export const ICON_PATHS: Record<string, string> = {
  server: "M4 3h16v7H4zM4 14h16v7H4zM7 6h.01M7 17h.01M11 6h6M11 17h6",
  database:
    "M4 6c0-5 16-5 16 0s-16 5-16 0v12c0 5 16 5 16 0V6M4 12c0 5 16 5 16 0",
  network: "M9 3h6v6H9zM2 16h6v6H2zM16 16h6v6h-6zM12 9v4M5 16v-3h14v3",
  box: "M3 7l9-5 9 5v10l-9 5-9-5zM3 7l9 5 9-5M12 12v10",
  package: "M3 7l9-5 9 5v10l-9 5-9-5zM3 7l9 5 9-5M12 12v10M8 4l9 5",
  layers: "M2 7l10-5 10 5-10 5zM2 12l10 5 10-5M2 17l10 5 10-5",
  terminal: "M3 4h18v16H3zM6 8l4 4-4 4M13 16h5",
  info: "M12 8h.01M11 11h1v6M12 2a10 10 0 1 0 0 20 10 10 0 1 0 0-20",
  check: "M4 12l5 5L20 6",
  workflow: "M3 3h6v6H3zM15 15h6v6h-6zM9 6h9v9M15 12l3 3 3-3",
  "git-branch":
    "M6 7v10M8 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0M8 19a2 2 0 1 0-4 0 2 2 0 0 0 4 0M20 5a2 2 0 1 0-4 0 2 2 0 0 0 4 0M18 7c0 6-12 2-12 10",
  "brain-circuit":
    "M9 3C4 1 2 8 5 10c-4 4 0 11 4 9V3M15 3c5-2 7 5 4 7 4 4 0 11-4 9V3M9 7h6M9 13h6M9 18h6",
  "refresh-cw": "M20 8a9 9 0 1 0 1 8M20 2v6h-6",
  "rotate-ccw": "M4 8a9 9 0 1 1-1 8M4 2v6h6",
  "arrow-down": "M12 3v18M5 14l7 7 7-7",
  "arrow-up": "M12 21V3M5 10l7-7 7 7",
  "arrow-right": "M3 12h18M14 5l7 7-7 7",
  "arrow-down-up": "M7 3v18M2 16l5 5 5-5M17 21V3M12 8l5-5 5 5",
  "chevron-right": "M8 4l8 8-8 8",
  chart: "M3 3v18h18M7 16v-5M12 16V7M17 16V4",
};
export const iconSvg = (name: string, size = 24) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="${
    ICON_PATHS[name] || ICON_PATHS.info
  }"/></svg>`;
