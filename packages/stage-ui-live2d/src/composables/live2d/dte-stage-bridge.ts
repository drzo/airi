import type { Cubism4InternalModel } from 'pixi-live2d-display/cubism4'

import { defineEventa } from '@moeru/eventa'
import { createContext as createWindowContext } from '@moeru/eventa/adapters/window-message'

import * as v from 'valibot'

/** The wire event accepts unknown input. Validation belongs to the stage, not the sender. */
export const dteStageCueEvent = defineEventa<unknown>('airi:dte:stage:cue:v1')
export const dteStageReleaseEvent = defineEventa<unknown>('airi:dte:stage:release:v1')
export const dteStageHelloEvent = defineEventa<undefined>('airi:dte:stage:hello:v1')
export const dteStageReadyEvent = defineEventa<{ modelId: string, modelSha256: string }>('airi:dte:stage:ready:v1')
export const dteStageAckEvent = defineEventa<{ leaseId: string, accepted: boolean }>('airi:dte:stage:ack:v1')

const digestPattern = /^[a-f0-9]{64}$/
const modelPattern = /^[a-z0-9][a-z0-9_-]{1,63}$/
const leasePattern = /^[\w-]{8,64}$/
const signedAxis = v.pipe(v.number(), v.finite(), v.minValue(-1), v.maxValue(1))
const unsignedAxis = v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1))
const poseSchema = v.strictObject({
  eyeX: v.optional(signedAxis),
  eyeY: v.optional(signedAxis),
  eyeSquint: v.optional(unsignedAxis),
  headX: v.optional(signedAxis),
  headY: v.optional(signedAxis),
  headZ: v.optional(signedAxis),
  bodyX: v.optional(signedAxis),
  bodyY: v.optional(signedAxis),
  bodyZ: v.optional(signedAxis),
})
const cueSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal('dte.presentation.cue'),
  modelId: v.pipe(v.string(), v.regex(modelPattern)),
  modelSha256: v.pipe(v.string(), v.regex(digestPattern)),
  leaseId: v.pipe(v.string(), v.regex(leasePattern)),
  observedAt: v.pipe(v.number(), v.finite()),
  expiresAt: v.pipe(v.number(), v.finite()),
  expressionName: v.nullable(v.string()),
  motion: v.nullable(v.string()),
  pose: poseSchema,
})
const releaseSchema = v.strictObject({ leaseId: v.pipe(v.string(), v.regex(leasePattern)) })
type StageCue = v.InferOutput<typeof cueSchema>

/** A selected archive and its real hash are owned by AIRI, never by an inbound cue. */
export interface StageModelIdentity {
  id: string
  archiveSha256: string
}

/** Hash the selected model archive once. Reject large or unreadable archives instead of trusting a sender-provided hash. */
export async function hashSelectedArchive(source: string, request: typeof fetch = fetch): Promise<string> {
  const response = await request(source)
  const sizeLimit = 64 * 1024 * 1024
  if (!response.ok || Number(response.headers.get('content-length')) > sizeLimit)
    throw new Error('The selected model archive cannot be verified.')
  const bytes = await response.arrayBuffer()
  if (bytes.byteLength === 0 || bytes.byteLength > sizeLimit)
    throw new Error('The selected model archive size is not supported by this bridge.')
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Presentation-only lease state. No messages or cognitive identity enter AIRI through this boundary. */
export class DteStageBridge {
  private current: StageCue | undefined
  private readonly retired = new Set<string>()
  private mostRecentObservation = -Infinity
  private timeout: ReturnType<typeof setTimeout> | undefined
  private stopped = false

  constructor(private readonly selected: StageModelIdentity, private readonly now: () => number = Date.now) {
    if (!modelPattern.test(selected.id) || !digestPattern.test(selected.archiveSha256))
      throw new Error('The AIRI stage requires a valid selected model and archive hash.')
  }

  /** Reject unknown fields, missing model bytes, replay, future samples, and unsupported motion ownership. */
  receive(input: unknown): boolean {
    if (this.stopped)
      return false
    const parsed = v.safeParse(cueSchema, input)
    if (!parsed.success) {
      this.release()
      return false
    }
    const cue = parsed.output
    const time = this.now()
    // The first stage pilot owns pose only. Speech, expressions, and motion stay with AIRI.
    if (cue.expressionName !== null || cue.motion !== null || !Object.keys(cue.pose).length
      || cue.modelId !== this.selected.id || cue.modelSha256 !== this.selected.archiveSha256
      || !Number.isFinite(time) || cue.observedAt > time || time - cue.observedAt > 500
      || cue.expiresAt <= time || cue.expiresAt <= cue.observedAt || cue.expiresAt - time > 3_000
      || this.retired.has(cue.leaseId) || this.retired.size >= 1_024) {
      this.release()
      return false
    }
    // A retransmission must not extend a lease or cancel a valid cue.
    if (cue.observedAt <= this.mostRecentObservation)
      return false
    if (this.current && this.current.leaseId !== cue.leaseId)
      this.release()
    this.current = cue
    this.mostRecentObservation = cue.observedAt
    if (this.timeout)
      clearTimeout(this.timeout)
    this.timeout = setTimeout(() => this.release(), cue.expiresAt - time)
    return true
  }

  /** Release only the current DTE-owned lease. Other stage motion and speech remain unchanged. */
  release(leaseId?: string): void {
    if (leaseId && this.current?.leaseId !== leaseId)
      return
    if (this.current)
      this.retired.add(this.current.leaseId)
    this.current = undefined
    if (this.timeout)
      clearTimeout(this.timeout)
    this.timeout = undefined
  }

  /** A render frame sees only a cue that still owns the selected model and live time window. */
  snapshot(): Readonly<StageCue['pose']> | undefined {
    if (this.stopped || !this.current)
      return undefined
    const time = this.now()
    if (!Number.isFinite(time) || time < this.current.observedAt || time >= this.current.expiresAt) {
      this.release()
      return undefined
    }
    return this.current.pose
  }

  dispose(): void {
    this.release()
    this.stopped = true
  }
}

/** Apply only eye, head, and body values after AIRI manual motion and before AIRI lip sync. */
export function applyDtePose(model: Pick<Cubism4InternalModel['coreModel'], 'getParameterValueById' | 'setParameterValueById'>, pose: Readonly<StageCue['pose']> | undefined): void {
  if (!pose)
    return
  if (pose.eyeX !== undefined)
    model.setParameterValueById('ParamEyeBallX', pose.eyeX)
  if (pose.eyeY !== undefined)
    model.setParameterValueById('ParamEyeBallY', pose.eyeY)
  if (pose.eyeSquint !== undefined) {
    const remaining = 1 - pose.eyeSquint
    model.setParameterValueById('ParamEyeLOpen', model.getParameterValueById('ParamEyeLOpen') * remaining)
    model.setParameterValueById('ParamEyeROpen', model.getParameterValueById('ParamEyeROpen') * remaining)
  }
  for (const [axis, parameter, range] of [
    ['headX', 'ParamAngleX', 30],
    ['headY', 'ParamAngleY', 30],
    ['headZ', 'ParamAngleZ', 30],
    ['bodyX', 'ParamBodyAngleX', 10],
    ['bodyY', 'ParamBodyAngleY', 10],
    ['bodyZ', 'ParamBodyAngleZ', 10],
  ] as const) {
    const value = pose[axis]
    if (value !== undefined)
      model.setParameterValueById(parameter, value * range)
  }
}

/** Open an opt-in Eventa channel only for a popup or iframe with an exact loopback DTE origin. */
export function openDteWindowBridge(options: {
  selected: StageModelIdentity
  currentWindow: Window
  parentOrigin: string
  now?: () => number
}): { bridge: DteStageBridge, dispose: () => void } {
  const { currentWindow, parentOrigin } = options
  const parentUrl = new URL(parentOrigin)
  const sourceWindow = currentWindow.opener ?? currentWindow.parent
  if (sourceWindow === currentWindow || !['localhost', '127.0.0.1'].includes(currentWindow.location.hostname)
    || !['localhost', '127.0.0.1'].includes(parentUrl.hostname) || !parentUrl.port
    || parentUrl.origin !== parentOrigin) {
    throw new Error('The DTE stage bridge requires an exact loopback parent origin with an explicit port.')
  }

  const bridge = new DteStageBridge(options.selected, options.now)
  const channel = createWindowContext({
    channel: 'airi:dte:stage:v1',
    currentWindow,
    targetWindow: () => sourceWindow,
    expectedSource: () => sourceWindow,
    expectedOrigin: parentOrigin,
    targetOrigin: parentOrigin,
  })
  const offCue = channel.context.on(dteStageCueEvent, (event) => {
    const parsed = v.safeParse(cueSchema, event.body)
    const accepted = bridge.receive(event.body)
    if (parsed.success)
      void channel.context.emit(dteStageAckEvent, { leaseId: parsed.output.leaseId, accepted })
  })
  const offRelease = channel.context.on(dteStageReleaseEvent, (event) => {
    const result = v.safeParse(releaseSchema, event.body)
    if (result.success)
      bridge.release(result.output.leaseId)
  })
  const announceReady = () => {
    void channel.context.emit(dteStageReadyEvent, { modelId: options.selected.id, modelSha256: options.selected.archiveSha256 })
  }
  const offHello = channel.context.on(dteStageHelloEvent, announceReady)
  const visibility = () => {
    if (currentWindow.document.hidden)
      bridge.release()
  }
  currentWindow.document.addEventListener('visibilitychange', visibility)
  announceReady()
  return {
    bridge,
    dispose: () => {
      currentWindow.document.removeEventListener('visibilitychange', visibility)
      offCue()
      offRelease()
      offHello()
      channel.dispose()
      bridge.dispose()
    },
  }
}
