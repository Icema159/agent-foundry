/** Safe, bounded executor recovery read model; never an executable permit. */
export type RecoveryClaim = {
  id: string; invocationId: string; generation: number; sessionId: string; artifactDigest: string;
  status: string; reportCredentialCurrent: boolean;
  start: null | { id: string; requestKey: string; reports: Array<{ id: string; digest: string; outcome: string }> };
};
