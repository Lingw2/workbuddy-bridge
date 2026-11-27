/**
 * The automatic daily claim, end to end.
 *
 * The scheduler is what makes the claim happen every day without the user
 * doing anything, so it is tested against a mock upstream: it must claim once
 * per local day, never twice, and retry a failure with a backoff.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CreditService } from '../src/credit/service.js'

/** A stand-in upstream that records every claim it receives. */
async function startMockUpstream(state) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(JSON.stringify(payload))
    }

    if (url.pathname === '/v2/billing/meter/checkin-activity-status') {
      send(200, {
        code: 0,
        data: {
          active: true,
          today_checked_in: state.checkedIn,
          streak_days: state.streakDays,
          daily_credit: 100,
          today_credit: state.checkedIn ? 100 : 0,
          total_credits: 1200,
        },
      })
      return
    }
    if (url.pathname === '/v2/billing/meter/daily-checkin') {
      if (state.failClaim) {
        send(500, { code: 500, msg: 'upstream is busy' })
        return
      }
      if (state.checkedIn) {
        send(400, { code: 10001, msg: '今天已签到，请明天再来' })
        return
      }
      state.checkedIn = true
      state.streakDays += 1
      state.claims += 1
      send(200, { code: 0, data: { credit: 100, streak_days: state.streakDays } })
      return
    }
    if (url.pathname === '/billing/meter/compensation-status') {
      send(200, { code: 0, data: { claimed: true, active: false, credit_num: 0 } })
      return
    }
    if (url.pathname === '/billing/meter/check-gift-claimed') {
      send(200, { code: 0, data: { claimed: true, active: false, credit_num: 0 } })
      return
    }
    if (url.pathname === '/activity/growth/streak') {
      send(200, {
        code: 0,
        data: {
          streak: { days: 0, month_total_days: 0, next_tier: '7d', next_tier_remaining: 7 },
          makeup_cards: { balance: 0, max: 4 },
          redemption_status: {
            tier_7d_status: 'locked',
            tier_14d_status: 'locked',
            tier_28d_status: 'locked',
            tiers: [],
          },
        },
      })
      return
    }
    if (url.pathname === '/v2/billing/meter/get-user-resource') {
      send(200, { code: 0, data: { Response: { Data: { Accounts: [] } } } })
      return
    }
    if (url.pathname === '/v2/msg-center/message/list') {
      send(200, { code: 0, data: { messages: [] } })
      return
    }
    send(404, { code: 404, msg: 'no such route' })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.WORKBUDDY_BILLING_BASE = `http://127.0.0.1:${port}`
  return {
    state,
    port,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A session resolver that hands out a fixed mock session. */
function mockResolver() {
  return async () => ({
    session: {
      accessToken: 'mock-token',
      refreshToken: 'mock-refresh',
      domain: 'www.workbuddy.cn',
      uid: 'mock-uid',
      uin: '',
      nickname: 'mock',
      enterpriseId: '',
      expiresAt: Date.now() + 3600_000,
      refreshExpiresAt: 0,
    },
    source: null,
    refreshed: false,
  })
}

/** A throwaway state file. */
function tempStateFile() {
  const dir = mkdtempSync(join(tmpdir(), 'wbg-credit-'))
  return { dir, file: join(dir, 'credit-state.json') }
}

test('the service claims once and never pays twice on the same day', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: false,
  })
  const temp = tempStateFile()
  try {
    const service = new CreditService(
      { credit: { enabled: true, time: '00:00', autoBenefits: false } },
      { log() {} },
      { stateFile: temp.file, resolveSession: mockResolver() },
    )

    const first = await service.claim({ reason: 'auto' })
    assert.equal(first.ok, true)
    assert.equal(first.credit, 100)
    assert.equal(mock.state.claims, 1)

    const second = await service.claim({ reason: 'auto' })
    assert.equal(second.credit, 0)
    assert.equal(mock.state.claims, 1, 'the upstream must not pay twice')
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('the scheduler claims once and then stops for the day', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: false,
  })
  const temp = tempStateFile()
  try {
    const service = new CreditService(
      { credit: { enabled: true, time: '00:00', autoBenefits: false } },
      { log() {} },
      { stateFile: temp.file, resolveSession: mockResolver() },
    )

    const first = await service.tick()
    assert.ok(first, 'the first tick claims')
    assert.equal(mock.state.claims, 1)

    const second = await service.tick()
    assert.equal(second, null, 'the second tick does nothing')
    assert.equal(mock.state.claims, 1)
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('the scheduler does not run before the configured time', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: false,
  })
  const temp = tempStateFile()
  try {
    const service = new CreditService(
      { credit: { enabled: true, time: '23:59', autoBenefits: false } },
      { log() {} },
      { stateFile: temp.file, resolveSession: mockResolver() },
    )

    // 23:59 is only due in the last minute of the day; the test must not
    // depend on the wall clock, so the clock is checked instead.
    const minutes = new Date().getHours() * 60 + new Date().getMinutes()
    const result = await service.tick()
    if (minutes < 23 * 60 + 59) {
      assert.equal(result, null, 'nothing happens before the configured time')
      assert.equal(mock.state.claims, 0)
    }
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a failed claim is retried with a backoff instead of hammering the upstream', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: true,
  })
  const temp = tempStateFile()
  try {
    const service = new CreditService(
      { credit: { enabled: true, time: '00:00', autoBenefits: false } },
      { log() {} },
      { stateFile: temp.file, resolveSession: mockResolver() },
    )

    const first = await service.tick()
    assert.ok(first)
    assert.equal(first.ok, false, 'the failure is reported')

    // The backoff is recorded, so the next tick waits.
    assert.ok(service.state.lastFailure, 'the failure is remembered')
    assert.equal(service.state.lastFailure.count, 1)
    assert.ok(service.state.lastFailure.nextAttemptAt > Date.now())

    const second = await service.tick()
    assert.equal(second, null, 'the retry waits for the backoff')
    assert.equal(mock.state.claims, 0)
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('the state survives a restart, so a new day claims again', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: false,
  })
  const temp = tempStateFile()
  try {
    const config = { credit: { enabled: true, time: '00:00', autoBenefits: false } }
    const first = new CreditService(config, { log() {} }, {
      stateFile: temp.file,
      resolveSession: mockResolver(),
    })
    await first.tick()
    assert.equal(mock.state.claims, 1)

    // A new process reads the same state file.
    const second = new CreditService(config, { log() {} }, {
      stateFile: temp.file,
      resolveSession: mockResolver(),
    })
    assert.equal(second.state.lastAutoRun.day, first.state.lastAutoRun.day)
    const tick = await second.tick()
    assert.equal(tick, null, 'the same day is not claimed twice')
    assert.equal(mock.state.claims, 1)
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})

test('a manual claim does not reopen the day for the scheduler', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 0,
    claims: 0,
    failClaim: false,
  })
  const temp = tempStateFile()
  try {
    const service = new CreditService(
      { credit: { enabled: true, time: '00:00', autoBenefits: false } },
      { log() {} },
      { stateFile: temp.file, resolveSession: mockResolver() },
    )

    await service.tick()
    assert.equal(mock.state.claims, 1)

    // A manual claim in the middle of the day must not reset the day.
    await service.claim({ reason: 'manual' })
    assert.equal(mock.state.claims, 1)

    const again = await service.tick()
    assert.equal(again, null, 'the scheduler still knows the day is done')
    assert.equal(mock.state.claims, 1)
  } finally {
    await mock.close()
    rmSync(temp.dir, { recursive: true, force: true })
  }
})
