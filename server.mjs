import { createServer } from "node:http";
import next from "next";
import { WebSocketServer } from "ws";

const RESET_DURATION_MS = 5 * 60 * 1000;
const MANUAL_RESET_RATE_LIMIT_MS = 4 * 60 * 1000;
const AUTO_PRESS_BUFFER_MS = 3_000;
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
const manualResetCooldownByClient = new WeakMap();

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
    sequence,
  });
}

function getStateMessageForDeadline({
  deadlineTs,
  lastResetAtTs,
  lastResetSource,
  sequence,
}) {
  return JSON.stringify({
    type: "state",
    deadlineTs,
    serverNowTs: Date.now(),
    lastResetAtTs,
    lastResetSource,
    sequence,
  });
}

function broadcastState() {
  const payload = getStateMessage();

  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      client.send(payload);
    }
  }
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
  broadcastState();

  console.log(
    `[button] reset via ${source} with ${formatRemainingTime(
      remainingMs,
    )} remaining at ${new Date(lastResetAtTs).toISOString()}`,
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
    const now = Date.now();
    const lastManualResetAtTs =
      manualResetCooldownByClient.get(websocket) ?? 0;
    const cooldownRemainingMs = Math.max(
      0,
      lastManualResetAtTs + MANUAL_RESET_RATE_LIMIT_MS - now,
    );

    if (cooldownRemainingMs > 0) {
      websocket.send(
        getStateMessageForDeadline({
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

    manualResetCooldownByClient.set(websocket, now);
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
    websocket.send(getStateMessage());

    websocket.on("message", (rawMessage) =>
      handleSocketMessage(websocket, rawMessage),
    );
    websocket.on("close", () => {
      clients.delete(websocket);
    });
  });
});

server.listen(port, hostname, () => {
  console.log(`> Ready on http://localhost:${port}`);
});
