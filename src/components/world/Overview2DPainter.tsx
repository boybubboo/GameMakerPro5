import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Eraser,
  Flower2,
  Globe,
  Hand,
  MousePointer2,
  Mountain,
  Plus,
  RotateCcw,
  Route,
  Shrub,
  Trees,
  Umbrella,
  Waves,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { MakerStore } from '../../store/useMakerStore';
import {
  IslandTerrain,
  type Overview2DBrushId,
  createDefaultWaterBodies,
  createInitialTerrain,
  levelBoardToWorld,
  sampleTerrainHeight,
} from '../../utils/terrain';
import {
  WORLD_BORDER_GRAY,
  WORLD_TERRAIN_YELLOW,
  computeRegionCentroids,
  getWorldMapRadius,
  sampleWorldMapAtWorld,
} from '../../utils/worldMap';
import { MAKER_ASSET_DRAG_MIME } from './LeftAssetsPanel';

type Painter2DTool = Overview2DBrushId | 'inspect';

interface BrushMeta {
  id: Painter2DTool;
  label: string;
  accent: string;
  Icon: React.FC<{ size?: number; className?: string }>;
}

const PAINTER_2D_TOOLS: BrushMeta[] = [
  { id: 'inspect', label: 'Select', accent: '#7C5CFF', Icon: MousePointer2 },
  { id: 'terrain', label: 'Terrain', accent: WORLD_TERRAIN_YELLOW, Icon: Globe },
  { id: 'coniferWoods', label: 'Conifers', accent: '#1F5C36', Icon: Trees },
  { id: 'deciduousWoods', label: 'Deciduous', accent: '#4EA343', Icon: Trees },
  { id: 'bushes', label: 'Bushes', accent: '#20B46A', Icon: Shrub },
  { id: 'wildflowers', label: 'Flowers', accent: '#EC4899', Icon: Flower2 },
  { id: 'rocks', label: 'Rocks', accent: '#64748B', Icon: Mountain },
  { id: 'hills', label: 'Hills', accent: '#F59E0B', Icon: Mountain },
  { id: 'beaches', label: 'Beach', accent: '#D6B66A', Icon: Umbrella },
  { id: 'lakes', label: 'Lake', accent: '#0EA5E9', Icon: Waves },
  { id: 'rivers', label: 'Creek', accent: '#2A9D8F', Icon: Waves },
  { id: 'caves', label: 'Cave', accent: '#A855F7', Icon: Mountain },
  { id: 'roads', label: 'Trail', accent: '#C2854E', Icon: Route },
  { id: 'erase', label: 'Erase', accent: '#F2545B', Icon: Eraser },
];

const LAYER_COLORS = [
  '#4EA343', // 0 grass
  '#E5C67E', // 1 sand
  '#7D828F', // 2 rock
  '#E2E8F0', // 3 snow
  '#5D7B3B', // 4 moss
  '#8C939E', // 5 cobble
  '#9C6F44', // 6 dirt
];

export interface Overview2DPainterProps {
  store: MakerStore;
  activePlacementAssetId: string | null;
  onPlaceCustomAssetAtWorldPoint: (assetId: string, worldX: number, worldZ: number) => void;
  onSelectEntityFrom2D: (entityId: string) => void;
}

export const Overview2DPainter: React.FC<Overview2DPainterProps> = ({
  store,
  activePlacementAssetId,
  onPlaceCustomAssetAtWorldPoint,
  onSelectEntityFrom2D,
}) => {
  const { currentLevel } = store;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [tool, setTool] = useState<Painter2DTool>('terrain');
  const [worldMapSelectMode, setWorldMapSelectMode] = useState(false);
  const [brushRadius, setBrushRadius] = useState<number>(11);
  const [density, setDensity] = useState<number>(0.65);
  const [zoom, setZoom] = useState<number>(1);
  const [pan, setPan] = useState<[number, number]>([0, 0]);
  const [hoverWorld, setHoverWorld] = useState<[number, number] | null>(null);
  const [shiftHeld, setShiftHeld] = useState(false);
  const [isPanning, setIsPanning] = useState(false);

  const paintingRef = useRef(false);
  const panningRef = useRef<{ startX: number; startY: number; origPan: [number, number] } | null>(
    null
  );
  const lastStrokeMsRef = useRef(0);
  const lastLandClickRef = useRef<{ code: number; time: number } | null>(null);

  const isWorldMapMode = store.worldEditorScope === 'worldMap';
  const worldMap = store.resolvedWorldMap;
  const activeRegionCode = store.activeWorldRegionCode;
  const activeRegionOrigin = store.activeWorldRegionOrigin;
  const worldMapRadius = getWorldMapRadius(worldMap);
  const viewShoreRadius = isWorldMapMode ? worldMapRadius * 1.05 : IslandTerrain.shoreRadius;
  const activeBrushRadius = isWorldMapMode ? store.worldMapBrushRadius : brushRadius;
  const setActiveBrushRadius = isWorldMapMode ? store.setWorldMapBrushRadius : setBrushRadius;
  const worldMapCacheRef = useRef<{ key: string; canvas: HTMLCanvasElement } | null>(null);
  const terrain = useMemo(
    () => currentLevel?.terrain ?? createInitialTerrain(),
    [currentLevel?.terrain]
  );
  const isFreeform = Boolean(terrain.freeformWorld || worldMap || isWorldMapMode);

  useEffect(() => {
    setZoom(1);
    setPan([0, 0]);
  }, [isWorldMapMode]);

  useEffect(() => {
    const syncShift = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        e.type === 'keydown' &&
        target &&
        (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT')
      ) {
        return;
      }
      if (e.key === 'Shift' || e.shiftKey) {
        setShiftHeld(e.shiftKey);
      } else {
        setShiftHeld(false);
      }
    };
    const onBlur = () => {
      setShiftHeld(false);
      setIsPanning(false);
      panningRef.current = null;
      paintingRef.current = false;
    };
    window.addEventListener('keydown', syncShift);
    window.addEventListener('keyup', syncShift);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', syncShift);
      window.removeEventListener('keyup', syncShift);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  const screenToWorld = useCallback(
    (clientX: number, clientY: number): [number, number] => {
      const canvas = canvasRef.current;
      if (!canvas) return [0, 0];
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width * 0.5 + pan[0];
      const cy = rect.height * 0.5 + pan[1];
      const halfSpan = (Math.min(rect.width, rect.height) * 0.45) * zoom;
      const wx = ((clientX - rect.left - cx) / Math.max(1, halfSpan)) * viewShoreRadius;
      const wz = ((clientY - rect.top - cy) / Math.max(1, halfSpan)) * viewShoreRadius;
      return [wx, wz];
    },
    [pan, viewShoreRadius, zoom]
  );

  // Render interactive top-down world map canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !currentLevel) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(320, container.clientWidth);
    const h = Math.max(240, container.clientHeight);
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    ctx.save();
    ctx.scale(dpr, dpr);

    // Deep ocean backdrop
    ctx.fillStyle = '#0D2438';
    ctx.fillRect(0, 0, w, h);

    const cx = w * 0.5 + pan[0];
    const cy = h * 0.5 + pan[1];
    const halfSpan = Math.min(w, h) * 0.45 * zoom;
    const toPx = (wx: number, wz: number): [number, number] => [
      cx + (wx / viewShoreRadius) * halfSpan,
      cy + (wz / viewShoreRadius) * halfSpan,
    ];
    const scaleM = halfSpan / viewShoreRadius;

    if (!isFreeform) {
      // Classic circular ocean ripple rings & island base shadow
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
      ctx.lineWidth = 1.5;
      for (const rMul of [1.02, 1.12, 1.24]) {
        ctx.beginPath();
        ctx.arc(cx, cy, IslandTerrain.shoreRadius * scaleM * rMul, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = '#18364A';
      ctx.beginPath();
      ctx.arc(cx, cy, IslandTerrain.shoreRadius * scaleM, 0, Math.PI * 2);
      ctx.fill();
    } else {
      // Subtle navigable world grid over open ocean
      const gridExtent = isWorldMapMode ? worldMapRadius : IslandTerrain.radius;
      const gridStep = isWorldMapMode ? 80 : 20;
      const worldHalfPx = gridExtent * scaleM;
      ctx.save();
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.08)';
      ctx.lineWidth = 1;
      for (let g = -gridExtent; g <= gridExtent; g += gridStep) {
        const [gx] = toPx(g, 0);
        const [, gy] = toPx(0, g);
        ctx.beginPath();
        ctx.moveTo(gx, cy - worldHalfPx);
        ctx.lineTo(gx, cy + worldHalfPx);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - worldHalfPx, gy);
        ctx.lineTo(cx + worldHalfPx, gy);
        ctx.stroke();
      }
      ctx.strokeStyle = 'rgba(125, 211, 252, 0.22)';
      ctx.setLineDash([6, 6]);
      ctx.strokeRect(cx - worldHalfPx, cy - worldHalfPx, worldHalfPx * 2, worldHalfPx * 2);
      ctx.setLineDash([]);
      ctx.restore();
    }

    if (isWorldMapMode && worldMap) {
      const size = worldMap.gridSize;
      const width = size + 1;
      const paletteSig = worldMap.regions.map((r) => `${r.code}:${r.colorHex}`).join('|');
      const cacheKey = `${worldMap.revision}:${size}:${paletteSig}`;
      let offCanvas = worldMapCacheRef.current?.key === cacheKey ? worldMapCacheRef.current.canvas : null;

      if (!offCanvas) {
        offCanvas = document.createElement('canvas');
        offCanvas.width = size;
        offCanvas.height = size;
        const offCtx = offCanvas.getContext('2d');
        if (offCtx) {
          const hexToRgb = (hex: string): [number, number, number] => {
            const clean = hex.replace('#', '');
            const norm =
              clean.length === 3
                ? clean
                    .split('')
                    .map((c) => c + c)
                    .join('')
                : clean;
            const num = parseInt(norm, 16);
            if (Number.isNaN(num)) return [229, 198, 126];
            return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
          };
          const yellowRgb = hexToRgb(WORLD_TERRAIN_YELLOW);
          const regionRgbMap = new Map<number, [number, number, number]>();
          for (const r of worldMap.regions) {
            regionRgbMap.set(r.code, hexToRgb(r.colorHex));
          }

          const img = offCtx.createImageData(size, size);
          const data = img.data;
          for (let row = 0; row < size; row++) {
            for (let col = 0; col < size; col++) {
              const idx = row * width + col;
              const pOff = (row * size + col) * 4;
              const hasLand = worldMap.landMask[idx] === 1;
              if (!hasLand) {
                const nearLand =
                  (row > 0 && worldMap.landMask[(row - 1) * width + col] === 1) ||
                  (row < size && worldMap.landMask[(row + 1) * width + col] === 1) ||
                  (col > 0 && worldMap.landMask[row * width + (col - 1)] === 1) ||
                  (col < size && worldMap.landMask[row * width + (col + 1)] === 1);
                if (nearLand) {
                  data[pOff] = 20;
                  data[pOff + 1] = 75;
                  data[pOff + 2] = 110;
                  data[pOff + 3] = 255;
                }
                continue;
              }
              const code = worldMap.regionGrid[idx] ?? 0;
              const rgb = (code > 0 ? regionRgbMap.get(code) : undefined) ?? yellowRgb;
              const isEdge =
                row === 0 ||
                row >= size - 1 ||
                col === 0 ||
                col >= size - 1 ||
                worldMap.landMask[(row - 1) * width + col] === 0 ||
                worldMap.landMask[(row + 1) * width + col] === 0 ||
                worldMap.landMask[row * width + (col - 1)] === 0 ||
                worldMap.landMask[row * width + (col + 1)] === 0 ||
                worldMap.regionGrid[(row - 1) * width + col] !== code ||
                worldMap.regionGrid[(row + 1) * width + col] !== code ||
                worldMap.regionGrid[row * width + (col - 1)] !== code ||
                worldMap.regionGrid[row * width + (col + 1)] !== code;
              const shade = isEdge ? 0.68 : 1;
              data[pOff] = Math.round(rgb[0] * shade);
              data[pOff + 1] = Math.round(rgb[1] * shade);
              data[pOff + 2] = Math.round(rgb[2] * shade);
              data[pOff + 3] = 255;
            }
          }
          offCtx.putImageData(img, 0, 0);
        }
        worldMapCacheRef.current = { key: cacheKey, canvas: offCanvas };
      }

      const [leftPx, topPx] = toPx(-worldMapRadius, -worldMapRadius);
      const [rightPx, bottomPx] = toPx(worldMapRadius, worldMapRadius);
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(offCanvas, leftPx, topPx, rightPx - leftPx, bottomPx - topPx);
      ctx.restore();

      // Land window footprints (each Land = 312m x 312m) & region labels
      const centroids = computeRegionCentroids(worldMap);
      ctx.save();
      for (const region of worldMap.regions) {
        const c = centroids.get(region.code);
        const anchor = region.origin ?? (c && c.cellCount > 0 ? [c.x, c.z] : null);
        if (!anchor) continue;
        const selected = store.selectedWorldLandCode === region.code;
        const [fLeft, fTop] = toPx(anchor[0] - IslandTerrain.radius, anchor[1] - IslandTerrain.radius);
        const [fRight, fBottom] = toPx(anchor[0] + IslandTerrain.radius, anchor[1] + IslandTerrain.radius);
        ctx.strokeStyle = selected ? '#FFFFFF' : region.colorHex;
        ctx.globalAlpha = selected ? 0.72 : 0.34;
        ctx.lineWidth = selected ? 1.8 : 1.1;
        ctx.setLineDash([5, 4]);
        ctx.strokeRect(fLeft, fTop, fRight - fLeft, fBottom - fTop);
      }
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;

      ctx.font = '800 12px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const region of worldMap.regions) {
        const c = centroids.get(region.code);
        if (!c || c.cellCount === 0) continue;
        const [lx, ly] = toPx(c.x, c.z);
        const text = region.name || `Land ${region.code}`;
        const metrics = ctx.measureText(text);
        const pillW = Math.max(48, metrics.width + 18);
        const pillH = 22;
        const selected = store.selectedWorldLandCode === region.code;
        ctx.fillStyle = 'rgba(15, 23, 42, 0.84)';
        ctx.beginPath();
        ctx.roundRect(lx - pillW * 0.5, ly - pillH * 0.5, pillW, pillH, 8);
        ctx.fill();
        ctx.strokeStyle = selected ? '#FFFFFF' : region.colorHex;
        ctx.lineWidth = selected ? 2.2 : 1.5;
        ctx.stroke();
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(text, lx, ly + 0.5);
      }
      ctx.restore();

      // Hover brush ring in World Map mode
      if (hoverWorld && !worldMapSelectMode && !shiftHeld && !isPanning) {
        const [px, py] = toPx(hoverWorld[0], hoverWorld[1]);
        const activeRegion = worldMap.regions.find((r) => r.code === store.selectedWorldLandCode);
        const ringColor =
          store.worldMapBrushMode === 'terrain'
            ? WORLD_TERRAIN_YELLOW
            : store.worldMapBrushMode === 'eraseTerrain'
            ? '#F2545B'
            : store.worldMapBrushMode === 'clearLand'
            ? '#94A3B8'
            : activeRegion?.colorHex ?? '#20B46A';
        ctx.strokeStyle = ringColor;
        ctx.lineWidth = 2.2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.arc(px, py, Math.max(6, activeBrushRadius * scaleM), 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      ctx.restore();
      return;
    }

    // LAND EDIT MODE: Render terrain cells + turn bordering/other lands gray
    const size = terrain.size;
    const width = size + 1;
    const stepM = (2 * IslandTerrain.radius) / size;
    const cellPx = Math.max(1.6, stepM * scaleM + 0.65);
    const originX = activeRegionOrigin?.[0] ?? 0;
    const originZ = activeRegionOrigin?.[1] ?? 0;
    const checkNeighborLands = Boolean(worldMap && activeRegionCode && activeRegionCode > 0);

    for (let row = 0; row < size; row++) {
      const vz = -IslandTerrain.radius + (row + 0.5) * stepM;
      for (let col = 0; col < size; col++) {
        const vx = -IslandTerrain.radius + (col + 0.5) * stepM;
        const dist = Math.hypot(vx, vz);
        if (!isFreeform && dist > IslandTerrain.shoreRadius * 0.99) continue;
        const idx = row * width + col;

        const wmCell = checkNeighborLands
          ? sampleWorldMapAtWorld(worldMap, originX + vx, originZ + vz)
          : null;
        const isGrayNeighbor = Boolean(
          wmCell && wmCell.land === 1 && wmCell.regionCode !== activeRegionCode
        );

        const height = terrain.heights[idx];
        const layer = terrain.layers[idx] ?? 0;

        let color: string;
        if (isGrayNeighbor) {
          color = WORLD_BORDER_GRAY;
        } else {
          color = LAYER_COLORS[layer] ?? LAYER_COLORS[0];
          if (height <= IslandTerrain.waterLevel - 0.15) {
            if (isFreeform) continue;
            color = '#1B6B93';
          } else if (height > (terrain.mountainConfig?.snowStartHeight ?? 10.5)) {
            color = '#E2E8F0';
          } else if (height > (terrain.mountainConfig?.rockStartHeight ?? 5.5) && layer === 0) {
            color = '#767D89';
          }
        }

        const [px, py] = toPx(vx, vz);
        ctx.fillStyle = color;
        ctx.fillRect(px - cellPx * 0.5, py - cellPx * 0.5, cellPx, cellPx);

        if (isGrayNeighbor && wmCell?.isBorder) {
          ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
          ctx.fillRect(px - cellPx * 0.5, py - cellPx * 0.5, cellPx, cellPx);
        } else if (!isGrayNeighbor && height > 2.2 && height > IslandTerrain.waterLevel) {
          const shadeAlpha = Math.min(0.32, (height - 2.2) * 0.025);
          ctx.fillStyle = `rgba(255,255,255,${shadeAlpha.toFixed(3)})`;
          ctx.fillRect(px - cellPx * 0.5, py - cellPx * 0.5, cellPx, cellPx);
        }
      }
    }

    // Dimmed labels on neighboring gray lands visible inside this Land's window
    if (worldMap && activeRegionCode) {
      const centroids = computeRegionCentroids(worldMap);
      ctx.save();
      ctx.font = '700 11px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const region of worldMap.regions) {
        if (region.code === activeRegionCode) continue;
        const c = centroids.get(region.code);
        if (!c || c.cellCount === 0) continue;
        const localX = c.x - originX;
        const localZ = c.z - originZ;
        if (
          Math.abs(localX) > IslandTerrain.shoreRadius * 1.15 ||
          Math.abs(localZ) > IslandTerrain.shoreRadius * 1.15
        ) {
          continue;
        }
        const [lx, ly] = toPx(localX, localZ);
        ctx.fillStyle = 'rgba(15, 23, 42, 0.55)';
        ctx.fillText(region.name, lx + 1, ly + 1);
        ctx.fillStyle = 'rgba(226, 232, 240, 0.65)';
        ctx.fillText(region.name, lx, ly);
      }
      ctx.restore();
    }

    // Water bodies overlay
    const waterBodies = terrain.waterBodies ?? createDefaultWaterBodies();
    for (const wb of waterBodies) {
      const selected = store.selectedWaterBodyId === wb.id;
      ctx.save();
      ctx.fillStyle = wb.waterColor || '#2E86AB';
      ctx.globalAlpha = 0.72;
      ctx.strokeStyle = selected ? '#FFFFFF' : 'rgba(186,230,253,0.75)';
      ctx.lineWidth = selected ? 2.5 : 1.2;

      if (wb.points && wb.points.length >= 2) {
        ctx.beginPath();
        wb.points.forEach((pt, idx) => {
          const [px, py] = toPx(pt[0], pt[1]);
          if (idx === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        });
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = wb.waterColor || '#2E86AB';
        ctx.lineWidth = Math.max(3, wb.width * scaleM);
        ctx.stroke();
      } else {
        const [px, py] = toPx(wb.center[0], wb.center[1]);
        ctx.beginPath();
        ctx.ellipse(
          px,
          py,
          Math.max(4, wb.radiusX * scaleM),
          Math.max(4, wb.radiusZ * scaleM),
          0,
          0,
          Math.PI * 2
        );
        ctx.fill();
        ctx.stroke();
      }
      ctx.restore();
    }

    // Roads / Trails overlay
    for (const road of terrain.roads ?? []) {
      if (road.points.length < 2) continue;
      const selected = store.selectedRoadId === road.id;
      ctx.save();
      ctx.beginPath();
      road.points.forEach((pt, idx) => {
        const [px, py] = toPx(pt[0], pt[1]);
        if (idx === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      });
      ctx.strokeStyle = selected ? '#FBBF24' : '#B87C4C';
      ctx.lineWidth = Math.max(2.5, road.width * scaleM);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke();
      ctx.restore();
    }

    // Scatter foliage/rock dots
    for (const item of terrain.scatter) {
      if (worldMap && activeRegionCode) {
        const wmS = sampleWorldMapAtWorld(worldMap, originX + item.x, originZ + item.z);
        if (wmS.land === 1 && wmS.regionCode !== activeRegionCode) continue;
      }
      const [px, py] = toPx(item.x, item.z);
      if (item.kind === 'pine') {
        ctx.fillStyle = '#154D2B';
        ctx.beginPath();
        ctx.arc(px, py, Math.max(1.8, 1.5 * scaleM), 0, Math.PI * 2);
        ctx.fill();
      } else if (item.kind === 'oak' || item.kind === 'birch' || item.kind === 'tree') {
        ctx.fillStyle = item.kind === 'birch' ? '#85CC4E' : '#2D7A36';
        ctx.beginPath();
        ctx.arc(px, py, Math.max(2.0, 1.7 * scaleM), 0, Math.PI * 2);
        ctx.fill();
      } else if (item.kind === 'bush' || item.kind === 'berryBush') {
        ctx.fillStyle = '#38A169';
        ctx.fillRect(px - 1.5, py - 1.5, 3, 3);
      } else if (item.kind === 'flower') {
        ctx.fillStyle = '#F472B6';
        ctx.fillRect(px - 1, py - 1, 2, 2);
      } else if (item.kind === 'rock') {
        ctx.fillStyle = '#94A3B8';
        ctx.fillRect(px - 1.8, py - 1.8, 3.6, 3.6);
      } else if (item.kind === 'custom') {
        ctx.fillStyle = '#A855F7';
        ctx.beginPath();
        ctx.arc(px, py, 2.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // Caves
    for (const cave of terrain.caves ?? []) {
      const [px, py] = toPx(cave.x, cave.z);
      const selected = store.selectedCaveId === cave.id;
      ctx.fillStyle = '#1F1B2E';
      ctx.strokeStyle = selected ? '#FFFFFF' : '#A855F7';
      ctx.lineWidth = selected ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(5, 4.2 * (cave.scale ?? 1) * scaleM), 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Placed Entities
    for (const ent of currentLevel.entities) {
      const [wx, wz] = levelBoardToWorld(currentLevel, ent.position);
      const [px, py] = toPx(wx, wz);
      const isSelected = store.selectedEntityID === ent.id;
      ctx.fillStyle =
        ent.kind === 'baddie'
          ? '#F2545B'
          : ent.kind === 'npc'
          ? ent.isBuddy
            ? '#20B46A'
            : '#7C5CFF'
          : ent.buildingBlock || ent.kind === 'door'
          ? '#F59E0B'
          : '#38BDF8';
      ctx.beginPath();
      ctx.arc(px, py, isSelected ? 5.5 : 3.8, 0, Math.PI * 2);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    }

    // Hover brush ring
    if (hoverWorld && tool !== 'inspect' && !shiftHeld && !isPanning) {
      const [px, py] = toPx(hoverWorld[0], hoverWorld[1]);
      const activeMeta = PAINTER_2D_TOOLS.find((t) => t.id === tool);
      ctx.strokeStyle = activePlacementAssetId ? '#20B46A' : activeMeta?.accent ?? '#FFFFFF';
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.arc(
        px,
        py,
        activePlacementAssetId ? 10 : Math.max(6, brushRadius * scaleM),
        0,
        Math.PI * 2
      );
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }, [
    currentLevel,
    terrain,
    worldMap,
    isWorldMapMode,
    isFreeform,
    activeRegionCode,
    activeRegionOrigin,
    worldMapRadius,
    viewShoreRadius,
    worldMapSelectMode,
    zoom,
    pan,
    hoverWorld,
    tool,
    brushRadius,
    activeBrushRadius,
    activePlacementAssetId,
    shiftHeld,
    isPanning,
    store.selectedEntityID,
    store.selectedWaterBodyId,
    store.selectedCaveId,
    store.selectedRoadId,
    store.selectedWorldLandCode,
    store.worldMapBrushMode,
  ]);

  const applyStrokeAtPoint = useCallback(
    (wx: number, wz: number, isStart: boolean) => {
      if (isWorldMapMode) {
        if (worldMapSelectMode) {
          if (!isStart || !worldMap) return;
          const res = sampleWorldMapAtWorld(worldMap, wx, wz);
          if (res.land === 1 && res.regionCode > 0) {
            const now = performance.now();
            const prev = lastLandClickRef.current;
            store.setSelectedWorldLandCode(res.regionCode);
            if (prev && prev.code === res.regionCode && now - prev.time < 360) {
              const targetRegion = worldMap.regions.find((r) => r.code === res.regionCode);
              if (targetRegion) {
                store.enterWorldEditorScope(targetRegion.levelId);
              }
              lastLandClickRef.current = null;
            } else {
              lastLandClickRef.current = { code: res.regionCode, time: now };
            }
          } else {
            store.setSelectedWorldLandCode(null);
            lastLandClickRef.current = null;
          }
          return;
        }
        const now = performance.now();
        if (!isStart && now - lastStrokeMsRef.current < 45) return;
        lastStrokeMsRef.current = now;
        store.applyWorldMapBrushStroke(
          store.worldMapBrushMode,
          wx,
          wz,
          activeBrushRadius,
          isStart,
          isStart
        );
        return;
      }

      if (activePlacementAssetId) {
        if (isStart) {
          onPlaceCustomAssetAtWorldPoint(activePlacementAssetId, wx, wz);
        }
        return;
      }

      if (tool === 'inspect' && currentLevel) {
        if (!isStart) return;
        // Pick closest entity, cave, or water body near click
        let bestDist = 10;
        let hitEntityId: string | null = null;
        for (const ent of currentLevel.entities) {
          const [ex, ez] = levelBoardToWorld(currentLevel, ent.position);
          const d = Math.hypot(ex - wx, ez - wz);
          if (d < bestDist) {
            bestDist = d;
            hitEntityId = ent.id;
          }
        }
        if (hitEntityId) {
          onSelectEntityFrom2D(hitEntityId);
          return;
        }
        for (const cave of terrain.caves ?? []) {
          if (Math.hypot(cave.x - wx, cave.z - wz) < 12) {
            store.setSelectedCaveId(cave.id);
            store.setActiveWorldDomain('caves');
            return;
          }
        }
        for (const wb of terrain.waterBodies ?? []) {
          if (Math.hypot(wb.center[0] - wx, wb.center[1] - wz) < Math.max(wb.radiusX, 12)) {
            store.setSelectedWaterBodyId(wb.id);
            store.setActiveWorldDomain('water');
            return;
          }
        }
        return;
      }

      if (tool === 'inspect') return;
      const now = performance.now();
      if (!isStart && now - lastStrokeMsRef.current < 65) return;
      lastStrokeMsRef.current = now;
      store.apply2DOverviewStroke(tool, wx, wz, activeBrushRadius, density, isStart, isStart);
    },
    [
      activeBrushRadius,
      activePlacementAssetId,
      currentLevel,
      density,
      isWorldMapMode,
      onPlaceCustomAssetAtWorldPoint,
      onSelectEntityFrom2D,
      store,
      terrain.caves,
      terrain.waterBodies,
      tool,
      worldMap,
      worldMapSelectMode,
    ]
  );

  if (!currentLevel) return null;

  return (
    <div
      ref={containerRef}
      className="w-full h-full relative bg-[#0D2438] select-none overflow-hidden"
      onDragOver={(e) => {
        if (!isWorldMapMode && e.dataTransfer.types.includes(MAKER_ASSET_DRAG_MIME)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
        }
      }}
      onDrop={(e) => {
        if (isWorldMapMode) return;
        const assetId = e.dataTransfer.getData(MAKER_ASSET_DRAG_MIME);
        if (!assetId) return;
        e.preventDefault();
        const [wx, wz] = screenToWorld(e.clientX, e.clientY);
        onPlaceCustomAssetAtWorldPoint(assetId, wx, wz);
      }}
    >
      <canvas
        ref={canvasRef}
        className="w-full h-full block touch-none"
        style={{
          cursor: isPanning
            ? 'grabbing'
            : shiftHeld
            ? 'grab'
            : (isWorldMapMode ? worldMapSelectMode : tool === 'inspect')
            ? 'default'
            : 'crosshair',
        }}
        onPointerDown={(e) => {
          setShiftHeld(e.shiftKey);
          if (e.button === 1 || e.button === 2 || e.shiftKey) {
            panningRef.current = {
              startX: e.clientX,
              startY: e.clientY,
              origPan: [...pan] as [number, number],
            };
            setIsPanning(true);
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // ignore pointer capture fallback
            }
            return;
          }
          paintingRef.current = true;
          const [wx, wz] = screenToWorld(e.clientX, e.clientY);
          setHoverWorld([wx, wz]);
          applyStrokeAtPoint(wx, wz, true);
        }}
        onPointerMove={(e) => {
          if (e.shiftKey !== shiftHeld) {
            setShiftHeld(e.shiftKey);
          }
          if (panningRef.current) {
            const dx = e.clientX - panningRef.current.startX;
            const dy = e.clientY - panningRef.current.startY;
            setPan([panningRef.current.origPan[0] + dx, panningRef.current.origPan[1] + dy]);
            return;
          }
          const [wx, wz] = screenToWorld(e.clientX, e.clientY);
          setHoverWorld([wx, wz]);
          if (paintingRef.current) {
            applyStrokeAtPoint(wx, wz, false);
          }
        }}
        onPointerUp={(e) => {
          paintingRef.current = false;
          panningRef.current = null;
          setIsPanning(false);
          setShiftHeld(e.shiftKey);
          try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
              e.currentTarget.releasePointerCapture(e.pointerId);
            }
          } catch {
            // ignore release fallback
          }
        }}
        onPointerCancel={() => {
          paintingRef.current = false;
          panningRef.current = null;
          setIsPanning(false);
        }}
        onPointerLeave={() => {
          if (!panningRef.current) {
            paintingRef.current = false;
            setHoverWorld(null);
          }
        }}
        onContextMenu={(e) => e.preventDefault()}
        onWheel={(e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.12 : 0.89;
          const maxZoom = isWorldMapMode ? 6 : 3.5;
          setZoom((z) => Math.max(0.65, Math.min(maxZoom, z * factor)));
        }}
      />

      {(isPanning || shiftHeld) && (
        <div
          className="pointer-events-none absolute top-3 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-black/82 text-white text-[11px] font-bold border border-white/20 shadow-lg"
          data-testid="pan-hand-indicator"
        >
          <Hand
            size={14}
            className={isPanning ? 'text-[#20B46A] scale-95' : 'text-amber-300'}
          />
          <span>{isPanning ? 'Panning' : 'Shift · Drag to Pan'}</span>
        </div>
      )}

      {/* Generic 2D World Blocking Palette (World Map vs Land Edit) */}
      <div className="absolute left-3 bottom-3 right-3 flex flex-wrap items-center justify-between gap-2 pointer-events-none">
        {isWorldMapMode && worldMap ? (
          <div className="pointer-events-auto flex flex-wrap items-center gap-1 p-1.5 rounded-2xl bg-[#111521]/95 border border-white/15 shadow-xl max-w-3xl">
            <button
              type="button"
              onClick={() => setWorldMapSelectMode(true)}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-xl text-[11px] font-bold transition-colors whitespace-nowrap ${
                worldMapSelectMode
                  ? 'bg-[#7C5CFF] text-white'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <MousePointer2 size={12} />
              <span>Select</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setWorldMapSelectMode(false);
                store.setWorldMapBrushMode('terrain');
              }}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] font-extrabold transition-colors whitespace-nowrap ${
                !worldMapSelectMode && store.worldMapBrushMode === 'terrain'
                  ? 'bg-[#E5C67E] text-slate-900 shadow-xs'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <span
                className="w-2.5 h-2.5 rounded-full border border-black/25 shrink-0"
                style={{ backgroundColor: WORLD_TERRAIN_YELLOW }}
              />
              <span>Terrain</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setWorldMapSelectMode(false);
                store.setWorldMapBrushMode('eraseTerrain');
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] font-bold transition-colors whitespace-nowrap ${
                !worldMapSelectMode && store.worldMapBrushMode === 'eraseTerrain'
                  ? 'bg-[#F2545B] text-white'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <Eraser size={12} />
              <span>Erase Land</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setWorldMapSelectMode(false);
                store.setWorldMapBrushMode('clearLand');
              }}
              className={`inline-flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] font-bold transition-colors whitespace-nowrap ${
                !worldMapSelectMode && store.worldMapBrushMode === 'clearLand'
                  ? 'bg-slate-500 text-white'
                  : 'text-slate-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              <span>Unassign</span>
            </button>

            <div className="h-4 w-px bg-white/15 mx-0.5" />

            {worldMap.regions.map((region) => {
              const paintingThisLand =
                !worldMapSelectMode &&
                store.worldMapBrushMode === 'paintLand' &&
                store.selectedWorldLandCode === region.code;
              return (
                <button
                  key={region.id}
                  type="button"
                  onClick={() => {
                    setWorldMapSelectMode(false);
                    store.setSelectedWorldLandCode(region.code);
                    store.setWorldMapBrushMode('paintLand');
                  }}
                  onDoubleClick={() => store.enterWorldEditorScope(region.levelId)}
                  title="Paint this Land color on terrain (Double-click to edit Land)"
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[11px] font-extrabold transition-colors whitespace-nowrap ${
                    paintingThisLand
                      ? 'text-white shadow-xs ring-2 ring-white/70'
                      : 'bg-white/10 text-slate-200 hover:bg-white/20'
                  }`}
                  style={paintingThisLand ? { backgroundColor: region.colorHex } : undefined}
                >
                  <span
                    className="w-2.5 h-2.5 rounded-full border border-white/50 shrink-0"
                    style={{ backgroundColor: region.colorHex }}
                  />
                  <span className="max-w-[96px] truncate">{region.name}</span>
                </button>
              );
            })}

            <button
              type="button"
              onClick={() => {
                setWorldMapSelectMode(false);
                store.addWorldLandRegion();
              }}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-xl bg-[#7C5CFF] hover:bg-[#6A48F5] text-white text-[11px] font-extrabold whitespace-nowrap"
            >
              <Plus size={12} />
              <span>New Land</span>
            </button>

            <label className="inline-flex items-center gap-1 px-2 py-1 rounded-xl bg-white/5 text-slate-300 text-[10px] font-bold cursor-pointer">
              <input
                type="checkbox"
                checked={store.worldMapAutoLand}
                onChange={(e) => store.setWorldMapAutoLand(e.target.checked)}
                className="accent-[#20B46A]"
              />
              <span>Auto-Land</span>
            </label>
          </div>
        ) : (
          <div className="pointer-events-auto flex flex-wrap items-center gap-1 p-1.5 rounded-2xl bg-[#111521]/95 border border-white/15 shadow-xl max-w-3xl">
            {PAINTER_2D_TOOLS.map((item) => {
              const Icon = item.Icon;
              const active = !activePlacementAssetId && tool === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setTool(item.id)}
                  className={`inline-flex items-center gap-1 px-2 py-1 rounded-xl text-[11px] font-bold transition-colors whitespace-nowrap ${
                    active
                      ? item.id === 'terrain'
                        ? 'text-slate-900 shadow-xs'
                        : 'text-white shadow-xs'
                      : 'text-slate-300 hover:bg-white/10 hover:text-white'
                  }`}
                  style={active ? { backgroundColor: item.accent } : undefined}
                >
                  <Icon size={12} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        )}

        {/* Brush Radius / Density / Zoom */}
        <div className="pointer-events-auto flex items-center gap-2.5 px-3 py-1.5 rounded-2xl bg-[#111521]/95 border border-white/15 text-white text-[11px] font-bold shadow-xl">
          <label className="inline-flex items-center gap-1.5">
            <span className="text-slate-400">Size</span>
            <input
              type="range"
              min={isWorldMapMode ? 6 : 3}
              max={isWorldMapMode ? 120 : 28}
              step={isWorldMapMode ? 2 : 1}
              value={activeBrushRadius}
              onChange={(e) => setActiveBrushRadius(Number(e.target.value))}
              className="w-16 accent-[#F59E0B]"
            />
            <span className="tabular-nums w-9 text-right">{activeBrushRadius}m</span>
          </label>
          {!isWorldMapMode && (
            <label className="inline-flex items-center gap-1.5">
              <span className="text-slate-400">Density</span>
              <input
                type="range"
                min={0.2}
                max={1}
                step={0.05}
                value={density}
                onChange={(e) => setDensity(Number(e.target.value))}
                className="w-14 accent-[#20B46A]"
              />
            </label>
          )}
          <div className="flex items-center gap-0.5 pl-1 border-l border-white/15">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.65, z * 0.85))}
              className="p-1 rounded hover:bg-white/10"
              title="Zoom Out"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(isWorldMapMode ? 6 : 3.5, z * 1.15))}
              className="p-1 rounded hover:bg-white/10"
              title="Zoom In"
            >
              <ZoomIn size={13} />
            </button>
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setPan([0, 0]);
              }}
              className="p-1 rounded hover:bg-white/10"
              title="Reset Pan & Zoom"
            >
              <RotateCcw size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* Hover world coordinates + elevation readout */}
      {hoverWorld && (
        <div className="pointer-events-none absolute bottom-16 left-3 px-2.5 py-1 rounded-lg bg-black/70 text-white text-[10px] font-mono tabular-nums">
          X {hoverWorld[0].toFixed(1)}m · Z {hoverWorld[1].toFixed(1)}m ·{' '}
          {isWorldMapMode
            ? `World ${worldMapRadius * 2}×${worldMapRadius * 2}m`
            : `Y ${sampleTerrainHeight(terrain, hoverWorld[0], hoverWorld[1]).toFixed(1)}m`}
        </div>
      )}
    </div>
  );
};
