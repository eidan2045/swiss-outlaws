// Small helper to assemble static geometry (quads/tris/boxes) with compact vertex formats.
import * as THREE from 'three';

export class MeshBuilder {
  pos: number[] = [];
  nor: number[] = [];
  uv: number[] = [];
  col: number[] = []; // rgba 0..1 (may exceed 1 when floatColor)
  acc: number[] = []; // rgba 0..1
  idx: number[] = [];
  count = 0;
  // current vertex attributes
  r = 1; g = 1; b = 1; a = 1;
  ar = 1; ag = 1; ab = 1; aa = 0;

  constructor(private opts: { accent?: boolean; floatColor?: boolean; normUv?: boolean } = {}) {}

  color(r: number, g: number, b: number, a = 1): this {
    this.r = r; this.g = g; this.b = b; this.a = a;
    return this;
  }
  accent(r: number, g: number, b: number, a = 0): this {
    this.ar = r; this.ag = g; this.ab = b; this.aa = a;
    return this;
  }
  vert(x: number, y: number, z: number, nx: number, ny: number, nz: number, u: number, v: number): number {
    this.pos.push(x, y, z);
    this.nor.push(nx, ny, nz);
    this.uv.push(u, v);
    this.col.push(this.r, this.g, this.b, this.a);
    if (this.opts.accent) this.acc.push(this.ar, this.ag, this.ab, this.aa);
    return this.count++;
  }
  /** Quad a,b,c,d counter-clockwise seen from the front; uv: (u0,v0) at a, (u1,v1) at c. */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, u0 = 0, v0 = 0, u1 = 1, v1 = 1): void {
    // normal from (b-a) x (d-a)
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = dx - ax, e2y = dy - ay, e2z = dz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i = this.vert(ax, ay, az, nx, ny, nz, u0, v0);
    this.vert(bx, by, bz, nx, ny, nz, u1, v0);
    this.vert(cx, cy, cz, nx, ny, nz, u1, v1);
    this.vert(dx, dy, dz, nx, ny, nz, u0, v1);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 3);
  }
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, ua = 0, va = 0, ub = 1, vb = 0, uc = 0.5, vc = 1): void {
    const e1x = bx - ax, e1y = by - ay, e1z = bz - az, e2x = cx - ax, e2y = cy - ay, e2z = cz - az;
    let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= l; ny /= l; nz /= l;
    const i = this.vert(ax, ay, az, nx, ny, nz, ua, va);
    this.vert(bx, by, bz, nx, ny, nz, ub, vb);
    this.vert(cx, cy, cz, nx, ny, nz, uc, vc);
    this.idx.push(i, i + 1, i + 2);
  }
  /**
   * Oriented box. Centre (cx,cy,cz), half extents (hx,hy,hz), yaw rotation (sin, cos):
   * local x axis = (cos,0,-sin), local z axis = (sin,0,cos). uvScale maps metres → uv.
   */
  box(cx: number, cy: number, cz: number, hx: number, hy: number, hz: number, sin = 0, cos = 1, uvScale = 0, top = true, bottom = false): void {
    const X = (lx: number, lz: number) => cx + cos * lx + sin * lz;
    const Z = (lx: number, lz: number) => cz - sin * lx + cos * lz;
    const y0 = cy - hy, y1 = cy + hy;
    const us = uvScale || 1;
    const U = (m: number) => (uvScale ? m * us : m > 0 ? 1 : 0);
    // +z (front), -z (back), +x, -x
    const side = (x0: number, z0: number, x1: number, z1: number, len: number) => {
      this.quad(X(x0, z0), y0, Z(x0, z0), X(x1, z1), y0, Z(x1, z1), X(x1, z1), y1, Z(x1, z1), X(x0, z0), y1, Z(x0, z0), 0, 0, uvScale ? len * us : 1, uvScale ? 2 * hy * us : 1);
    };
    side(-hx, hz, hx, hz, 2 * hx);
    side(hx, -hz, -hx, -hz, 2 * hx);
    side(hx, hz, hx, -hz, 2 * hz);
    side(-hx, -hz, -hx, hz, 2 * hz);
    if (top) this.quad(X(-hx, hz), y1, Z(-hx, hz), X(hx, hz), y1, Z(hx, hz), X(hx, -hz), y1, Z(hx, -hz), X(-hx, -hz), y1, Z(-hx, -hz), 0, 0, U(2 * hx), U(2 * hz));
    if (bottom) this.quad(X(-hx, -hz), y0, Z(-hx, -hz), X(hx, -hz), y0, Z(hx, -hz), X(hx, hz), y0, Z(hx, hz), X(-hx, hz), y0, Z(-hx, hz), 0, 0, U(2 * hx), U(2 * hz));
  }

  get empty(): boolean {
    return this.count === 0;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    const n = new Int8Array(this.count * 4);
    for (let i = 0; i < this.count; i++) {
      n[i * 4] = Math.round(this.nor[i * 3] * 127);
      n[i * 4 + 1] = Math.round(this.nor[i * 3 + 1] * 127);
      n[i * 4 + 2] = Math.round(this.nor[i * 3 + 2] * 127);
    }
    g.setAttribute('normal', new THREE.BufferAttribute(n, 4, true));
    if (this.opts.normUv) {
      const u = new Uint16Array(this.count * 2);
      for (let i = 0; i < u.length; i++) u[i] = Math.max(0, Math.min(65535, Math.round(this.uv[i] * 65535)));
      g.setAttribute('uv', new THREE.BufferAttribute(u, 2, true));
    } else g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(this.uv), 2));
    if (this.opts.floatColor) g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 4));
    else {
      const c = new Uint8Array(this.count * 4);
      for (let i = 0; i < c.length; i++) c[i] = Math.max(0, Math.min(255, Math.round(this.col[i] * 255)));
      g.setAttribute('color', new THREE.BufferAttribute(c, 4, true));
    }
    if (this.opts.accent) {
      const c = new Uint8Array(this.count * 4);
      for (let i = 0; i < c.length; i++) c[i] = Math.max(0, Math.min(255, Math.round(this.acc[i] * 255)));
      g.setAttribute('aAccent', new THREE.BufferAttribute(c, 4, true));
    }
    g.setIndex(this.count > 65535 ? new THREE.BufferAttribute(new Uint32Array(this.idx), 1) : new THREE.BufferAttribute(new Uint16Array(this.idx), 1));
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
  }
}
