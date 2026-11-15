import type {
  StyleSpecification,
  LayerSpecification,
  ExpressionSpecification,
} from "maplibre-gl";
import { TEHRAN_BOUNDARY } from "@better-buy/shared";

export function createLocationMapStyle(dark: boolean): StyleSpecification {
  const palette = dark
    ? {
        canvas: "#1b222c",
        residential: "#222c35",
        park: "#243b36",
        water: "#244655",
        building: "#35414c",
        casing: "#16202a",
        road: "#485866",
        highway: "#806e50",
        text: "#d0dae2",
        accent: "#c3cdff",
      }
    : {
        canvas: "#f3f5f7",
        residential: "#e9eef0",
        park: "#d9e9de",
        water: "#bcdceb",
        building: "#d8e0e5",
        casing: "#ccd5dc",
        road: "#fdfefe",
        highway: "#e7cea0",
        text: "#364753",
        accent: "#6575bb",
      };
  const width: ExpressionSpecification = [
    "interpolate",
    ["linear"],
    ["zoom"],
    10,
    0.6,
    14,
    2,
    17,
    7,
  ];
  const name: ExpressionSpecification = [
    "coalesce",
    ["get", "name:fa"],
    ["get", "name:nonlatin"],
    ["get", "name"],
    ["get", "name:latin"],
  ];
  const layers: LayerSpecification[] = [
    {
      id: "canvas",
      type: "background",
      paint: { "background-color": palette.canvas },
    },
    {
      id: "residential",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landuse",
      filter: ["==", "class", "residential"],
      paint: { "fill-color": palette.residential },
    },
    {
      id: "parks",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "park",
      paint: { "fill-color": palette.park },
    },
    {
      id: "green-cover",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "landcover",
      filter: ["in", "class", "wood", "grass"],
      paint: { "fill-color": palette.park, "fill-opacity": 0.65 },
    },
    {
      id: "water",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "water",
      paint: { "fill-color": palette.water },
    },
    {
      id: "waterways",
      type: "line",
      source: "openmaptiles",
      "source-layer": "waterway",
      paint: { "line-color": palette.water, "line-width": 1.5 },
    },
    {
      id: "buildings",
      type: "fill",
      source: "openmaptiles",
      "source-layer": "building",
      minzoom: 16,
      paint: { "fill-color": palette.building, "fill-opacity": 0.6 },
    },
    {
      id: "street-casing",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: [
        "in",
        "class",
        "minor",
        "service",
        "tertiary",
        "secondary",
        "primary",
        "trunk",
        "motorway",
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": palette.casing,
        "line-width": [
          "interpolate",
          ["linear"],
          ["zoom"],
          10,
          1.5,
          14,
          4,
          17,
          10,
        ],
      },
    },
    {
      id: "streets",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: [
        "in",
        "class",
        "minor",
        "service",
        "tertiary",
        "secondary",
        "primary",
      ],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": palette.road, "line-width": width },
    },
    {
      id: "main-roads",
      type: "line",
      source: "openmaptiles",
      "source-layer": "transportation",
      filter: ["in", "class", "trunk", "motorway"],
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": palette.highway, "line-width": width },
    },
    {
      id: "street-names",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "transportation_name",
      minzoom: 13,
      filter: ["!in", "class", "motorway", "trunk"],
      layout: {
        "symbol-placement": "line",
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": 12,
        "symbol-spacing": 300,
        "text-max-angle": 35,
      },
      paint: {
        "text-color": palette.text,
        "text-halo-color": palette.canvas,
        "text-halo-width": 1.5,
      },
    },
    {
      id: "neighborhoods",
      type: "symbol",
      source: "openmaptiles",
      "source-layer": "place",
      filter: ["in", "class", "suburb", "quarter", "neighbourhood"],
      layout: {
        "text-field": name,
        "text-font": ["Noto Sans Regular"],
        "text-size": 13,
        "text-padding": 24,
      },
      paint: {
        "text-color": palette.text,
        "text-halo-color": palette.canvas,
        "text-halo-width": 2,
      },
    },
    {
      id: "tehran-boundary",
      type: "line",
      source: "tehran-boundary",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-color": palette.accent,
        "line-width": 2,
        "line-dasharray": [2, 2],
      },
    },
  ];
  return {
    version: 8,
    name: dark ? "Better Buy Night" : "Better Buy Day",
    glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
    sources: {
      openmaptiles: {
        type: "vector",
        url: "https://tiles.openfreemap.org/planet",
        attribution:
          '<a href="https://openfreemap.org/">OpenFreeMap</a> © <a href="https://www.openmaptiles.org/">OpenMapTiles</a> © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      },
      "tehran-boundary": {
        type: "geojson",
        data: {
          type: "Feature",
          properties: {},
          geometry: {
            type: "LineString",
            coordinates: [
              [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.minLatitude],
              [TEHRAN_BOUNDARY.maxLongitude, TEHRAN_BOUNDARY.minLatitude],
              [TEHRAN_BOUNDARY.maxLongitude, TEHRAN_BOUNDARY.maxLatitude],
              [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.maxLatitude],
              [TEHRAN_BOUNDARY.minLongitude, TEHRAN_BOUNDARY.minLatitude],
            ],
          },
        },
      },
    },
    layers,
  };
}
