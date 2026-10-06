import { afterEach, describe, expect, it, vi } from 'vitest'

import { applyDtePose, DteStageBridge } from './dte-stage-bridge'

const selected = { id: 'miara', archiveSha256: 'a'.repeat(64) }
const baseCue = {
  schemaVersion: 1,
  kind: 'dte.presentation.cue',
  modelId: 'miara',
  modelSha256: selected.archiveSha256,
  leaseId: 'lease-001',
  observedAt: 9_950,
  expiresAt: 12_000,
  expressionName: null,
  motion: null,
  pose: { eyeX: 0.5, headY: -0.25, bodyZ: 0.4, eyeSquint: 0.25 },
}

afterEach(() => vi.useRealTimers())

describe('dTE stage cue boundary', () => {
  it('accepts only a fresh cue for the selected archive', () => {
    const bridge = new DteStageBridge(selected, () => 10_000)
    expect(bridge.receive(baseCue)).toBe(true)
    expect(bridge.snapshot()).toEqual(baseCue.pose)
    expect(bridge.receive(baseCue)).toBe(false)
    expect(bridge.snapshot()).toEqual(baseCue.pose)
    bridge.release('different-lease')
    expect(bridge.snapshot()).toEqual(baseCue.pose)
    bridge.release(baseCue.leaseId)
    expect(bridge.snapshot()).toBeUndefined()
    expect(bridge.receive({ ...baseCue, observedAt: 9_951 })).toBe(false)
    bridge.dispose()
  })

  it('rejects cues for another archive or unsupported stage-owned fields', () => {
    const bridge = new DteStageBridge(selected, () => 10_000)
    for (const cue of [
      { ...baseCue, modelSha256: 'b'.repeat(64) },
      { ...baseCue, expressionName: 'Surprised' },
      { ...baseCue, pose: { mouthOpen: 1 } },
      { ...baseCue, pose: { headX: Number.NaN } },
      { ...baseCue, pose: { headX: 1.5 } },
      { ...baseCue, secret: 'injected' },
      { ...baseCue, observedAt: 8_000 },
      { ...baseCue, expiresAt: 15_000 },
    ]) {
      expect(bridge.receive(cue)).toBe(false)
      expect(bridge.snapshot()).toBeUndefined()
    }
    bridge.dispose()
  })

  it('expires without render frames and refuses the retired lease after expiry', () => {
    vi.useFakeTimers()
    let time = 10_000
    const bridge = new DteStageBridge(selected, () => time)
    expect(bridge.receive(baseCue)).toBe(true)
    time = 12_001
    vi.advanceTimersByTime(2_001)
    expect(bridge.snapshot()).toBeUndefined()
    expect(bridge.receive({ ...baseCue, observedAt: 12_000, expiresAt: 12_500 })).toBe(false)
    expect(bridge.receive({ ...baseCue, leaseId: 'lease-002', observedAt: 12_000, expiresAt: 13_000 })).toBe(true)
    bridge.dispose()
    expect(bridge.snapshot()).toBeUndefined()
  })

  it('overlays eye/head/body values after AIRI motion without touching mouth or offsets', () => {
    const parameters = new Map<string, number>([
      ['ParamEyeLOpen', 0.8],
      ['ParamEyeROpen', 0.4],
      ['ParamMouthOpenY', 0.6],
      ['ParamMouthForm', -0.2],
      ['ParamBreath', 0.3],
    ])
    const model = {
      getParameterValueById: vi.fn((id: string) => parameters.get(id) ?? 0),
      setParameterValueById: vi.fn((id: string, value: number) => { parameters.set(id, value) }),
    }
    applyDtePose(model, baseCue.pose)
    expect(parameters.get('ParamEyeBallX')).toBe(0.5)
    expect(parameters.get('ParamAngleY')).toBe(-7.5)
    expect(parameters.get('ParamBodyAngleZ')).toBe(4)
    expect(parameters.get('ParamEyeLOpen')).toBeCloseTo(0.6)
    expect(parameters.get('ParamEyeROpen')).toBeCloseTo(0.3)
    expect(parameters.get('ParamMouthOpenY')).toBe(0.6)
    expect(parameters.get('ParamMouthForm')).toBe(-0.2)
    expect(parameters.get('ParamBreath')).toBe(0.3)
    applyDtePose(model, undefined)
    expect(model.setParameterValueById).toHaveBeenCalledTimes(5)
  })
})
