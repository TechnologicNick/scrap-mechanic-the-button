"use client";

import { useFrame } from "@react-three/fiber";
import { useGLTF } from "@react-three/drei";
import React, {
  MutableRefObject,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import * as THREE from "three";
import { GLTF } from "three-stdlib";
import { applyColor } from "./util";

type GLTFResult = GLTF & {
  nodes: {
    tmp: THREE.Mesh;
  };
  materials: {
    ["1e8d93a4-506b-470d-9ada-9c0a321e2db5 df7f01 1 m1"]: THREE.MeshStandardMaterial;
  };
};

type InteractiveButtonModelProps = JSX.IntrinsicElements["mesh"] & {
  pressAmountRef: MutableRefObject<number>;
};

export const InteractiveButtonModel = React.forwardRef<
  THREE.Mesh,
  InteractiveButtonModelProps
>(function InteractiveButtonModel(props, ref) {
  const { position, pressAmountRef, ...rest } = props;
  const localRef = useRef<THREE.Mesh>(null);
  const offModel = useGLTF("/models/obj_interactive_button_off.glb") as GLTFResult;
  const onModel = useGLTF("/models/obj_interactive_button_on.glb") as GLTFResult;
  const offGeometry = offModel.nodes.tmp.geometry;
  const onGeometry = onModel.nodes.tmp.geometry;
  const sourceMaterial =
    offModel.materials["1e8d93a4-506b-470d-9ada-9c0a321e2db5 df7f01 1 m1"];

  useImperativeHandle(ref, () => localRef.current as THREE.Mesh, []);

  const geometry = useMemo(() => offGeometry.clone(), [offGeometry]);
  const morphData = useMemo(() => {
    const offPositions = offGeometry.getAttribute("position");
    const onPositions = onGeometry.getAttribute("position");
    const offNormals = offGeometry.getAttribute("normal");
    const onNormals = onGeometry.getAttribute("normal");

    if (
      offPositions.count !== onPositions.count ||
      offPositions.itemSize !== onPositions.itemSize
    ) {
      throw new Error("Button on/off meshes do not share position topology");
    }

    if (
      offNormals.count !== onNormals.count ||
      offNormals.itemSize !== onNormals.itemSize
    ) {
      throw new Error("Button on/off meshes do not share normal topology");
    }

    return {
      offPositions: offPositions.array as Float32Array,
      onPositions: onPositions.array as Float32Array,
      offNormals: offNormals.array as Float32Array,
      onNormals: onNormals.array as Float32Array,
    };
  }, [offGeometry, onGeometry]);

  const lastPressAmountRef = useRef(-1);
  const processedMaterial = useMemo(() => {
    if (
      typeof OffscreenCanvas === "undefined" &&
      typeof document === "undefined"
    ) {
      return sourceMaterial;
    }

    if (sourceMaterial.userData.hasButtonTextureProcessingApplied) {
      return sourceMaterial;
    }

    const material = applyColor(sourceMaterial, new THREE.Color("#DF7F01"));
    material.side = THREE.FrontSide;

    material.userData = {
      ...material.userData,
      hasButtonTextureProcessingApplied: true,
    };
    material.needsUpdate = true;

    return material;
  }, [sourceMaterial]);

  useFrame(() => {
    const nextPressAmount = THREE.MathUtils.clamp(
      pressAmountRef.current,
      0,
      1,
    );

    if (
      !localRef.current ||
      Math.abs(nextPressAmount - lastPressAmountRef.current) < 0.0001
    ) {
      return;
    }

    const positionAttribute = geometry.getAttribute(
      "position",
    ) as THREE.BufferAttribute;
    const normalAttribute = geometry.getAttribute(
      "normal",
    ) as THREE.BufferAttribute;

    for (let index = 0; index < morphData.offPositions.length; index += 1) {
      positionAttribute.array[index] = THREE.MathUtils.lerp(
        morphData.offPositions[index]!,
        morphData.onPositions[index]!,
        nextPressAmount,
      );
    }

    for (let index = 0; index < morphData.offNormals.length; index += 1) {
      normalAttribute.array[index] = THREE.MathUtils.lerp(
        morphData.offNormals[index]!,
        morphData.onNormals[index]!,
        nextPressAmount,
      );
    }

    positionAttribute.needsUpdate = true;
    normalAttribute.needsUpdate = true;
    geometry.computeBoundingSphere();
    lastPressAmountRef.current = nextPressAmount;
  });

  return (
    <mesh
      {...rest}
      ref={localRef}
      geometry={geometry}
      material={processedMaterial}
      position={position}
      rotation={[0, Math.PI, 0]}
      castShadow
    />
  );
});

useGLTF.preload("/models/obj_interactive_button_off.glb");
useGLTF.preload("/models/obj_interactive_button_on.glb");
