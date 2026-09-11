import { z } from "zod";

export const SeveritySchema = z.enum(["critical", "high", "medium", "low", "info"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const WitnessRequestSchema = z.object({
  method: z.string(), url: z.string(), headers: z.record(z.string()), body: z.unknown().optional(),
}).strict();
export const WitnessResponseSchema = z.object({
  status: z.number().int(), headers: z.record(z.string()), bodyDigest: z.string(), bodyPreview: z.string().max(1000).optional(),
}).strict();
export const FindingSchema = z.object({
  id: z.string().regex(/^TRK-\d{4}$/),
  status: z.literal("confirmed"),
  title: z.string(),
  severity: SeveritySchema,
  invariant: z.string(),
  routeId: z.string(),
  oracle: z.string(),
  verdict: z.string(),
  evidence: z.object({ requests: z.array(WitnessRequestSchema), responses: z.array(WitnessResponseSchema), notes: z.array(z.string()) }).strict(),
  replay: z.object({ command: z.string(), checkId: z.string() }).strict(),
  remediation: z.string(),
}).strict();
export type Finding = z.infer<typeof FindingSchema>;

export interface ScanResult {
  scanId: string;
  planId: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  checks: { planned: number; passed: number; failed: number; skipped: number };
  findings: Finding[];
  tokens: { compileInput: number; compileOutput: number; runtimeInput: number; runtimeOutput: number; calls: number };
}
