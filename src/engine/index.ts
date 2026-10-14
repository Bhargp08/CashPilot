import type { Engine } from "@/contracts/interfaces";
import { applyDecisions } from "./apply";
import { buildAudit } from "./audit";
import { forecast } from "./forecast";
import { validate } from "./validate";

export const engine: Engine = { forecast, applyDecisions, validate, buildAudit };
export { forecast, applyDecisions, validate, buildAudit };
