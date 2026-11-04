import type {
  DurableEnv,
  ScanEngine,
  ScanEngineState,
  WorkflowParams,
} from "../durable/types";

type WorkflowBinding = NonNullable<DurableEnv["SCAN_WORKFLOW"]>;

function isMissingWorkflow(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    (("status" in error && error.status === 404) ||
      ("code" in error && error.code === "WORKFLOW_NOT_FOUND"))
  );
}

function toState(status: string): ScanEngineState {
  switch (status) {
    case "queued":
      return { kind: "queued" };
    case "complete":
      return { kind: "stopped", reason: "complete" };
    case "errored":
      return { kind: "stopped", reason: "errored" };
    case "terminated":
      return { kind: "stopped", reason: "terminated" };
    default:
      return { kind: "active" };
  }
}

export function createCloudflareScanEngine(
  binding: WorkflowBinding
): ScanEngine {
  return {
    async ensure(instanceId: string, params: WorkflowParams) {
      try {
        await binding.create({ id: instanceId, params });
      } catch (error) {
        const state = await this.inspect(instanceId);
        if (state.kind === "missing") throw error;
      }
    },
    async inspect(instanceId) {
      let instance;
      try {
        instance = await binding.get(instanceId);
      } catch (error) {
        if (isMissingWorkflow(error)) return { kind: "missing" };
        throw error;
      }
      try {
        const state = await instance.status();
        return toState(state.status);
      } catch (error) {
        if (isMissingWorkflow(error)) return { kind: "missing" };
        throw error;
      }
    },
    async terminate(instanceId) {
      let instance;
      try {
        instance = await binding.get(instanceId);
      } catch (error) {
        if (isMissingWorkflow(error)) return;
        throw error;
      }
      await instance.terminate();
    },
  };
}
