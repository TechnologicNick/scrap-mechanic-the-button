"use client";

import { Canvas, useFrame } from "@react-three/fiber";
import { OrbitControls, PerspectiveCamera } from "@react-three/drei";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { InteractiveButtonModel } from "@/models/interactive-button";

const AUTO_PRESS_BUFFER_MS = 3_000;
const AUTO_ROTATE_RESUME_DELAY_MS = 2_000;
const TICK_MS = 100;

type ConnectionState = "connecting" | "open" | "closed";
type ResetSource = "initial" | "manual" | "auto";

type ServerStateMessage = {
  type: "state";
  deadlineTs: number;
  serverNowTs: number;
  lastResetAtTs: number;
  lastResetSource: ResetSource;
  powNonce: null | string;
  powDifficultyBits: number;
  sequence: number;
};

type SocketSnapshot = {
  connectionState: ConnectionState;
  deadlineTs: number | null;
  serverOffsetMs: number;
  lastResetAtTs: number | null;
  lastResetSource: ResetSource;
  powNonce: null | string;
  powDifficultyBits: number;
  sequence: number;
};

type SolveWorkerResponse =
  | { attempts: number; jobId: number; type: "progress" }
  | { attempts: number; jobId: number; proof: number; type: "solved" }
  | { jobId: number; message: string; type: "error" };

const INITIAL_SOCKET_SNAPSHOT: SocketSnapshot = {
  connectionState: "connecting",
  deadlineTs: null,
  serverOffsetMs: 0,
  lastResetAtTs: null,
  lastResetSource: "initial",
  powNonce: null,
  powDifficultyBits: 0,
  sequence: 0,
};

function formatCountdown(remainingMs: number | null) {
  if (remainingMs === null) {
    return "--:--:--";
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  return [hours, minutes, seconds]
    .map((value) => value.toString().padStart(2, "0"))
    .join(":");
}

function useButtonAudio() {
  const pressAudioRef = useRef<HTMLAudioElement | null>(null);
  const releaseAudioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const pressAudio = new Audio("/audio/trigger_switchon.wav");
    const releaseAudio = new Audio("/audio/trigger_switchoff.wav");

    pressAudio.preload = "auto";
    releaseAudio.preload = "auto";

    pressAudioRef.current = pressAudio;
    releaseAudioRef.current = releaseAudio;

    return () => {
      pressAudio.pause();
      releaseAudio.pause();
      pressAudioRef.current = null;
      releaseAudioRef.current = null;
    };
  }, []);

  const playAudio = (audio: HTMLAudioElement | null) => {
    if (!audio) {
      return;
    }

    audio.currentTime = 0;
    void audio.play().catch(() => {
      // Ignore playback interruptions caused by rapid pointer transitions.
    });
  };

  return {
    playPress: () => playAudio(pressAudioRef.current),
    playRelease: () => playAudio(releaseAudioRef.current),
  };
}

function useButtonSocket() {
  const socketRef = useRef<WebSocket | null>(null);
  const workerRef = useRef<Worker | null>(null);
  const snapshotRef = useRef<SocketSnapshot>(INITIAL_SOCKET_SNAPSHOT);
  const activeSolveRef = useRef<{
    startedAt: number;
    jobId: number;
    nonce: string;
  } | null>(null);
  const solvedProofRef = useRef<{
    nonce: string;
    proof: number;
  } | null>(null);
  const nextSolveJobIdRef = useRef(1);
  const reconnectTimeoutRef = useRef<number | null>(null);
  const [snapshot, setSnapshot] = useState<SocketSnapshot>(
    INITIAL_SOCKET_SNAPSHOT,
  );
  const [powReady, setPowReady] = useState(false);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    let cancelled = false;
    const worker = new Worker(new URL("./pow-worker.ts", import.meta.url), {
      type: "module",
    });
    workerRef.current = worker;

    const cancelActiveSolve = (reason: string) => {
      const activeSolve = activeSolveRef.current;
      if (!activeSolve) {
        return;
      }

      worker.postMessage({
        jobId: activeSolve.jobId,
        type: "cancel",
      });
      console.info(`[pow] canceled job ${activeSolve.jobId}: ${reason}`);
      activeSolveRef.current = null;
    };

    const startBackgroundSolve = (
      nonce: null | string,
      difficultyBits: number,
    ) => {
      if (!nonce || difficultyBits <= 0) {
        cancelActiveSolve("missing challenge");
        solvedProofRef.current = null;
        setPowReady(false);
        return;
      }

      if (solvedProofRef.current?.nonce === nonce) {
        setPowReady(true);
        return;
      }

      if (activeSolveRef.current?.nonce === nonce) {
        return;
      }

      cancelActiveSolve("replaced by new challenge");
      solvedProofRef.current = null;
      setPowReady(false);

      const jobId = nextSolveJobIdRef.current++;
      console.info(
        `[pow] starting background job ${jobId} for nonce ${nonce} at difficulty ${difficultyBits}`,
      );
      activeSolveRef.current = {
        startedAt: Date.now(),
        jobId,
        nonce,
      };

      worker.postMessage({
        difficultyBits,
        jobId,
        nonce,
        type: "solve",
      });
    };

    worker.onmessage = (event: MessageEvent<SolveWorkerResponse>) => {
      const message = event.data;
      const activeSolve = activeSolveRef.current;

      if (!activeSolve || activeSolve.jobId !== message.jobId) {
        return;
      }

      if (message.type === "progress") {
        console.info(
          `[pow] job ${message.jobId} searching... ${message.attempts.toLocaleString()} attempts`,
        );
        return;
      }

      if (message.type === "error") {
        console.error(`[pow] job ${message.jobId} failed: ${message.message}`);
        setPowReady(false);
        activeSolveRef.current = null;
        return;
      }

      const latestSnapshot = snapshotRef.current;
      if (latestSnapshot.powNonce !== activeSolve.nonce) {
        console.info(
          `[pow] discarded solved proof for job ${message.jobId} because the nonce changed`,
        );
        activeSolveRef.current = null;
        return;
      }

      console.info(
        `[pow] job ${message.jobId} solved in ${Date.now() - activeSolve.startedAt}ms after ${message.attempts.toLocaleString()} attempts`,
      );
      solvedProofRef.current = {
        nonce: activeSolve.nonce,
        proof: message.proof,
      };
      setPowReady(true);
      activeSolveRef.current = null;
    };

    const clearReconnectTimeout = () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = () => {
      if (cancelled || reconnectTimeoutRef.current !== null) {
        return;
      }

      cancelActiveSolve("connection closed");
      solvedProofRef.current = null;
      setPowReady(false);
      setSnapshot((current) => ({
        ...current,
        connectionState: "closed",
      }));

      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connect();
      }, 1_500);
    };

    const connect = () => {
      if (cancelled) {
        return;
      }

      setSnapshot((current) => ({
        ...current,
        connectionState: "connecting",
      }));

      const socketUrl = new URL("/ws", window.location.href);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";

      const socket = new WebSocket(socketUrl);
      socketRef.current = socket;

      socket.addEventListener("open", () => {
        clearReconnectTimeout();
        setSnapshot((current) => ({
          ...current,
          connectionState: "open",
        }));
      });

      socket.addEventListener("message", (event) => {
        let message: ServerStateMessage;

        try {
          message = JSON.parse(event.data as string) as ServerStateMessage;
        } catch {
          return;
        }

        if (message.type !== "state") {
          return;
        }

        const previousNonce = snapshotRef.current.powNonce;
        if (previousNonce !== message.powNonce) {
          solvedProofRef.current = null;
          setPowReady(false);
        }
        setSnapshot({
          connectionState: "open",
          deadlineTs: message.deadlineTs,
          serverOffsetMs: message.serverNowTs - Date.now(),
          lastResetAtTs: message.lastResetAtTs,
          lastResetSource: message.lastResetSource,
          powNonce: message.powNonce,
          powDifficultyBits: message.powDifficultyBits,
          sequence: message.sequence,
        });
        startBackgroundSolve(message.powNonce, message.powDifficultyBits);
      });

      socket.addEventListener("close", scheduleReconnect);
      socket.addEventListener("error", () => {
        socket.close();
      });
    };

    connect();

    return () => {
      cancelled = true;
      cancelActiveSolve("component unmounted");
      solvedProofRef.current = null;
      clearReconnectTimeout();
      socketRef.current?.close();
      socketRef.current = null;
      worker.terminate();
      workerRef.current = null;
    };
  }, []);

  const pressButton = () => {
    const socket = socketRef.current;
    const currentSnapshot = snapshotRef.current;
    const solvedProof = solvedProofRef.current;

    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !currentSnapshot.powNonce ||
      !solvedProof ||
      solvedProof.nonce !== currentSnapshot.powNonce
    ) {
      console.info("[pow] press ignored because no solved proof is ready yet");
      return false;
    }

    socket.send(JSON.stringify({ type: "press", proof: solvedProof.proof }));
    console.info(
      `[pow] submitted cached proof ${solvedProof.proof} for nonce ${solvedProof.nonce}`,
    );
    solvedProofRef.current = null;
    setPowReady(false);
    return true;
  };

  const cancelPendingPress = () => {
    // Proof-of-work now runs independently in the background.
  };

  return {
    cancelPendingPress,
    pressButton,
    powReady,
    snapshot,
  };
}

type ButtonAssemblyProps = {
  canPress: boolean;
  isPressed: boolean;
};

function ButtonAssembly({ canPress, isPressed }: ButtonAssemblyProps) {
  const buttonModelRef = useRef<THREE.Mesh>(null);
  const pressAmountRef = useRef(0);

  useFrame(() => {
    const targetPressAmount = isPressed ? 1 : 0;
    pressAmountRef.current = THREE.MathUtils.damp(
      pressAmountRef.current,
      targetPressAmount,
      14,
      1 / 60,
    );

    if (buttonModelRef.current) {
      const material = buttonModelRef.current
        .material as THREE.MeshStandardMaterial;
      material.emissive = new THREE.Color("#000000");
      material.emissiveIntensity = 0;
    }
  });

  return (
    <group position={[0, -0.8, 0]}>
      <mesh
        rotation={[-Math.PI / 2, 0, 0]}
        position={[0, -1.22, 0]}
        receiveShadow
      >
        <circleGeometry args={[4.8, 48]} />
        <meshStandardMaterial
          color="#121815"
          roughness={0.96}
          metalness={0.08}
        />
      </mesh>

      <InteractiveButtonModel
        ref={buttonModelRef}
        position={[0, -0.14, 0]}
        pressAmountRef={pressAmountRef}
        scale={[4, 4, 4]}
      />
    </group>
  );
}

type SceneProps = {
  canPress: boolean;
  isPressed: boolean;
  onPress: () => void;
  onRelease: () => void;
};

function Scene({ canPress, isPressed, onPress, onRelease }: SceneProps) {
  const autoRotateTimeoutRef = useRef<number | null>(null);
  const [autoRotateEnabled, setAutoRotateEnabled] = useState(true);

  const clearAutoRotateTimeout = () => {
    if (autoRotateTimeoutRef.current !== null) {
      window.clearTimeout(autoRotateTimeoutRef.current);
      autoRotateTimeoutRef.current = null;
    }
  };

  const pauseAutoRotate = () => {
    clearAutoRotateTimeout();
    setAutoRotateEnabled(false);
  };

  const resumeAutoRotateSoon = () => {
    clearAutoRotateTimeout();
    autoRotateTimeoutRef.current = window.setTimeout(() => {
      setAutoRotateEnabled(true);
      autoRotateTimeoutRef.current = null;
    }, AUTO_ROTATE_RESUME_DELAY_MS);
  };

  useEffect(() => {
    return () => {
      clearAutoRotateTimeout();
    };
  }, []);

  const handleCanvasPointerDown = () => {
    if (!canPress) {
      return;
    }

    onPress();
  };

  const handleCanvasPointerUp = () => {
    onRelease();
  };

  const handleCanvasPointerLeave = () => {
    onRelease();
  };

  return (
    <div
      className={`h-full w-full ${canPress ? "cursor-pointer" : ""}`}
      onPointerDown={handleCanvasPointerDown}
      onPointerUp={handleCanvasPointerUp}
      onPointerLeave={handleCanvasPointerLeave}
      onPointerCancel={handleCanvasPointerUp}
    >
      <Canvas shadows dpr={[1, 2]} className="h-full w-full">
        <color attach="background" args={["#070907"]} />
        <fog attach="fog" args={["#070907", 8, 18]} />
        <PerspectiveCamera makeDefault fov={33} position={[8.4, 5.1, 10.2]} />
        <ambientLight intensity={0.42} />
        <hemisphereLight args={["#fff0c7", "#1a231e", 0.8]} />
        <directionalLight
          castShadow
          color="#ff0000"
          intensity={2.4}
          position={[4.5, 8, 3.5]}
          shadow-normalBias={0.035}
          shadow-bias={-0.0002}
          shadow-mapSize-width={2048}
          shadow-mapSize-height={2048}
        />
        <spotLight
          position={[-5, 6, 2]}
          intensity={20}
          angle={0.36}
          penumbra={0.6}
          color="#ff6f3e"
        />

        <group position={[0, -0.15, 0]}>
          <ButtonAssembly canPress={canPress} isPressed={isPressed} />
        </group>

        <OrbitControls
          autoRotate={autoRotateEnabled}
          autoRotateSpeed={0.55}
          enablePan={false}
          enableDamping
          dampingFactor={0.08}
          minDistance={8.5}
          maxDistance={13.2}
          minPolarAngle={Math.PI / 3.2}
          maxPolarAngle={Math.PI / 2.05}
          onStart={pauseAutoRotate}
          onEnd={resumeAutoRotateSoon}
        />
      </Canvas>
    </div>
  );
}

export function ButtonExperience() {
  const [clientNow, setClientNow] = useState(() => Date.now());
  const [isPressed, setIsPressed] = useState(false);
  const isPressedRef = useRef(false);
  const { cancelPendingPress, pressButton, powReady, snapshot } =
    useButtonSocket();
  const { playPress, playRelease } = useButtonAudio();

  useEffect(() => {
    const interval = window.setInterval(() => {
      setClientNow(Date.now());
    }, TICK_MS);

    return () => {
      window.clearInterval(interval);
    };
  }, []);

  const canPress =
    snapshot.connectionState === "open" &&
    snapshot.powNonce !== null &&
    powReady;
  const rawRemainingMs =
    snapshot.deadlineTs === null
      ? null
      : Math.max(
          0,
          snapshot.deadlineTs - (clientNow + snapshot.serverOffsetMs),
        );

  const displayRemainingMs =
    rawRemainingMs === null
      ? null
      : rawRemainingMs <= AUTO_PRESS_BUFFER_MS
        ? AUTO_PRESS_BUFFER_MS
        : rawRemainingMs;

  const setPressedState = (nextIsPressed: boolean) => {
    isPressedRef.current = nextIsPressed;
    setIsPressed(nextIsPressed);
  };

  const handlePress = () => {
    if (isPressedRef.current) {
      return;
    }

    setPressedState(true);
    playPress();

    if (!pressButton()) {
      if (isPressedRef.current) {
        setPressedState(false);
      }
      return;
    }
  };

  const handleRelease = () => {
    cancelPendingPress();

    if (!isPressedRef.current) {
      return;
    }

    setPressedState(false);
    playRelease();
  };

  return (
    <main className="relative h-full overflow-hidden">
      <div className="absolute inset-0">
        <Scene
          canPress={canPress}
          isPressed={isPressed}
          onPress={handlePress}
          onRelease={handleRelease}
        />
      </div>

      <div className="pointer-events-none absolute inset-x-0 top-0 flex justify-center p-4 sm:p-6 lg:p-8">
        <header className="w-full max-w-xl px-6 py-5 text-center sm:px-8">
          <h1 className="text-lg font-medium uppercase tracking-[0.18em] text-[var(--text)] sm:text-xl">
            Chapter 2 trailer in:
          </h1>
          <p className="mt-3 font-display text-6xl leading-none tracking-[0.08em] text-[var(--accent)] sm:text-8xl">
            {formatCountdown(displayRemainingMs)}
          </p>
        </header>
      </div>
    </main>
  );
}
