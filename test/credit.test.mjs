/**
 * The daily credit claim, tested against a local stand-in for the upstream.
 *
 * The upstream is idempotent, so a real payout can only be watched once a
 * day on one account. These tests drive the same code paths against a mock
 * server instead, which is what makes the whole flow verifiable every time.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'

import {
  claimDailyCheckin,
  fetchBenefits,
  fetchCheckinStatus,
  fetchCredits,
  fetchGrowthStreak,
  fetchMessages,
  redeemGrowthTier,
} from '../src/upstream/credit.js'
import { localDayKey, minutesSinceMidnight, parseClock } from '../src/credit/service.js'

/** A stand-in for the WorkBuddy billing API. */
async function startMockUpstream(state) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    let body = ''
    for await (const chunk of req) body += chunk
    const send = (code, payload) => {
      const text = JSON.stringify(payload)
      res.writeHead(code, { 'content-type': 'application/json' })
      res.end(text)
    }

    if (!req.headers.authorization?.startsWith('Bearer ')) {
      send(401, { code: 401, msg: 'no token' })
      return
    }

    switch (url.pathname) {
      case '/v2/billing/meter/checkin-activity-status':
        send(200, {
          code: 0,
          data: {
            active: true,
            today_checked_in: state.checkedIn,
            streak_days: state.streakDays,
            daily_credit: 100,
            today_credit: state.checkedIn ? 100 : 0,
            is_streak_day: false,
            streak_bonus_credit: 0,
            total_credits: 1200,
            theme_name: 'Buddy加油站',
            claim_button_text: '立即领取',
          },
        })
        return
      case '/v2/billing/meter/daily-checkin':
        if (state.checkedIn) {
          send(400, { code: 10001, msg: '今天已签到，请明天再来' })
          return
        }
        state.checkedIn = true
        state.streakDays += 1
        state.claimed += 1
        send(200, {
          code: 0,
          data: { credit: 100, streak_days: state.streakDays, is_streak_day: false },
        })
        return
      case '/billing/meter/compensation-status':
        send(200, {
          code: 0,
          data: { claimed: state.compensationClaimed, active: state.compensationActive, credit_num: 500 },
        })
        return
      case '/billing/meter/check-gift-claimed':
        send(200, {
          code: 0,
          data: { claimed: state.giftClaimed, active: state.giftActive, credit_num: 1500 },
        })
        return
      case '/billing/meter/claim-compensation':
        if (state.compensationClaimed || !state.compensationActive) {
          send(400, { code: 10001, msg: '补偿领取活动未开启或已过期' })
          return
        }
        state.compensationClaimed = true
        send(200, { code: 0, data: { credit: 500 } })
        return
      case '/billing/meter/claim-gift':
        if (state.giftClaimed) {
          send(400, { code: 10001, msg: '每人限领一次，您已领取过无法重复领取' })
          return
        }
        state.giftClaimed = true
        send(200, { code: 0, data: { credit: 1500 } })
        return
      case '/activity/growth/streak':
        send(200, {
          code: 0,
          data: {
            streak: { days: 7, month_total_days: 7, next_tier: '7d', next_tier_remaining: 0 },
            makeup_cards: { balance: 1, max: 4 },
            redemption_status: {
              tier_7d_status: state.tierAvailable ? 'available' : 'locked',
              tier_14d_status: 'locked',
              tier_28d_status: 'locked',
              tiers: [{ tier: '7d', days: 7, credit: 0, energy: 2, cards: 1 }],
            },
          },
        })
        return
      case '/activity/growth/redeem':
        if (!state.tierAvailable) {
          send(400, { code: 400, msg: 'invalid redemption request' })
          return
        }
        state.tierAvailable = false
        send(200, { code: 0, data: { tier: '7d', credit: 0, energy: 2 } })
        return
      case '/v2/billing/meter/get-user-resource':
        send(200, {
          code: 0,
          data: {
            Response: {
              Data: {
                Accounts: [
                  {
                    PackageName: 'CodeBuddy个人版拉新权益包',
                    PackageCode: 'TCACA_code_030',
                    CapacityRemain: 256,
                    CapacitySize: 3000,
                    CapacityUsed: 2744,
                    ExpiredTime: '2026-11-27 15:38:19',
                    CycleEndTime: '2026-12-03 17:21:11',
                    AccountAttributes: [{ Key: 'grantSource', Value: 'welcome_gift' }],
                  },
                ],
              },
            },
          },
        })
        return
      case '/v2/msg-center/message/list':
        send(200, {
          code: 0,
          data: {
            messages: [
              {
                msg_id: '1',
                biz_type: 'growth.travel_arrival',
                title: 'Buddy 出发了',
                content: '旅途结束，快去领奖励',
                created_at: 1795750000000,
                ext: { claim_status: state.travelWaiting ? 'unclaimed' : 'claimed', reward_credit: 30 },
              },
            ],
          },
        })
        return
      case '/v2/activity/growth/buddy/travel/claim':
        if (!state.travelWaiting) {
          send(403, { code: 403, msg: 'no unclaimed travel' })
          return
        }
        state.travelWaiting = false
        send(200, { code: 0, data: { reward_credit: 30 } })
        return
      default:
        send(404, { code: 404, msg: 'no such route' })
    }
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  process.env.WORKBUDDY_BILLING_BASE = `http://127.0.0.1:${port}`
  return {
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

/** A session that points at the mock. */
function mockSession() {
  return {
    accessToken: 'mock-token',
    refreshToken: 'mock-refresh',
    domain: 'www.workbuddy.cn',
    uid: 'mock-uid',
    uin: '',
    nickname: 'mock',
    enterpriseId: '',
    expiresAt: Date.now() + 3600_000,
    refreshExpiresAt: 0,
  }
}

test('the daily check-in pays out and the upstream refuses a second claim', async () => {
  const mock = await startMockUpstream({
    checkedIn: false,
    streakDays: 3,
    claimed: 0,
    compensationClaimed: false,
    compensationActive: true,
    giftClaimed: false,
    giftActive: true,
    tierAvailable: false,
    travelWaiting: false,
  })
  try {
    const session = mockSession()
    const before = await fetchCheckinStatus(session)
    assert.equal(before.todayCheckedIn, false)
    assert.equal(before.dailyCredit, 100)

    const claimed = await claimDailyCheckin(session)
    assert.equal(claimed.credit, 100)
    assert.equal(claimed.streakDays, 4)
    assert.equal(mock.state.claimed, 1)

    const after = await fetchCheckinStatus(session)
    assert.equal(after.todayCheckedIn, true)

    await assert.rejects(
      () => claimDailyCheckin(session),
      /今天已签到/,
      'the upstream must refuse a second claim on the same day',
    )
    assert.equal(mock.state.claimed, 1, 'no second payout')
  } finally {
    await mock.close()
  }
})

test('the one-off campaigns are only claimed while they are open', async () => {
  const mock = await startMockUpstream({
    checkedIn: true,
    streakDays: 5,
    claimed: 1,
    compensationClaimed: false,
    compensationActive: true,
    giftClaimed: false,
    giftActive: true,
    tierAvailable: false,
    travelWaiting: false,
  })
  try {
    const session = mockSession()
    const benefits = await fetchBenefits(session)
    assert.equal(benefits.compensation.active, true)
    assert.equal(benefits.compensation.claimed, false)
    assert.equal(benefits.gift.claimed, false)
  } finally {
    await mock.close()
  }
})

test('a locked streak tier is never redeemable', async () => {
  const mock = await startMockUpstream({
    checkedIn: true,
    streakDays: 7,
    claimed: 1,
    compensationClaimed: true,
    compensationActive: false,
    giftClaimed: true,
    giftActive: false,
    tierAvailable: false,
    travelWaiting: false,
  })
  try {
    const session = mockSession()
    const streak = await fetchGrowthStreak(session)
    assert.deepEqual(streak.availableTiers, [])
    await assert.rejects(() => redeemGrowthTier(session, '7d'), /invalid redemption/)
  } finally {
    await mock.close()
  }
})

test('an available streak tier is redeemable exactly once', async () => {
  const mock = await startMockUpstream({
    checkedIn: true,
    streakDays: 7,
    claimed: 1,
    compensationClaimed: true,
    compensationActive: false,
    giftClaimed: true,
    giftActive: false,
    tierAvailable: true,
    travelWaiting: false,
  })
  try {
    const session = mockSession()
    const streak = await fetchGrowthStreak(session)
    assert.deepEqual(streak.availableTiers, ['7d'])
    const redeemed = await redeemGrowthTier(session, '7d')
    assert.equal(redeemed.tier, '7d')
    await assert.rejects(() => redeemGrowthTier(session, '7d'), /invalid redemption/)
  } finally {
    await mock.close()
  }
})

test('the balance is read from the resource package table', async () => {
  const mock = await startMockUpstream({
    checkedIn: true,
    streakDays: 5,
    claimed: 1,
    compensationClaimed: true,
    compensationActive: false,
    giftClaimed: true,
    giftActive: false,
    tierAvailable: false,
    travelWaiting: false,
  })
  try {
    const balance = await fetchCredits(mockSession())
    assert.equal(balance.kind, 'personal')
    assert.equal(balance.total, 3000)
    assert.equal(balance.remaining, 256)
    assert.equal(balance.packages[0].source, 'welcome_gift')
  } finally {
    await mock.close()
  }
})

test('the message centre exposes the waiting travel reward', async () => {
  const mock = await startMockUpstream({
    checkedIn: true,
    streakDays: 5,
    claimed: 1,
    compensationClaimed: true,
    compensationActive: false,
    giftClaimed: true,
    giftActive: false,
    tierAvailable: false,
    travelWaiting: true,
  })
  try {
    const messages = await fetchMessages(mockSession())
    assert.equal(messages.length, 1)
    assert.equal(messages[0].claimStatus, 'unclaimed')
    assert.equal(messages[0].rewardCredit, 30)
  } finally {
    await mock.close()
  }
})

test('the local day key and the clock are read in the local timezone', () => {
  const day = localDayKey(new Date(2026, 10, 27, 23, 30))
  assert.equal(day, '2026-11-27')
  assert.equal(minutesSinceMidnight(new Date(2026, 10, 27, 9, 5)), 545)
  assert.equal(parseClock('09:00'), 540)
  assert.equal(parseClock('23:59'), 1439)
  assert.equal(parseClock('nonsense'), 0)
  assert.equal(parseClock('99:99'), 0)
})
