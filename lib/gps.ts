/**
 * Frontend GPS boundary.
 *
 * Leaflet markers consume WGS84 decimal degrees in [latitude, longitude]
 * order. The upstream field names already express that contract; this guard
 * preserves the exact provided decimals, rejects impossible values and repairs
 * an unmistakably swapped pair only when the reversed pair is valid (with an
 * India-bounds tie-breaker for this India fleet).
 */

export interface GpsCoordinate {
  lat: number;
  lon: number;
}

const INDIA = { latMin: 6, latMax: 37, lonMin: 68, lonMax: 98 } as const;

const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isWorldCoordinate = (lat: number, lon: number) => lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;
const isIndiaCoordinate = (lat: number, lon: number) =>
  lat >= INDIA.latMin && lat <= INDIA.latMax && lon >= INDIA.lonMin && lon <= INDIA.lonMax;

export function normalizeGpsCoordinates(latitude: unknown, longitude: unknown): GpsCoordinate | null {
  if (!isFiniteNumber(latitude) || !isFiniteNumber(longitude)) return null;

  const directValid = isWorldCoordinate(latitude, longitude);
  const swappedValid = isWorldCoordinate(longitude, latitude);
  const directInIndia = directValid && isIndiaCoordinate(latitude, longitude);
  const swappedInIndia = swappedValid && isIndiaCoordinate(longitude, latitude);

  if (directInIndia) return { lat: latitude, lon: longitude };
  if (swappedInIndia) return { lat: longitude, lon: latitude };
  if (directValid) return { lat: latitude, lon: longitude };
  if (swappedValid) return { lat: longitude, lon: latitude };
  return null;
}

/**
 * Spherical centroid for WGS84 points. A plain latitude/longitude average is
 * increasingly biased across a wide cluster and fails around the antimeridian.
 */
export function geographicCentroid(points: readonly GpsCoordinate[]): GpsCoordinate | null {
  if (points.length === 0) return null;
  if (points.length === 1) return { ...points[0] };

  let x = 0;
  let y = 0;
  let z = 0;
  for (const point of points) {
    const lat = point.lat * Math.PI / 180;
    const lon = point.lon * Math.PI / 180;
    const cosLat = Math.cos(lat);
    x += cosLat * Math.cos(lon);
    y += cosLat * Math.sin(lon);
    z += Math.sin(lat);
  }

  x /= points.length;
  y /= points.length;
  z /= points.length;
  const horizontal = Math.hypot(x, y);
  if (horizontal === 0 && z === 0) return null;

  return {
    lat: Math.atan2(z, horizontal) * 180 / Math.PI,
    lon: Math.atan2(y, x) * 180 / Math.PI,
  };
}
