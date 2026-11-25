# Mobile roadmap

1. **M0 review.** V1 is Android only. Verify the fixture lifecycle on the Android emulator and an ARM64 physical device. Record device, ABI, native versions, cancellation, persistence after force-close, controlled errors, and sanitized export. Check UI interaction during collection.
2. **M1, only after review.** Extract pure provider parsing, offer identity, and basket logic into reusable Go packages with golden fixtures. Define mobile scan budgets and persistence boundaries. Keep retailer networking disabled until authorization and feasibility are established separately.
3. **Later.** Evaluate location privacy, crash monitoring opt-in, notification scheduling, and permitted live access. Confirm platform background limits before promising automatic refresh.
