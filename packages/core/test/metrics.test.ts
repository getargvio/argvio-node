import { afterEach, describe, expect, it } from 'vitest'
import type { Attributes } from '@opentelemetry/api'

import {
  AttrCounterName,
  AttrMeasureName,
  AttrValueName,
  Client,
  Tier,
  counter,
  createClient,
  duration,
  getDefaultClient,
  setDefaultClient,
  value,
} from '../src/index.js'

interface Rec {
  value: number
  attributes: Attributes
}

function fakeClient(tier: Tier = Tier.Anonymous) {
  const counterAdds: Rec[] = []
  const measureRecords: Rec[] = []
  const valueRecords: Rec[] = []
  const client = new Client({
    cliName: 'testcli',
    installIdPath: undefined,
    disabled: false,
    initError: null,
    tier,
    queueSize: 100,
    shutdownTimeoutMs: 100,
    productCounter: {
      add: (v: number, a: Attributes) => counterAdds.push({ value: v, attributes: a }),
    },
    measureHist: {
      record: (v: number, a: Attributes) => measureRecords.push({ value: v, attributes: a }),
    },
    valueHist: {
      record: (v: number, a: Attributes) => valueRecords.push({ value: v, attributes: a }),
    },
  } as unknown as ConstructorParameters<typeof Client>[0])
  return { client, counterAdds, measureRecords, valueRecords }
}

afterEach(() => setDefaultClient(undefined))

describe('module-level metric handles', () => {
  it('works when declared before any client exists', () => {
    const vulns = counter('vulns.found', { dims: ['severity', 'check'] })
    const scan = duration('scan.time', { dims: ['kind'] })
    const ops = value('spec.operations')
    expect(() => {
      vulns.add(1, { severity: 'high', check: 'bola' })
      scan.record(5, { kind: 'openapi' })
      ops.record(3)
    }).not.toThrow()

    const { client, counterAdds, measureRecords, valueRecords } = fakeClient()
    setDefaultClient(client)
    vulns.add(2, { severity: 'high', check: 'bola' })
    scan.record(5, { kind: 'openapi' })
    ops.record(0)

    expect(counterAdds).toHaveLength(1)
    expect(counterAdds[0]).toMatchObject({
      value: 2,
      attributes: {
        [AttrCounterName]: 'vulns.found',
        'cli.dim.severity': 'high',
        'cli.dim.check': 'bola',
      },
    })
    expect(measureRecords[0]?.attributes).toMatchObject({
      [AttrMeasureName]: 'scan.time',
      'cli.dim.kind': 'openapi',
    })
    expect(valueRecords[0]).toMatchObject({
      value: 0,
      attributes: { [AttrValueName]: 'spec.operations' },
    })
  })

  it('rebinds when the default client changes', () => {
    const a = fakeClient()
    const b = fakeClient()
    const c = counter('hits')
    setDefaultClient(a.client)
    c.add(1)
    setDefaultClient(b.client)
    c.add(1)
    c.add(1)
    setDefaultClient(undefined)
    c.add(1)
    expect(a.counterAdds).toHaveLength(1)
    expect(b.counterAdds).toHaveLength(2)
  })

  it('createClient registers the default; setAsDefault: false opts out', async () => {
    const first = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(getDefaultClient()).toBe(first)
    const second = createClient('key', 'cli', '1.0.0', { disabled: true, setAsDefault: false })
    expect(second).not.toBe(first)
    expect(getDefaultClient()).toBe(first)
    const third = createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(getDefaultClient()).toBe(third)
  })

  it('is a no-op with a disabled default client', () => {
    createClient('key', 'cli', '1.0.0', { disabled: true })
    expect(() => {
      counter('ok').add(1)
      duration('ok').record(1)
      duration('ok').start()()
      value('ok').record(1)
    }).not.toThrow()
  })

  it('drops wrong or missing dimension values and invalid values', () => {
    const { client, counterAdds, measureRecords, valueRecords } = fakeClient()
    setDefaultClient(client)
    const c = counter('ok', { dims: ['severity'] })
    c.add(1)
    c.add(1, {})
    c.add(1, { other: 'x' })
    c.add(1, { severity: 'High' })
    c.add(1, { severity: 'high', extra: 'x' })
    c.add(0, { severity: 'high' })
    c.add(1.5, { severity: 'high' })
    counter('Bad').add(1)
    counter('ok', { dims: ['a', 'b', 'c', 'd'] }).add(1)
    expect(counterAdds).toHaveLength(0)
    c.add(1, { severity: 'high' })
    expect(counterAdds).toHaveLength(1)

    const d = duration('ok')
    d.record(0)
    d.record(-1)
    d.record(NaN)
    expect(measureRecords).toHaveLength(0)

    const v = value('ok')
    v.record(-1)
    v.record(NaN)
    value('ok', { unit: 'count' }).record(1)
    expect(valueRecords).toHaveLength(0)
    v.record(0)
    expect(valueRecords).toHaveLength(1)
  })

  it('start() records the elapsed time once with the given dimension values', async () => {
    const { client, measureRecords } = fakeClient()
    setDefaultClient(client)
    const scan = duration('scan.time', { dims: ['kind'] })
    const stop = scan.start({ kind: 'openapi' })
    await new Promise((r) => setTimeout(r, 15))
    stop()
    stop()
    expect(measureRecords).toHaveLength(1)
    expect(measureRecords[0]?.value).toBeGreaterThanOrEqual(10)
    expect(measureRecords[0]?.attributes).toMatchObject({ 'cli.dim.kind': 'openapi' })
  })

  it('startLate() takes the dimension values when stopped', async () => {
    const { client, measureRecords } = fakeClient()
    setDefaultClient(client)
    const stop = duration('scan.time', { dims: ['kind'] }).startLate()
    await new Promise((r) => setTimeout(r, 5))
    stop({ kind: 'graphql' })
    stop({ kind: 'rest' })
    expect(measureRecords).toHaveLength(1)
    expect(measureRecords[0]?.attributes).toMatchObject({ 'cli.dim.kind': 'graphql' })
  })
})
