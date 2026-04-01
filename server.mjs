import { createServer } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import next from "next";
import { WebSocketServer } from "ws";

const RESET_DURATION_MS = 5 * 60 * 1000;
const MANUAL_RESET_RATE_LIMIT_MS = 4 * 60 * 1000;
const AUTO_PRESS_BUFFER_MS = 3_000;
const POW_DIFFICULTY_BITS = 16;
const dev = process.argv.includes("--dev");
const hostname = process.env.HOSTNAME ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3000);

let deadlineTs = Date.now() + RESET_DURATION_MS;
let lastResetAtTs = Date.now();
let lastResetSource = "initial";
let sequence = 0;
let autoPressTimeout = null;

const app = next({ dev, hostname, port });
const handle = app.getRequestHandler();
const websocketServer = new WebSocketServer({ noServer: true });
const clients = new Set();
const clientStateBySocket = new Map();

function createClientState() {
  return {
    lastManualResetAtTs: 0,
    powNonce: randomBytes(16).toString("hex"),
  };
}

function formatRemainingTime(milliseconds) {
  const clamped = Math.max(0, milliseconds);
  const totalSeconds = Math.floor(clamped / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${minutes.toString().padStart(2, "0")}:${seconds
    .toString()
    .padStart(2, "0")}`;
}

function getStateMessage() {
  return JSON.stringify({
    type: "state",
    deadlineTs,
    serverNowTs: Date.now(),
    lastResetAtTs,
    lastResetSource,
    powNonce: null,
    powDifficultyBits: POW_DIFFICULTY_BITS,
    sequence,
  });
}

function getStateMessageForClient(websocket, overrides = {}) {
  const clientState = clientStateBySocket.get(websocket);

  return JSON.stringify({
    type: "state",
    deadlineTs,
    serverNowTs: Date.now(),
    lastResetAtTs,
    lastResetSource,
    powNonce: clientState?.powNonce ?? null,
    powDifficultyBits: POW_DIFFICULTY_BITS,
    sequence,
    ...overrides,
  });
}

function broadcastState() {
  let broadcastCount = 0;

  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(getStateMessageForClient(client));
      broadcastCount += 1;
    }
  }

  return broadcastCount;
}

function countLeadingZeroBits(buffer) {
  let zeroBits = 0;

  for (const byte of buffer) {
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

function isValidProofOfWork(powNonce, proof) {
  if (typeof powNonce !== "string" || typeof proof !== "number") {
    return false;
  }

  if (!Number.isInteger(proof) || proof < 0) {
    return false;
  }

  const digest = createHash("sha256")
    .update(`${powNonce}:${proof}`)
    .digest();

  return countLeadingZeroBits(digest) >= POW_DIFFICULTY_BITS;
}

function scheduleAutoPress() {
  if (autoPressTimeout !== null) {
    clearTimeout(autoPressTimeout);
  }

  const delay = Math.max(0, deadlineTs - AUTO_PRESS_BUFFER_MS - Date.now());
  autoPressTimeout = setTimeout(() => {
    resetCountdown("auto");
  }, delay);
}

function resetCountdown(source) {
  const remainingMs = Math.max(0, deadlineTs - Date.now());
  deadlineTs = Date.now() + RESET_DURATION_MS;
  lastResetAtTs = Date.now();
  lastResetSource = source;
  sequence += 1;

  scheduleAutoPress();
  const broadcastCount = broadcastState();

  console.log(
    `[button] reset via ${source} with ${formatRemainingTime(
      remainingMs,
    )} remaining at ${new Date(lastResetAtTs).toISOString()}, broadcast to ${broadcastCount} clients`,
  );
}

function handleSocketMessage(websocket, rawMessage) {
  let message;

  try {
    message = JSON.parse(rawMessage.toString());
  } catch {
    return;
  }

  if (message?.type === "press") {
    const clientState = clientStateBySocket.get(websocket);
    if (!clientState) {
      return;
    }

    if (!isValidProofOfWork(clientState.powNonce, message.proof)) {
      console.log("[button] rejected press with invalid proof of work");
      return;
    }

    clientState.powNonce = randomBytes(16).toString("hex");
    const now = Date.now();
    const cooldownRemainingMs = Math.max(
      0,
      clientState.lastManualResetAtTs + MANUAL_RESET_RATE_LIMIT_MS - now,
    );

    if (cooldownRemainingMs > 0) {
      websocket.send(
        getStateMessageForClient(websocket, {
          deadlineTs: now + RESET_DURATION_MS,
          lastResetAtTs: now,
          lastResetSource: "manual",
          sequence,
        }),
      );

      console.log(
        `[button] suppressed manual reset with ${formatRemainingTime(
          Math.max(0, deadlineTs - now),
        )} remaining, cooldown ${formatRemainingTime(
          cooldownRemainingMs,
        )} remaining`,
      );
      return;
    }

    clientState.lastManualResetAtTs = now;
    resetCountdown("manual");
  }
}

scheduleAutoPress();

await app.prepare();

const server = createServer((req, res) => {
  void handle(req, res);
});

server.on("upgrade", (request, socket, head) => {
  const requestUrl = new URL(
    request.url ?? "/",
    `http://${request.headers.host ?? "localhost"}`,
  );

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  websocketServer.handleUpgrade(request, socket, head, (websocket) => {
    clients.add(websocket);
    clientStateBySocket.set(websocket, createClientState());
    websocket.send(getStateMessageForClient(websocket));

    websocket.on("message", (rawMessage) =>
      handleSocketMessage(websocket, rawMessage),
    );
    websocket.on("close", () => {
      clients.delete(websocket);
      clientStateBySocket.delete(websocket);
    });
  });
});

server.listen(port, hostname, () => {
  console.log(`> Ready on http://localhost:${port}`);
});
