'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { CanvasTexture, Color, Group, MeshPhysicalMaterial, OrthographicCamera, PMREMGenerator, SRGBColorSpace, TextureLoader, Vector3, CatmullRomCurve3, TubeGeometry } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';

type SceneProps = { spinning: boolean; visible: boolean; turn: number; reset: number; coverSrc: string; onReady: () => void; onUnavailable: () => void };

const DECK_SURFACE_Y = .405;
const RECORD_SURFACE_Y = .636;
const CARTRIDGE_POSITION: [number, number, number] = [.49, .80, 1.24];
const CARTRIDGE_ROTATION_Y = .22;
const TONEARM_TUBE_RADIUS = .037;
const CUE_SUPPORT_HEIGHT = .45;
const TONEARM_SUPPORT_POINT = new Vector3(
  1.64,
  DECK_SURFACE_Y + CUE_SUPPORT_HEIGHT + TONEARM_TUBE_RADIUS + .005,
  .38,
);
const CARTRIDGE_REAR = new Vector3(.215, 0, 0)
  .applyAxisAngle(new Vector3(0, 1, 0), CARTRIDGE_ROTATION_Y)
  .add(new Vector3(...CARTRIDGE_POSITION));
const CUE_SUPPORT_POSITION: [number, number, number] = [
  TONEARM_SUPPORT_POINT.x,
  DECK_SURFACE_Y + CUE_SUPPORT_HEIGHT / 2,
  TONEARM_SUPPORT_POINT.z,
];
const STYLUS_POSITION: [number, number, number] = [
  -.15,
  RECORD_SURFACE_Y + .012 - CARTRIDGE_POSITION[1],
  -.03,
];

function makeDiscTexture() {
  const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2048;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#191b1d'; ctx.fillRect(0, 0, 2048, 2048);
  for (let radius = 333; radius < 1004; radius += 2.5) {
    ctx.beginPath(); ctx.arc(1024, 1024, radius, 0, Math.PI * 2);
    ctx.strokeStyle = radius % 7 < 3 ? '#35383b' : '#222527';
    ctx.lineWidth = radius % 7 < 3 ? 0.7 : 1.1; ctx.stroke();
  }
  for (const radius of [377, 491, 633, 747, 884, 997]) {
    ctx.beginPath(); ctx.arc(1024, 1024, radius, 0, Math.PI * 2);
    ctx.lineWidth = 5; ctx.strokeStyle = '#121416'; ctx.stroke();
  }
  const texture = new CanvasTexture(canvas); texture.colorSpace = SRGBColorSpace; texture.anisotropy = 8;
  return texture;
}

function RoundedBlock({ size, position, color, metalness = .7, roughness = .3, radius = .08 }: {
  size: [number, number, number]; position: [number, number, number]; color: string; metalness?: number; roughness?: number; radius?: number;
}) {
  const [width, height, depth] = size;
  const geometry = useMemo(() => new RoundedBoxGeometry(width, height, depth, 4, radius), [width, height, depth, radius]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return <mesh geometry={geometry} position={position} castShadow receiveShadow><meshStandardMaterial color={color} metalness={metalness} roughness={roughness} /></mesh>;
}

function Turntable({ spinning, coverSrc }: { spinning: boolean; coverSrc: string }) {
  const record = useRef<Group>(null);
  const invalidate = useThree(state => state.invalidate);
  const discTexture = useMemo(() => makeDiscTexture(), []);
  const labelTexture = useMemo(() => {
    const texture = new TextureLoader().load(coverSrc, () => invalidate());
    texture.colorSpace = SRGBColorSpace;
    texture.anisotropy = 8;
    return texture;
  }, [coverSrc, invalidate]);
  const armGeometry = useMemo(() => new TubeGeometry(new CatmullRomCurve3([
    new Vector3(1.93, .84, -.99), new Vector3(1.91, .87, -.58), TONEARM_SUPPORT_POINT.clone(), new Vector3(.98, .82, 1.12), CARTRIDGE_REAR.clone(),
  ]), 48, TONEARM_TUBE_RADIUS, 12, false), []);
  const vinylMaterial = useMemo(() => new MeshPhysicalMaterial({ map: discTexture, color: '#c5c5c5', metalness: .56, roughness: .28, clearcoat: .75, clearcoatRoughness: .2 }), [discTexture]);
  useEffect(() => () => labelTexture.dispose(), [labelTexture]);
  useEffect(() => () => { discTexture.dispose(); armGeometry.dispose(); vinylMaterial.dispose(); }, [discTexture, armGeometry, vinylMaterial]);
  useFrame((_, delta) => { if (spinning && record.current) { record.current.rotation.y -= Math.min(delta, .04) * .68; invalidate(); } });
  useEffect(() => { invalidate(); }, [spinning, invalidate]);

  return <group position={[0, -.12, 0]}>
    <RoundedBlock size={[5.9, .36, 4.15]} position={[0, .1, 0]} color="#25282a" radius={.16} roughness={.32} />
    <RoundedBlock size={[5.77, .035, 4.02]} position={[0, .29, 0]} color="#b4a78b" radius={.12} roughness={.25} />
    <RoundedBlock size={[5.82, .095, 4.07]} position={[0, .35, 0]} color="#343839" radius={.13} roughness={.36} />
    {[-2.35, 2.35].flatMap(x => [-1.55, 1.55].map(z => <group key={`${x}-${z}`} position={[x, -.22, z]}>
      <mesh castShadow><cylinderGeometry args={[.29, .26, .24, 40]} /><meshStandardMaterial color="#111314" metalness={.4} roughness={.6} /></mesh>
      <mesh position={[0, -.08, 0]}><cylinderGeometry args={[.27, .27, .025, 40]} /><meshStandardMaterial color="#918a7e" metalness={.8} roughness={.25} /></mesh>
    </group>))}
    <group position={[-.64, .49, 0]}>
      <mesh castShadow receiveShadow><cylinderGeometry args={[1.78, 1.78, .18, 128]} /><meshStandardMaterial color="#999b99" metalness={.92} roughness={.22} /></mesh>
      <mesh position={[0, .095, 0]}><cylinderGeometry args={[1.735, 1.735, .027, 128]} /><meshStandardMaterial color="#121416" roughness={.65} /></mesh>
      {[0, 1, 2].map(index => <mesh key={index} position={[0, -.055 + index * .045, 0]} rotation={[Math.PI / 2, 0, 0]}><torusGeometry args={[1.778, .008, 6, 128]} /><meshStandardMaterial color="#c1bfb5" metalness={.9} roughness={.24} /></mesh>)}
      <group ref={record} position={[0, .125, 0]}>
        <mesh castShadow material={vinylMaterial}><cylinderGeometry args={[1.70, 1.70, .042, 128]} /></mesh>
        <mesh position={[0, .026, 0]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[.62, 96]} /><meshStandardMaterial map={labelTexture} roughness={.74} metalness={0} /></mesh>
        <mesh position={[0, .047, 0]}><cylinderGeometry args={[.053, .053, .074, 24]} /><meshStandardMaterial color="#d1cec4" metalness={1} roughness={.14} /></mesh>
      </group>
    </group>
    <group position={[1.93, .57, -.99]}>
      <mesh castShadow><cylinderGeometry args={[.31, .34, .3, 48]} /><meshStandardMaterial color="#646a6b" metalness={.92} roughness={.22} /></mesh>
      <mesh position={[0, .16, 0]}><cylinderGeometry args={[.245, .245, .055, 48]} /><meshStandardMaterial color="#c1b495" metalness={.88} roughness={.22} /></mesh>
      <mesh position={[0, .24, -.14]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[.145, .145, .48, 40]} /><meshStandardMaterial color="#aeb0aa" metalness={.95} roughness={.18} /></mesh>
      <mesh position={[0, .24, -.42]} rotation={[Math.PI / 2, 0, 0]} castShadow><cylinderGeometry args={[.215, .215, .24, 48]} /><meshStandardMaterial color="#363b3d" metalness={.78} roughness={.26} /></mesh>
    </group>
    <mesh geometry={armGeometry} castShadow><meshStandardMaterial color="#bcc1c0" metalness={.98} roughness={.16} /></mesh>
    <group position={CARTRIDGE_POSITION} rotation={[0, CARTRIDGE_ROTATION_Y, 0]}>
      <RoundedBlock size={[.43, .09, .19]} position={[0, 0, 0]} color="#b7b7ac" radius={.018} />
      <RoundedBlock size={[.19, .09, .13]} position={[-.12, -.095, -.02]} color="#b2905d" radius={.012} roughness={.35} />
      <mesh position={STYLUS_POSITION}><cylinderGeometry args={[.008, .001, .024, 12]} /><meshStandardMaterial color="#d7d3c7" metalness={.92} roughness={.12} /></mesh>
    </group>
    <mesh position={CUE_SUPPORT_POSITION}><cylinderGeometry args={[.055, .085, CUE_SUPPORT_HEIGHT, 20]} /><meshStandardMaterial color="#555b5b" metalness={.9} roughness={.3} /></mesh>
    <group position={[-2.37, .44, 1.5]}>
      <mesh castShadow><cylinderGeometry args={[.22, .23, .1, 48]} /><meshStandardMaterial color="#929891" metalness={.95} roughness={.24} /></mesh>
      <mesh position={[0, .06, 0]}><cylinderGeometry args={[.183, .183, .025, 48]} /><meshStandardMaterial color="#303535" metalness={.8} roughness={.22} /></mesh>
      <mesh position={[0, .077, -.06]}><boxGeometry args={[.016, .003, .072]} /><meshStandardMaterial color="#edce91" emissive="#dba458" emissiveIntensity={spinning ? 1.5 : .25} /></mesh>
    </group>
    <group position={[2.18, .43, 1.5]}>
      <RoundedBlock size={[.67, .048, .2]} position={[0, 0, 0]} color="#171b1c" radius={.035} />
      <RoundedBlock size={[.25, .049, .14]} position={[-.15, .035, 0]} color="#a4a495" radius={.025} />
    </group>
    <mesh position={[-2.01, .405, 1.5]} rotation={[-Math.PI / 2, 0, 0]}><circleGeometry args={[.018, 16]} /><meshBasicMaterial color={spinning ? '#f1c78c' : '#7c715d'} /></mesh>
  </group>;
}

function Studio({ spinning, turn, reset, visible, coverSrc, onReady, onUnavailable }: SceneProps) {
  // Access the mutable Three.js engine inside effects, outside React render state.
  const getEngine = useThree(state => state.get);
  const size = useThree(state => state.size);
  const invalidate = useThree(state => state.invalidate);
  const orbit = useRef<OrbitControls | null>(null);
  useEffect(() => {
    const { camera, gl, scene } = getEngine();
    const generator = new PMREMGenerator(gl); const room = new RoomEnvironment();
    const environment = generator.fromScene(room, .035);
    scene.environment = environment.texture; scene.environmentIntensity = .75;
    generator.dispose(); room.dispose();
    const controls = new OrbitControls(camera, gl.domElement);
    controls.target.set(0, .1, 0); controls.enableZoom = false; controls.enablePan = false; controls.enableDamping = false;
    controls.minPolarAngle = Math.PI * .13; controls.maxPolarAngle = Math.PI * .44; controls.rotateSpeed = .55;
    const changed = () => invalidate();
    gl.domElement.style.touchAction = 'pan-y'; controls.addEventListener('change', changed);
    controls.update(); orbit.current = controls;
    const unavailable = (event: Event) => { event.preventDefault(); onUnavailable(); };
    gl.domElement.addEventListener('webglcontextlost', unavailable); gl.domElement.dataset.model = 'audora-turntable';
    const frame = requestAnimationFrame(() => { invalidate(); onReady(); });
    return () => { cancelAnimationFrame(frame); controls.removeEventListener('change', changed); controls.dispose(); environment.dispose(); scene.environment = null; gl.domElement.removeEventListener('webglcontextlost', unavailable); };
  }, [getEngine, invalidate, onReady, onUnavailable]);
  useEffect(() => {
    const { gl } = getEngine();
    gl.domElement.dataset.recordCover = coverSrc;
    invalidate();
  }, [coverSrc, getEngine, invalidate]);
  useEffect(() => {
    const { camera } = getEngine();
    const orthographic = camera as OrthographicCamera;
    orthographic.zoom = Math.min(size.width / 7.75, size.height / 5.5); orthographic.updateProjectionMatrix(); invalidate();
  }, [getEngine, size.width, size.height, invalidate]);
  useEffect(() => {
    const { camera } = getEngine();
    const angle = .55 + turn * .3; camera.position.set(Math.sin(angle) * 12, 9.5, Math.cos(angle) * 12);
    orbit.current?.update(); invalidate();
  }, [getEngine, turn, reset, invalidate]);
  useEffect(() => { if (visible) invalidate(); }, [visible, invalidate]);
  return <>
    <ambientLight intensity={.65} /><hemisphereLight args={['#e2e6eb', '#29251d', 1.2]} />
    <directionalLight position={[-3, 7, 4]} intensity={3} color="#f4ede0" castShadow shadow-mapSize={[1024, 1024]}
      shadow-camera-left={-6} shadow-camera-right={6} shadow-camera-top={6} shadow-camera-bottom={-6} shadow-bias={-.001} shadow-normalBias={.025} />
    <directionalLight position={[5, 3, -3]} intensity={2.7} color="#dcb77d" /><directionalLight position={[-4, 1, -4]} intensity={1.3} color="#c1d0d9" />
    <Turntable spinning={spinning} coverSrc={coverSrc} />
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -.475, 0]} receiveShadow><planeGeometry args={[200, 200]} /><shadowMaterial opacity={.3} /></mesh>
  </>;
}

export default function TurntableScene(props: SceneProps) {
  return <Canvas orthographic shadows camera={{ position: [6.3, 9.5, 10.2], zoom: 90, near: .1, far: 100 }}
    dpr={[1, 2]} frameloop="demand" gl={{ antialias: true, alpha: true, powerPreference: 'low-power' }}
    onCreated={({ gl }) => { gl.setClearColor(new Color('#171815'), 0); gl.toneMappingExposure = 1.1; }}
    style={{ position: 'absolute', inset: 0, touchAction: 'pan-y' }} aria-hidden="true"><Studio {...props} /></Canvas>;
}
