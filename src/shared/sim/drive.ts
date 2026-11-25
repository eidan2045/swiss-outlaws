// Path-following driver used by traffic, police and tests: pure pursuit steering + speed control.
import { angleDiff, clamp } from '../math';
import { VehState, VehicleSpec } from './types';
import { VehInput } from './vehicle';

/** Steer towards a target point and hold a target speed. */
export function driveTo(v: VehState, spec: VehicleSpec, tx: number, tz: number, targetSpeed: number, out: VehInput): VehInput {
  const dx = tx - v.x, dz = tz - v.z;
  const want = Math.atan2(dx, dz);
  const err = angleDiff(v.yaw, want);
  const fx = Math.sin(v.yaw), fz = Math.cos(v.yaw);
  const vf = v.vx * fx + v.vz * fz;
  const dist = Math.sqrt(dx * dx + dz * dz);
  // pure pursuit: curvature = 2 sin(err) / lookahead
  const curv = (2 * Math.sin(err)) / Math.max(2.5, dist);
  const delta = Math.atan(curv * spec.wheelbase);
  const steerLimit = Math.max(0.16, 1 / (1 + (Math.abs(vf) / 19) ** 2 * 1.1));
  // yaw + is left, steer input + is right
  out.steer = clamp(-delta / (spec.steerMax * steerLimit), -1, 1);
  let target = targetSpeed;
  if (target >= 0) {
    // slow down for sharp turns
    target = Math.min(target, Math.max(2.5, Math.sqrt((spec.grip * 5.2) / Math.max(0.004, Math.abs(curv)))));
    const dv = target - vf;
    out.throttle = dv > 0 ? clamp(dv * 0.5, 0.05, 1) : dv < -1.2 ? clamp(dv * 0.35, -1, 0) : 0;
    if (targetSpeed === 0 && Math.abs(vf) < 0.6) out.throttle = 0;
    out.handbrake = targetSpeed === 0 && Math.abs(vf) < 0.6;
  } else {
    // reverse
    const dv = target - vf;
    out.steer = -out.steer;
    out.throttle = dv < 0 ? clamp(dv * 0.5, -1, -0.05) : 0.3;
    out.handbrake = false;
  }
  return out;
}
