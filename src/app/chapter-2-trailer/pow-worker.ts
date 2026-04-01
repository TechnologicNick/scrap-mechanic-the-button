/// <reference lib="webworker" />

type SolveMessage = {
  type: "solve";
  difficultyBits: number;
  jobId: number;
  nonce: string;
};

type CancelMessage = {
  type: "cancel";
  jobId: number;
};

type WorkerMessage = CancelMessage | SolveMessage;

const workerScope = self as DedicatedWorkerGlobalScope;
const encoder = new TextEncoder();
let activeJobId: null | number = null;

function countLeadingZeroBits(bytes: Uint8Array) {
  let zeroBits = 0;

  for (const byte of bytes) {
    if (byte === 0) {
      zeroBits += 8;
      continue;
    }

    for (let bit = 7; bit >= 0; bit -= 1) {
      if ((byte & (1 << bit)) === 0) {
        zeroBits += 1;
      } else {
        return zeroBits;
      }
    }
  }

  return zeroBits;
}

async function solveProofOfWork({
  difficultyBits,
  jobId,
  nonce,
}: SolveMessage) {
  activeJobId = jobId;

  for (let proof = 0; ; proof += 1) {
    if (activeJobId !== jobId) {
      return;
    }

    const digest = await crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`${nonce}:${proof}`),
    );

    if (activeJobId !== jobId) {
      return;
    }

    if (countLeadingZeroBits(new Uint8Array(digest)) >= difficultyBits) {
      workerScope.postMessage({
        jobId,
        proof,
        type: "solved",
      });
      return;
    }
  }
}

workerScope.onmessage = (event: MessageEvent<WorkerMessage>) => {
  const message = event.data;

  if (message.type === "cancel") {
    if (activeJobId === message.jobId) {
      activeJobId = null;
    }
    return;
  }

  void solveProofOfWork(message).catch((error: unknown) => {
    workerScope.postMessage({
      jobId: message.jobId,
      message: error instanceof Error ? error.message : "Unknown worker error",
      type: "error",
    });
  });
};
