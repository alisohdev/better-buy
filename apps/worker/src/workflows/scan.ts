import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { DurableRepository } from "../durable/repository";
import { runDurableScan } from "../durable/runner";
import { materializeProducts } from "../saved-products";
import type { JsonValue, WorkflowParams, Steps } from "../durable/types";
import type { WorkerEnv } from "../http/types";
import { DurableError } from "../durable/types";
import { CollectorError } from "../domain/failures";

export class ScanWorkflow extends WorkflowEntrypoint<
  WorkerEnv,
  WorkflowParams
> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep) {
    const cloudflareStepDo = step.do as unknown as (
      name: string,
      options: {
        retries: { limit: 2; delay: "1 second"; backoff: "exponential" };
        timeout: "1 minute";
      },
      action: () => Promise<JsonValue>
    ) => Promise<JsonValue>;
    const steps: Steps = {
      do: <T extends JsonValue>(name: string, action: () => Promise<T>) =>
        cloudflareStepDo(
          name,
          {
            retries: { limit: 2, delay: "1 second", backoff: "exponential" },
            timeout: "1 minute",
          },
          async () => {
            try {
              return await action();
            } catch (error) {
              if (
                error instanceof DurableError ||
                error instanceof CollectorError
              )
                throw Object.assign(new NonRetryableError(error.code), {
                  code: error.code,
                });
              throw error;
            }
          }
        ) as Promise<T>,
      sleep: (name, duration) => step.sleep(name, duration),
    };
    return runDurableScan(event.payload, {
      repository: new DurableRepository(this.env.DB, this.env.BOX_KEY),
      steps,
      sharedOkalaOffersEnabled: this.env.OKALA_SHARED_OFFERS_ENABLED === "true",
      materialize: (userId, scanId) =>
        materializeProducts(this.env.DB, userId, scanId),
    });
  }
}
