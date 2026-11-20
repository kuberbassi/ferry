import { ConnectionMode } from './protocol';

/**
 * Inspects RTCPeerConnection stats to honestly report whether traffic is
 * flowing directly peer-to-peer or through a TURN relay.
 */
export async function detectConnectionMode(pc: RTCPeerConnection): Promise<ConnectionMode> {
  try {
    const stats = await pc.getStats();
    let selectedPairId: string | null = null;
    const candidateTypes = new Map<string, string>();

    stats.forEach((report) => {
      if (report.type === 'transport' && report.selectedCandidatePairId) {
        selectedPairId = report.selectedCandidatePairId;
      }
      if (report.type === 'local-candidate' || report.type === 'remote-candidate') {
        if (report.id && report.candidateType) {
          candidateTypes.set(report.id, report.candidateType);
        }
      }
    });

    let activePair: { localCandidateId?: string; remoteCandidateId?: string } | undefined;
    for (const report of stats.values()) {
      if (report.type === 'candidate-pair') {
        if (
          (selectedPairId && report.id === selectedPairId) ||
          (!selectedPairId && report.state === 'succeeded' && report.nominated)
        ) {
          activePair = report;
          break;
        }
      }
    }

    if (!activePair) return 'unknown';

    const localType = activePair.localCandidateId
      ? candidateTypes.get(activePair.localCandidateId)
      : undefined;
    const remoteType = activePair.remoteCandidateId
      ? candidateTypes.get(activePair.remoteCandidateId)
      : undefined;

    if (localType === 'relay' || remoteType === 'relay') {
      return 'relayed';
    }
    if (localType || remoteType) {
      return 'direct';
    }
    return 'unknown';
  } catch {
    return 'unknown';
  }
}
