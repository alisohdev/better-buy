import { expect, it } from "vitest";
import { createLocationMapStyle } from "./mapStyle";

it("uses a lean local style without route shields, house numbers or sprite downloads", () => {
  const style = createLocationMapStyle(false);
  expect(style.layers.length).toBeLessThan(20);
  expect(style.sprite).toBeUndefined();
  expect(
    style.layers.some((layer) => /housenumber|shield|ref/.test(layer.id))
  ).toBe(false);
  expect(style.sources).toHaveProperty("tehran-boundary");
});

it("changes the full palette with the theme but keeps the same tile source", () => {
  const light = createLocationMapStyle(false);
  const dark = createLocationMapStyle(true);
  expect(light.sources).toEqual(dark.sources);
  expect(light.layers[0]?.paint).not.toEqual(dark.layers[0]?.paint);
  expect(light.layers.map((layer) => layer.id)).toEqual(
    dark.layers.map((layer) => layer.id)
  );
});
