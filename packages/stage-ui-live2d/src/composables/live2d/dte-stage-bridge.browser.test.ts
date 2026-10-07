import { defineEventa } from '@moeru/eventa'
import { createContext as createWindowContext } from '@moeru/eventa/adapters/window-message'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { hashSelectedArchive } from './dte-stage-bridge'

const cueEvent = defineEventa<unknown>('airi:dte:stage:cue:v1')
const helloEvent = defineEventa<undefined>('airi:dte:stage:hello:v1')
const readyEvent = defineEventa<{ modelId: string, modelSha256: string }>('airi:dte:stage:ready:v1')
const ackEvent = defineEventa<{ leaseId: string, accepted: boolean }>('airi:dte:stage:ack:v1')
const digest = 'a'.repeat(64)
const frames: HTMLIFrameElement[] = []

afterEach(() => {
  for (const frame of frames)
    frame.remove()
  frames.length = 0
})

function makeFrame(name: string) {
  const frame = document.createElement('iframe')
  frame.src = `${window.location.origin}/src/composables/live2d/fixtures/${name}.html?origin=${encodeURIComponent(window.location.origin)}`
  frames.push(frame)
  return frame
}

async function mountFrame(frame: HTMLIFrameElement) {
  const loaded = new Promise<void>(resolve => frame.addEventListener('load', () => resolve(), { once: true }))
  document.body.append(frame)
  await loaded
  if (!frame.contentWindow)
    throw new Error('Expected a browser iframe')
  return frame.contentWindow
}

describe('dTE stage browser boundary', () => {
  it('hashes selected ZIP bytes, never a cue-provided digest', async () => {
    const bytes = new TextEncoder().encode('generic-character-archive')
    const archiveUrl = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }))
    try {
      const actual = await hashSelectedArchive(archiveUrl)
      const expected = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map(value => value.toString(16).padStart(2, '0'))
        .join('')
      expect(actual).toBe(expected)
    }
    finally {
      URL.revokeObjectURL(archiveUrl)
    }
  })

  it('accepts the exact parent and rejects an Eventa cue from a second same-origin frame', async () => {
    const stageFrame = makeFrame('bridge-frame')
    const origin = window.location.origin
    const parent = createWindowContext({
      channel: 'airi:dte:stage:v1',
      currentWindow: window,
      targetWindow: () => stageFrame.contentWindow,
      expectedSource: () => stageFrame.contentWindow,
      targetOrigin: origin,
      expectedOrigin: origin,
    })
    const acks: Array<{ leaseId: string, accepted: boolean }> = []
    let ready: { modelId: string, modelSha256: string } | undefined
    let readyCount = 0
    const offReady = parent.context.on(readyEvent, (event) => {
      ready = event.body
      readyCount++
    })
    const offAck = parent.context.on(ackEvent, (event) => {
      if (event.body)
        acks.push(event.body)
    })
    let stageWindow: Window | undefined
    try {
      stageWindow = await mountFrame(stageFrame)
      await vi.waitFor(() => expect(ready).toEqual({ modelId: 'miara', modelSha256: digest }))
      await parent.context.emit(helloEvent, undefined)
      await vi.waitFor(() => expect(readyCount).toBeGreaterThan(1))
      const stage = stageWindow as Window & { dteReceiver?: { bridge: { snapshot: () => unknown }, dispose: () => void } }
      await vi.waitFor(() => expect(stage.dteReceiver).toBeDefined())
      const intruder = await mountFrame(makeFrame('intruder-frame'))
      const at = Date.now()
      const cue = {
        schemaVersion: 1,
        kind: 'dte.presentation.cue',
        modelId: 'miara',
        modelSha256: digest,
        leaseId: 'browserLease1',
        observedAt: at,
        expiresAt: at + 2500,
        expressionName: null,
        motion: null,
        pose: { headX: 0.2 },
      }
      intruder.postMessage({ kind: 'send-wrong-source', cue }, origin)
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(stage.dteReceiver?.bridge.snapshot()).toBeUndefined()
      const acceptedAt = Date.now()
      await parent.context.emit(cueEvent, { ...cue, observedAt: acceptedAt, expiresAt: acceptedAt + 2500 })
      await vi.waitFor(() => expect(acks).toContainEqual({ leaseId: 'browserLease1', accepted: true }))
      expect(stage.dteReceiver?.bridge.snapshot()).toMatchObject({ headX: 0.2 })
      stage.dteReceiver?.dispose()
    }
    finally {
      offReady()
      offAck()
      parent.dispose()
    }
  })
})
