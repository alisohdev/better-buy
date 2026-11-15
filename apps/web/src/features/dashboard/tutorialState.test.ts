import { describe, expect, it } from "vitest";
import { tutorialTransition } from "./tutorialState";

describe("interactive tutorial", () => {
  it("waits for a saved location and an actual scan result", () => {
    expect(tutorialTransition("location", "scan-started")).toBe("location");
    expect(tutorialTransition("location", "location-opened")).toBe("map");
    expect(tutorialTransition("map", "map-confirmed")).toBe("details");
    expect(tutorialTransition("details", "scan-started")).toBe("details");
    expect(tutorialTransition("details", "location-saved")).toBe("scan");
    expect(tutorialTransition("scan", "scan-started")).toBe("waiting");
    expect(tutorialTransition("waiting", "results-opened")).toBe("waiting");
    expect(tutorialTransition("waiting", "scan-succeeded")).toBe("results");
    expect(tutorialTransition("results", "results-opened")).toBe("search");
    expect(tutorialTransition("search", "search-changed")).toBe("product");
    expect(tutorialTransition("product", "product-opened")).toBe("done");
  });
  it("supports cancellation, going back on the map, and failed scan retries", () => {
    expect(tutorialTransition("details", "map-back")).toBe("map");
    expect(tutorialTransition("map", "location-closed")).toBe("location");
    expect(tutorialTransition("details", "location-closed")).toBe("location");
    expect(tutorialTransition("waiting", "scan-failed")).toBe("scan");
    expect(tutorialTransition(null, "location-saved")).toBeNull();
  });
});
