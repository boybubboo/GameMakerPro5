import type {
  GameLevel,
  GameProject,
  TerrainData,
  WorldLandRegion,
  WorldMapData,
} from '../types/maker';
import {
  IslandTerrain,
  createDefaultDirtAndRoadConfig,
  createDefaultMountainConfig,
  createInitialTerrain,
  uid,
} from './terrain';

export const WORLD_TERRAIN_YELLOW = '#E5C67E';
export const WORLD_BORDER_GRAY = '#6E7582';

/**
 * Original template island radius (156m) rounded up to 160m, then multiplied by 4 -> 640m radius (1280m x 1280m).
 * Each individual Land / Level map stays at IslandTerrain.radius (156m, 312m x 312m).
 */
export const WORLD_MAP_BASE_RADIUS = Math.ceil(IslandTerrain.radius / 10) * 10; // 160m
export const WORLD_MAP_SCALE = 4;
export const WORLD_MAP_RADIUS = WORLD_MAP_BASE_RADIUS * WORLD_MAP_SCALE; // 640m (1280m x 1280m)
export const WORLD_MAP_GRID_SIZE = 320; // 4m per grid cell across [-640, +640]

export const LAND_REGION_PALETTE = [
  '#20B46A', // Emerald Meadow
  '#F2545B', // Ember Coral
  '#0EA5E9', // Azure Coast
  '#A855F7', // Mystic Violet
  '#F59E0B', // Sunstone Gold
  '#EC4899', // Blossom Rose
  '#14B8A6', // Seafoam Vale
  '#6366F1', // Twilight Indigo
  '#84CC16', // Moss Highlands
  '#F97316', // Canyon Ochre
];

export type WorldMapBrushMode = 'terrain' | 'eraseTerrain' | 'paintLand' | 'clearLand';

export function getWorldMapRadius(worldMap?: Pick<WorldMapData, 'worldRadius'>): number {
  return worldMap?.worldRadius && worldMap.worldRadius > 0
    ? worldMap.worldRadius
    : WORLD_MAP_RADIUS;
}

export function getRegionOrigin(region?: Pick<WorldLandRegion, 'origin'>): [number, number] {
  return region?.origin ?? [0, 0];
}

export function clampRegionOrigin(
  x: number,
  z: number,
  worldRadius = WORLD_MAP_RADIUS
): [number, number] {
  const maxOffset = Math.max(0, worldRadius - IslandTerrain.radius);
  return [
    Math.round(Math.max(-maxOffset, Math.min(maxOffset, x))),
    Math.round(Math.max(-maxOffset, Math.min(maxOffset, z))),
  ];
}

export function landLocalToWorldMap(
  localX: number,
  localZ: number,
  origin?: [number, number]
): [number, number] {
  const ox = origin?.[0] ?? 0;
  const oz = origin?.[1] ?? 0;
  return [ox + localX, oz + localZ];
}

export function worldMapToLandLocal(
  worldX: number,
  worldZ: number,
  origin?: [number, number]
): [number, number] {
  const ox = origin?.[0] ?? 0;
  const oz = origin?.[1] ?? 0;
  return [worldX - ox, worldZ - oz];
}

export function createEmptyWorldMap(): WorldMapData {
  const size = WORLD_MAP_GRID_SIZE;
  const count = (size + 1) * (size + 1);
  return {
    gridSize: size,
    worldRadius: WORLD_MAP_RADIUS,
    landMask: new Array(count).fill(0),
    regionGrid: new Array(count).fill(0),
    regions: [],
    revision: 1,
  };
}

export function createScratchOceanTerrain(): TerrainData {
  const size = IslandTerrain.gridSize;
  const count = (size + 1) * (size + 1);
  return {
    size,
    heights: new Array(count).fill(IslandTerrain.seaFloor),
    layers: new Array(count).fill(1),
    scatter: [],
    caves: [],
    mountainConfig: createDefaultMountainConfig(),
    waterBodies: [],
    dirtAndRoadConfig: createDefaultDirtAndRoadConfig(),
    roads: [],
    freeformWorld: true,
    revision: 1,
  };
}

export function ensureWorldMapForProject(project: GameProject): WorldMapData {
  const size = WORLD_MAP_GRID_SIZE;
  const targetRadius = WORLD_MAP_RADIUS;
  const expectedLen = (size + 1) * (size + 1);
  const existing = project.worldMap;
  if (
    existing &&
    existing.worldRadius === targetRadius &&
    existing.gridSize === size &&
    existing.landMask.length === expectedLen &&
    existing.regionGrid.length === expectedLen
  ) {
    return existing;
  }

  const landMask = new Array<number>(expectedLen).fill(0);
  const regionGrid = new Array<number>(expectedLen).fill(0);
  const width = size + 1;

  // Upgrade legacy 1:1 (156m / 156-grid) WorldMap into the center of the 4x (640m / 320-grid) WorldMap
  if (
    existing &&
    existing.gridSize > 0 &&
    existing.landMask.length === (existing.gridSize + 1) * (existing.gridSize + 1) &&
    existing.regionGrid.length === existing.landMask.length
  ) {
    const oldSize = existing.gridSize;
    const oldWidth = oldSize + 1;
    const oldRadius =
      existing.worldRadius && existing.worldRadius > 0
        ? existing.worldRadius
        : IslandTerrain.radius;
    const targetStep = (2 * targetRadius) / size;

    for (let row = 0; row <= size; row++) {
      const wz = -targetRadius + row * targetStep;
      if (Math.abs(wz) > oldRadius + 0.01) continue;
      const oldRow = Math.max(
        0,
        Math.min(oldSize, Math.round(((wz + oldRadius) / (2 * oldRadius)) * oldSize))
      );
      for (let col = 0; col <= size; col++) {
        const wx = -targetRadius + col * targetStep;
        if (Math.abs(wx) > oldRadius + 0.01) continue;
        const oldCol = Math.max(
          0,
          Math.min(oldSize, Math.round(((wx + oldRadius) / (2 * oldRadius)) * oldSize))
        );
        const oldIdx = oldRow * oldWidth + oldCol;
        if (existing.landMask[oldIdx] === 1) {
          const idx = row * width + col;
          landMask[idx] = 1;
          regionGrid[idx] = existing.regionGrid[oldIdx] ?? 0;
        }
      }
    }

    return {
      gridSize: size,
      worldRadius: targetRadius,
      landMask,
      regionGrid,
      regions: existing.regions.map((r) => ({
        ...r,
        origin: r.origin ?? [0, 0],
      })),
      revision: (existing.revision ?? 1) + 1,
    };
  }

  const firstOpenLevel =
    project.levels.find((l) => !l.environmentType || l.environmentType === 'openWorld') ??
    project.levels[0];

  const regions: WorldLandRegion[] = [];

  if (firstOpenLevel) {
    const srcTerrain = firstOpenLevel.terrain ?? createInitialTerrain();
    const srcSize = srcTerrain.size;
    const srcWidth = srcSize + 1;
    const srcRadius = IslandTerrain.radius;
    const regionCode = 1;
    regions.push({
      id: `region-${firstOpenLevel.id}`,
      code: regionCode,
      name: firstOpenLevel.name || 'Land 1',
      colorHex: LAND_REGION_PALETTE[0],
      levelId: firstOpenLevel.id,
      origin: [0, 0],
    });
    if (srcTerrain.heights.length === srcWidth * srcWidth) {
      const targetStep = (2 * targetRadius) / size;
      for (let row = 0; row <= size; row++) {
        const wz = -targetRadius + row * targetStep;
        if (Math.abs(wz) > srcRadius + 0.01) continue;
        const srcRow = Math.max(
          0,
          Math.min(srcSize, Math.round(((wz + srcRadius) / (2 * srcRadius)) * srcSize))
        );
        for (let col = 0; col <= size; col++) {
          const wx = -targetRadius + col * targetStep;
          if (Math.abs(wx) > srcRadius + 0.01) continue;
          const srcCol = Math.max(
            0,
            Math.min(srcSize, Math.round(((wx + srcRadius) / (2 * srcRadius)) * srcSize))
          );
          if (srcTerrain.heights[srcRow * srcWidth + srcCol] > IslandTerrain.waterLevel - 0.15) {
            const idx = row * width + col;
            landMask[idx] = 1;
            regionGrid[idx] = regionCode;
          }
        }
      }
    }
  }

  return {
    gridSize: size,
    worldRadius: targetRadius,
    landMask,
    regionGrid,
    regions,
    revision: 1,
  };
}

export function sampleWorldMapAtWorld(
  worldMap: WorldMapData | undefined,
  x: number,
  z: number
): { land: number; regionCode: number; isBorder: boolean } {
  if (!worldMap || worldMap.landMask.length === 0) {
    return { land: 0, regionCode: 0, isBorder: false };
  }
  const r = getWorldMapRadius(worldMap);
  if (x < -r || x > r || z < -r || z > r) {
    return { land: 0, regionCode: 0, isBorder: false };
  }
  const size = worldMap.gridSize;
  const width = size + 1;
  const col = Math.max(0, Math.min(size, Math.round(((x + r) / (2 * r)) * size)));
  const row = Math.max(0, Math.min(size, Math.round(((z + r) / (2 * r)) * size)));
  const idx = row * width + col;
  const land = worldMap.landMask[idx] ?? 0;
  const regionCode = worldMap.regionGrid[idx] ?? 0;

  let isBorder = false;
  if (land === 1) {
    const neighbors = [
      row > 0 ? (row - 1) * width + col : -1,
      row < size ? (row + 1) * width + col : -1,
      col > 0 ? row * width + (col - 1) : -1,
      col < size ? row * width + (col + 1) : -1,
    ];
    for (const ni of neighbors) {
      if (ni < 0) continue;
      if (worldMap.landMask[ni] === 0 || worldMap.regionGrid[ni] !== regionCode) {
        isBorder = true;
        break;
      }
    }
  }

  return { land, regionCode, isBorder };
}

export function sampleWorldMapForLand(
  worldMap: WorldMapData | undefined,
  localX: number,
  localZ: number,
  regionOrigin?: [number, number]
): { land: number; regionCode: number; isBorder: boolean } {
  const ox = regionOrigin?.[0] ?? 0;
  const oz = regionOrigin?.[1] ?? 0;
  return sampleWorldMapAtWorld(worldMap, ox + localX, oz + localZ);
}

export function applyWorldMapStroke(
  worldMap: WorldMapData,
  mode: WorldMapBrushMode,
  x: number,
  z: number,
  radius: number,
  regionCode?: number,
  autoFillOcean = false
): WorldMapData {
  const size = worldMap.gridSize;
  const width = size + 1;
  const worldRadius = getWorldMapRadius(worldMap);
  const step = (2 * worldRadius) / size;
  const r = Math.max(2, radius);

  const minCol = Math.max(1, Math.floor(((x - r + worldRadius) / (2 * worldRadius)) * size) - 1);
  const maxCol = Math.min(size - 1, Math.ceil(((x + r + worldRadius) / (2 * worldRadius)) * size) + 1);
  const minRow = Math.max(1, Math.floor(((z - r + worldRadius) / (2 * worldRadius)) * size) - 1);
  const maxRow = Math.min(size - 1, Math.ceil(((z + r + worldRadius) / (2 * worldRadius)) * size) + 1);

  const landMask = [...worldMap.landMask];
  const regionGrid = [...worldMap.regionGrid];
  let changed = false;

  for (let row = minRow; row <= maxRow; row++) {
    const vz = -worldRadius + row * step;
    for (let col = minCol; col <= maxCol; col++) {
      const vx = -worldRadius + col * step;
      if (Math.hypot(vx - x, vz - z) > r) continue;
      const idx = row * width + col;

      if (mode === 'terrain') {
        if (landMask[idx] !== 1) {
          landMask[idx] = 1;
          changed = true;
        }
        if (regionCode && regionCode > 0 && regionGrid[idx] !== regionCode) {
          regionGrid[idx] = regionCode;
          changed = true;
        }
      } else if (mode === 'eraseTerrain') {
        if (landMask[idx] !== 0 || regionGrid[idx] !== 0) {
          landMask[idx] = 0;
          regionGrid[idx] = 0;
          changed = true;
        }
      } else if (mode === 'paintLand' && regionCode && regionCode > 0) {
        if (landMask[idx] === 1 || autoFillOcean) {
          if (landMask[idx] !== 1) {
            landMask[idx] = 1;
            changed = true;
          }
          if (regionGrid[idx] !== regionCode) {
            regionGrid[idx] = regionCode;
            changed = true;
          }
        }
      } else if (mode === 'clearLand') {
        if (regionGrid[idx] !== 0) {
          regionGrid[idx] = 0;
          changed = true;
        }
      }
    }
  }

  if (!changed) return worldMap;

  return {
    ...worldMap,
    landMask,
    regionGrid,
    revision: worldMap.revision + 1,
  };
}

export function syncLevelTerrainWithWorldMap(
  rawTerrain: TerrainData | undefined,
  worldMap: WorldMapData,
  activeRegionCode?: number,
  regionOrigin?: [number, number]
): TerrainData {
  const base =
    rawTerrain && rawTerrain.size === IslandTerrain.gridSize
      ? rawTerrain
      : createScratchOceanTerrain();
  const size = base.size;
  const width = size + 1;
  const heights = [...base.heights];
  const layers = [...base.layers];

  const localRadius = IslandTerrain.radius;
  const localStep = (2 * localRadius) / size;
  const ox = regionOrigin?.[0] ?? 0;
  const oz = regionOrigin?.[1] ?? 0;

  // Sample the 4x WorldMap window centered at [ox, oz] onto this Land's local grid
  const localLandMask = new Uint8Array(width * width);
  const localRegionGrid = new Uint16Array(width * width);
  for (let row = 0; row <= size; row++) {
    const wz = oz + (-localRadius + row * localStep);
    for (let col = 0; col <= size; col++) {
      const wx = ox + (-localRadius + col * localStep);
      const s = sampleWorldMapAtWorld(worldMap, wx, wz);
      const idx = row * width + col;
      localLandMask[idx] = s.land;
      localRegionGrid[idx] = s.regionCode;
    }
  }

  for (let row = 0; row <= size; row++) {
    for (let col = 0; col <= size; col++) {
      const idx = row * width + col;
      const hasLand = localLandMask[idx] === 1;

      if (!hasLand) {
        if (heights[idx] > IslandTerrain.waterLevel - 0.6) {
          // Gentle underwater transition if touching a land cell
          const touchesLand =
            (row > 0 && localLandMask[(row - 1) * width + col] === 1) ||
            (row < size && localLandMask[(row + 1) * width + col] === 1) ||
            (col > 0 && localLandMask[row * width + (col - 1)] === 1) ||
            (col < size && localLandMask[row * width + (col + 1)] === 1);
          heights[idx] = touchesLand ? IslandTerrain.waterLevel - 0.7 : IslandTerrain.seaFloor;
        } else {
          heights[idx] = Math.min(heights[idx], IslandTerrain.waterLevel - 0.65);
        }
        layers[idx] = 1;
        continue;
      }

      const cellCode = localRegionGrid[idx] ?? 0;
      const isCoast =
        row === 0 ||
        row === size ||
        col === 0 ||
        col === size ||
        localLandMask[(row - 1) * width + col] === 0 ||
        localLandMask[(row + 1) * width + col] === 0 ||
        localLandMask[row * width + (col - 1)] === 0 ||
        localLandMask[row * width + (col + 1)] === 0;

      const isOtherLand =
        activeRegionCode !== undefined &&
        activeRegionCode > 0 &&
        cellCode !== activeRegionCode;

      if (isOtherLand) {
        // Keep neighboring / bordering lands visible as calm landmass (rendered gray in 2D & 3D)
        if (heights[idx] < IslandTerrain.waterLevel + 0.1) {
          heights[idx] = isCoast ? 0.25 : IslandTerrain.baseTop;
        }
      } else {
        // Active land: preserve sculpted height above sea, raise newly added terrain cells
        if (heights[idx] < IslandTerrain.waterLevel - 0.15) {
          heights[idx] = isCoast ? 0.3 : IslandTerrain.baseTop;
          layers[idx] = isCoast ? 1 : 0;
        }
      }
    }
  }

  return {
    ...base,
    heights,
    layers,
    freeformWorld: true,
    revision: (base.revision ?? 1) + 1,
  };
}

export function computeRegionCentroids(
  worldMap: WorldMapData
): Map<number, { x: number; z: number; cellCount: number }> {
  const size = worldMap.gridSize;
  const width = size + 1;
  const r = getWorldMapRadius(worldMap);
  const step = (2 * r) / size;
  const accum = new Map<number, { sx: number; sz: number; count: number }>();

  for (let row = 0; row <= size; row++) {
    const vz = -r + row * step;
    for (let col = 0; col <= size; col++) {
      if (worldMap.landMask[row * width + col] !== 1) continue;
      const code = worldMap.regionGrid[row * width + col] ?? 0;
      if (code <= 0) continue;
      const vx = -r + col * step;
      const entry = accum.get(code);
      if (entry) {
        entry.sx += vx;
        entry.sz += vz;
        entry.count += 1;
      } else {
        accum.set(code, { sx: vx, sz: vz, count: 1 });
      }
    }
  }

  const out = new Map<number, { x: number; z: number; cellCount: number }>();
  accum.forEach((v, code) => {
    if (v.count > 0) {
      out.set(code, {
        x: v.sx / v.count,
        z: v.sz / v.count,
        cellCount: v.count,
      });
    }
  });
  return out;
}

export function findNextRegionCode(regions: WorldLandRegion[]): number {
  const used = new Set(regions.map((r) => r.code));
  for (let c = 1; c < 255; c++) {
    if (!used.has(c)) return c;
  }
  return regions.length + 1;
}

export function pickNextRegionColor(regions: WorldLandRegion[]): string {
  const used = new Set(regions.map((r) => r.colorHex.toUpperCase()));
  for (const hex of LAND_REGION_PALETTE) {
    if (!used.has(hex.toUpperCase())) return hex;
  }
  return LAND_REGION_PALETTE[regions.length % LAND_REGION_PALETTE.length];
}

export function createLandLevelFromTemplate(
  baseLevel: GameLevel | undefined,
  name: string,
  worldMap: WorldMapData,
  regionCode: number,
  regionOrigin?: [number, number]
): GameLevel {
  const levelId = uid();
  const terrain = syncLevelTerrainWithWorldMap(
    createScratchOceanTerrain(),
    worldMap,
    regionCode,
    regionOrigin
  );
  return {
    id: levelId,
    name,
    style: 'openWorld',
    environmentType: 'openWorld',
    visualStyle: baseLevel?.visualStyle ?? 'painterlyPBR',
    biome: baseLevel?.biome ?? 'meadow',
    sky: baseLevel?.sky ?? 'sunny',
    sunAngle: baseLevel?.sunAngle ?? 38,
    timeOfDay: baseLevel?.timeOfDay,
    fog: baseLevel?.fog ?? 0.25,
    hasStart: true,
    hasPortal: true,
    completeCondition: 'reachPortal',
    requiredCount: 0,
    objectives: [
      { id: uid(), text: `Explore ${name}`, isOptional: false },
    ],
    entities: [],
    terrain,
    grass: baseLevel?.grass
      ? { ...baseLevel.grass }
      : {
          enabled: true,
          quality: 'lush',
          viewDistance: 55,
          bladeHeight: 0.72,
          bladeWidth: 0.09,
          windWaveStrength: 0.85,
          tipGlow: 0.22,
          interactiveParting: true,
        },
    audio: baseLevel?.audio
      ? { ...baseLevel.audio }
      : {
          mood: 'adventure',
          coin: 'coin',
          hit: 'hit',
          door: 'creak',
          portal: 'chime',
          jump: 'jump',
          step: 'step',
        },
    weather: 'none',
    vistaPreset: 'coastalArchipelago',
    vistaDensity: 0.7,
    canopyEngine: baseLevel?.canopyEngine ? JSON.parse(JSON.stringify(baseLevel.canopyEngine)) : undefined,
    wind: baseLevel?.wind ?? 0.45,
    canSwim: true,
    notes: '',
    startPoint: { x: 0.5, y: 0.55 },
    portalPoint: { x: 0.56, y: 0.44 },
  };
}
