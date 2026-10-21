/**
 * 离线逻辑仿真：不需要真机，直接跑状态机 + 翻转识别器
 *
 * 场景按策划案实际使用姿态还原：手机横屏**立在桌面上**，
 * 此时重力主轴是 x 轴（不是平放时的 z 轴）。
 * 用户把手机在自身平面内翻转 180°，重力向量整体反号。
 *
 * 运行：node test/simulate.js
 */

const assert = require('assert')
const { formatHM, formatHMS, formatTarget } = require('../utils/format')
const { fabStyle } = require('../utils/fab-pos')
const FlipDetector = require('../utils/flip')

// ===== 虚拟时钟 =====
// 注意：只替换 Date.now 是不够的。页面用 new Date() 取当前时刻，
// 不带参数的 new Date() 走的是系统时间，不是 vnow。
let vnow = 1700000000000
const RealDate = Date
class MockDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(vnow)
    else super(...args)
  }
  static now() {
    return vnow
  }
}
global.Date = MockDate

// ===== 定时器替身 =====
// 用 Map 而不是数组：clearTimeout 要真能取消，
// 否则「菜单 3 秒自动收起」「1.5 秒后回待机」这种用例会互相干扰。
const timeouts = new Map()
let timerSeq = 0
global.setInterval = () => 0
global.clearInterval = () => {}
global.setTimeout = (fn, ms) => {
  const id = ++timerSeq
  timeouts.set(id, { fn, at: vnow + ms })
  return id
}
global.clearTimeout = (id) => {
  timeouts.delete(id)
}

// ===== wx 替身 =====
const storage = {}
// 多个页面实例会并存（用例之间不一定都 onHide），所以监听要按数组存：
// 只留最后一个的话，旧页面从此收不到帧，会被静默检测误判成"传感器假可用"
let gyroHandlers = []
let accelHandler = null
global.wx = {
  setStorageSync: (k, v) => {
    storage[k] = v
  },
  getStorageSync: (k) => storage[k],
  removeStorageSync: (k) => {
    delete storage[k]
  },
  setKeepScreenOn: () => {},
  showToast: () => {},
  getWindowInfo: () => ({ windowWidth: 844, windowHeight: 390 }),
  getMenuButtonBoundingClientRect: () => ({
    top: 6, bottom: 38, left: 748, right: 838, width: 90, height: 32,
  }),
  startGyroscope: ({ success }) => success(),
  onGyroscopeChange: (fn) => {
    gyroHandlers.push(fn)
  },
  offGyroscopeChange: (fn) => {
    const i = gyroHandlers.indexOf(fn)
    if (i >= 0) gyroHandlers.splice(i, 1)
  },
  stopGyroscope: () => {},
  startAccelerometer: ({ success }) => success(),
  onAccelerometerChange: (fn) => {
    accelHandler = fn
  },
  offAccelerometerChange: () => {},
  stopAccelerometer: () => {},
}

// ===== Page 替身 =====
let pageConfig = null
global.Page = (cfg) => {
  pageConfig = cfg
}

require('../pages/clock/index.js')

const pages = []

const page = Object.assign({}, pageConfig)
page.data = JSON.parse(JSON.stringify(pageConfig.data))
page.setData = function (patch) {
  Object.assign(this.data, patch)
}
pages.push(page)

// ===== 时间推进 =====
// 动作模型按真实使用姿势还原：手机**横屏立在桌面上**，绕自身法线转 180°。
// 驱动信号是陀螺仪的角速度（哪个轴在转就积哪个，见 utils/flip.js 头部），
// 不能再用"把重力向量从 -1 摆到 +1"来假装翻转。
/** 送一帧。dtMs 不填就是正常的 20ms；axis 不填就是绕屏幕法线（z） */
function frame(omega, dtMs, axis) {
  vnow += dtMs || 20
  const r = { x: 0, y: 0, z: 0 }
  r[axis || 'z'] = omega
  if (gyroHandlers.length) for (const h of gyroHandlers) h(r)
  else if (accelHandler) accelHandler({ x: 0, y: 0, z: 1 })

  // 页面的滴答也要跟着虚拟时间走：关闭反馈的收尾、提醒的进入全靠它，
  // 只推 Date.now 不推 onTick，等于把页面当成"永远不会自己动"的假对象
  for (const p of pages) {
    const last = p.__lastTick || 0
    if (vnow - last < 200) continue
    p.__lastTick = vnow
    if (p.onTick) p.onTick()
  }

  for (const [id, t] of Array.from(timeouts)) {
    if (t.at <= vnow) {
      timeouts.delete(id)
      t.fn()
    }
  }
}

/** 静止 ms 毫秒（人放下手机、什么都不做） */
function rest(ms) {
  const frames = Math.max(1, Math.round(ms / 20))
  for (let i = 0; i < frames; i++) frame(0)
}

/**
 * 分钟级地推进虚拟时间。
 * 不能只改 vnow：页面在前台常亮时传感器一直在送帧，时间跳跃期间一帧都不给，
 * 静默检测会把"好好在前台的页面"误判成传感器假可用。所以跳跃后补一帧。
 */
function skip(ms) {
  vnow += ms
  frame(0)
}

/**
 * 手动补一拍滴答。
 * 动作不再在传感器回调里同步执行，而是投进队列、由页面的 200ms 滴答取走
 * （见 utils/flip.js 头部）。用例不等这一拍，看到的就永远慢一步。
 */
function tick() {
  const p = pages[pages.length - 1]
  if (p && p.onTick) p.onTick()
}

/**
 * 绕某根轴匀速转 deg 度，耗时 ms。
 * axis 默认 'z'（屏幕法线，竖翻）；'y' 是横翻（屏幕由朝自己转成朝外）。
 * 正值与负值对应两个相反方向，A→B 和 B→A 都走这一条路。
 */
function spin(deg, ms, axis) {
  const frames = Math.max(1, Math.round(ms / 20))
  const omega = ((deg * Math.PI) / 180) / (ms / 1000)
  for (let i = 0; i < frames; i++) frame(omega, 20, axis)
  tick() // 松手那一拍：真实设备上动作在这一拍之内就被取走了
}

const results = []
function check(name, fn) {
  try {
    fn()
    results.push(`  PASS  ${name}`)
  } catch (e) {
    results.push(`  FAIL  ${name}\n        ${e.message}`)
  }
}

// ===== 开跑 =====
page.onLoad()
page.onShow()

check('启动后进入待机态', () => {
  assert.strictEqual(page.data.state, 'idle')
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)))
  assert.strictEqual(page.data.statusText, '翻转开始')
  assert.strictEqual(page.flipDetector.upsideDown, false)
})

rest(2000) // 手机立在桌上，基准稳定

check('立着翻转 180° → 开始计时', () => {
  spin(180, 800)
  assert.strictEqual(page.data.state, 'running')
  assert.strictEqual(page.data.statusText, '计时中')
})

check('右下角角标写「提醒时间 HH:mm:ss」', () => {
  assert.match(page.data.targetText, /^提醒时间 \d{2}:\d{2}:\d{2}$/)
  assert.strictEqual(page.data.targetText, formatTarget(page.countdown.targetTs))
  // 只到分的话，10:48:41 的提醒会显示成 10:48，用户等到 10:48:00 没响会以为坏了
  const sec = new Date(page.countdown.targetTs).getSeconds()
  assert.strictEqual(page.data.targetText.slice(-2), ('0' + sec).slice(-2), '提醒时刻没带到秒')
})

// 核心语义：中间区永远是当前时间，不是剩余时间。
// 这条用例故意不看剩余，只看它是否等于此刻的时钟，防止有人退回倒计时。
check('计时中中间显示的是当前时间，不是剩余时间', () => {
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)))
  assert.strictEqual(page.data.finalPhase, false)
  assert.match(page.data.mainText, /^\d{2}:\d{2}$/)
})

// 内容不再自己转 180°（C-7.11），姿态只在识别器里记账
check('翻转后姿态记账跟上', () => {
  assert.strictEqual(page.flipDetector.upsideDown, true)
})

check('保持倒置不重复触发', () => {
  rest(3000)
  assert.strictEqual(page.data.state, 'running')
})

check('翻回原姿态 → 姿态记账回正，且不产生动作', () => {
  spin(-180, 800)
  rest(2000)
  assert.strictEqual(page.flipDetector.upsideDown, false)
  assert.strictEqual(page.data.state, 'running')
})

// 先用掉 10 分钟，确认常规态不出秒
skip(10 * 60 * 1000)
page.onTick()

check('常规态不出现秒（只有最后一分钟才带秒）', () => {
  assert.strictEqual(page.data.finalPhase, false)
  assert.match(page.data.mainText, /^\d{2}:\d{2}$/)
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)))
})

// 直接对准目标时刻前 30 秒，不靠累加推算
vnow = page.countdown.targetTs - 30 * 1000
page.onTick()

check('剩余 ≤60 秒：当前时间带上秒', () => {
  assert.strictEqual(page.data.finalPhase, true)
  assert.strictEqual(page.data.statusText, '计时中')
  assert.match(page.data.mainText, /^\d{2}:\d{2}:\d{2}$/)
  assert.strictEqual(page.data.mainText, formatHMS(new Date(vnow)))
})

skip(31 * 1000)
page.onTick()

check('到点进入提醒态', () => {
  assert.strictEqual(page.data.state, 'alert')
  // 中间不换字：提醒只由边缘的光表达，时钟照旧显示
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)))
  assert.strictEqual(page.data.targetText, '')
  assert.strictEqual(page.data.statusText, '翻转或点击关闭')
})

check('提醒态时钟继续走，不为提醒让位', () => {
  const before = page.data.mainText
  skip(70 * 1000)
  page.onTick()
  assert.strictEqual(page.data.state, 'alert')
  assert.notStrictEqual(page.data.mainText, before, '提醒态时钟停住了，数字冻在到点那一刻')
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)))
})

// 提醒的"光"必须一直在，直到用户动手（C-1.6 / C-7.16）。
// 任何自动退出都是 bug：手机摆桌上就是为了"到点能看见"，
// 提醒自己没了，这台钟就是坏的。
check('提醒态不设自动超时：再推两小时还是提醒态，且不冒出秒', () => {
  skip(2 * 60 * 60 * 1000)
  page.onTick()
  assert.strictEqual(page.data.state, 'alert', '提醒自己消失了，用户没操作就不该停')
  assert.strictEqual(page.data.finalPhase, false, '提醒态又冒出秒了')
  assert.match(page.data.mainText, /^\d{2}:\d{2}$/)
  assert.strictEqual(page.data.mainText, formatHM(new Date(vnow)), '提醒态时钟停了')
})

check('提醒态翻转 180° → 关闭提醒', () => {
  spin(180, 800)
  assert.strictEqual(page.data.state, 'closed')
  assert.strictEqual(page.data.mainText, '')
  // 中间只有一句人话，不复述"你关闭了提醒"
  assert.strictEqual(page.data.noticeText, '好了')
  // 底部不重复
  assert.strictEqual(page.data.statusText, '')
})

check('1.5 秒后回到待机态，不自动开始下一轮', () => {
  rest(2000)
  assert.strictEqual(page.data.state, 'idle')
})

// 待机态翻一下就启动 —— 这正是用户反复踩的"翻一下没反应"。
// 冷却只留 800ms（覆盖关闭反馈期的手部余动），不再有 3 秒的静默窗口。
check('待机态翻转 → 立刻启动，没有"翻一下没反应"', () => {
  spin(-180, 800)
  assert.strictEqual(page.data.state, 'running', '待机态翻转没启动')
})

check('计时态翻转不响应（语义不乱）', () => {
  rest(1000)
  assert.strictEqual(page.data.state, 'running')
})

// ===== 传感器选型：这次返工的核心 =====
// 之前的仿真用「把重力向量从 -1 摆到 +1」来模拟翻转，等于顺着加速度计
// 的能力造了个假场景，所以测试全绿而真机全废。真实姿势是手机**平放在桌上**，
// 在桌面平面内转 180° —— 重力方向前后一模一样，加速度计全程读同一个值。
check('平放桌面内转 180° → 识别并启动', () => {
  const p = freshPage()
  rest(1500)
  spin(180, 800)
  assert.strictEqual(p.data.state, 'running', '平放旋转没识别出来')
  assert.strictEqual(p.flipDetector.upsideDown, true, '姿态没记账')
  p.onHide()
})

// 两个方向必须对称，不存在「只认一侧」
check('反方向转 180° 同样命中，界面同样翻到另一面', () => {
  const p = freshPage()
  rest(1500)
  spin(-180, 800)
  assert.strictEqual(p.data.state, 'running', '只有单方向能识别')
  assert.strictEqual(p.flipDetector.upsideDown, true)
  p.onHide()
})

check('分段转：转 90° 停一下再转 90°，累积起来仍算一次', () => {
  const p = freshPage()
  rest(1500)
  spin(90, 500)
  rest(800)
  assert.strictEqual(p.data.state, 'idle', '半圈就触发了')
  spin(90, 500)
  assert.strictEqual(p.data.state, 'running')
  p.onHide()
})

check('只转 100° 又转回去 → 不算翻转', () => {
  const p = freshPage()
  rest(1500)
  spin(100, 500)
  spin(-100, 500)
  rest(500)
  assert.strictEqual(p.data.state, 'idle')
  assert.strictEqual(p.flipDetector.upsideDown, false)
  p.onHide()
})

check('手抖级别的小幅晃动不触发', () => {
  const p = freshPage()
  rest(1500)
  for (let i = 0; i < 20; i++) {
    spin(15, 100)
    spin(-15, 100)
  }
  assert.strictEqual(p.data.state, 'idle')
  p.onHide()
})

check('切后台几十秒回来，单帧大角速度不会被当成急转', () => {
  const p = freshPage()
  rest(1000)
  skip(60000 )
  frame(6)
  assert.strictEqual(p.data.state, 'idle')
  p.onHide()
})

// ===== 多轴：横翻也得算（1.21）=====
// 只认 z 轴时，竖翻能认、横翻（绕屏幕纵轴转半圈，屏幕由朝自己变成朝外）
// 一点反应都没有。用户不该记"哪个方向翻才算翻"。
check('横翻（绕屏幕纵轴转半圈）同样算一次翻转', () => {
  const p = freshPage()
  rest(1500)
  spin(180, 800, 'y')
  assert.strictEqual(p.data.state, 'running', '横翻没被识别')
  p.onHide()
})

check('横翻之后再竖翻，两个方向都能算（换轴不互相顶掉）', () => {
  const p = freshPage()
  rest(1500)
  spin(180, 800, 'y')
  assert.strictEqual(p.flipDetector.turns, 1)
  rest(2000) // 中间停一下：真实用户翻完要看一眼屏幕
  spin(180, 800, 'z')
  assert.strictEqual(p.flipDetector.turns, 2, '换轴之后竖翻不算了')
  p.onHide()
})

check('斜着翻到一半换轴：两根轴的角度不许拼成一次假翻转', () => {
  const p = freshPage()
  rest(1500)
  spin(100, 500, 'y') // 横翻只转一半
  rest(200)
  spin(100, 500, 'z') // 换竖翻再转一半，100° + 100° 凑成 200° 就是假翻转
  assert.strictEqual(p.data.state, 'idle', '两个轴的角度被拼起来了')
  p.onHide()
})

check('横翻时手腕带俯仰（两根轴轮流占优），仍算一次翻转', () => {
  const p = freshPage()
  rest(1500)
  // 真机动作：左右转手机，俯仰分量一直掺着，主分量在 x / y 之间来回抢。
  // 按"挑主导轴、换轴清零"那套会把这一下切成好几段，每段都不够 150°。
  const frames = Math.round(900 / 20)
  const w = (Math.PI / 0.9) * 1.0
  for (let i = 0; i < frames; i++) {
    vnow += 20
    const flip = i % 2 === 0
    for (const h of gyroHandlers) h({ x: w * (flip ? 0.6 : 1), y: w * (flip ? 1 : 0.6), z: 0 })
    tick()
  }
  assert.strictEqual(p.data.state, 'running', '复合运动被切碎了，横翻没认出来')
  p.onHide()
})

check('斜着翻（绕 45° 方向的轴转半圈）同样算', () => {
  const p = freshPage()
  rest(1500)
  const frames = Math.round(800 / 20)
  const w = Math.PI / 0.8 / Math.SQRT2 // x、y 各分一半，合起来正好 180°
  for (let i = 0; i < frames; i++) {
    vnow += 20
    for (const h of gyroHandlers) h({ x: w, y: w, z: 0 })
    tick()
  }
  assert.strictEqual(p.data.state, 'running', '斜翻没认出来')
  p.onHide()
})

check('竖翻时手腕带出一点横轴分量，不打断这次翻转', () => {
  const p = freshPage()
  rest(1500)
  const frames = Math.round(800 / 20)
  const w = ((180 * Math.PI) / 180) / 0.8
  for (let i = 0; i < frames; i++) {
    // 主转 z，同时横向抹一点（峰值只有 1/3，够不上换轴门槛）
    vnow += 20
    for (const h of gyroHandlers) h({ x: 0, y: w / 3, z: w })
    tick()
  }
  assert.strictEqual(p.data.state, 'running', '手腕的横轴分量把竖翻打断了')
  p.onHide()
})

// 备用路径
check('提醒态点击屏幕也能关闭', () => {
  page.enterAlert()
  page.actionLockUntil = 0
  page.onStageTap()
  assert.strictEqual(page.data.state, 'closed')
})

check('待机态点击按钮开始', () => {
  rest(2000)
  assert.strictEqual(page.data.state, 'idle')
  page.actionLockUntil = 0
  page.onStartTap()
  assert.strictEqual(page.data.state, 'running')
})

// 设置与持久化
check('设置时长后持久化并更新状态小字', () => {
  page.applyDuration(45)
  assert.strictEqual(storage.flip_timer_duration_min, 45)
  assert.strictEqual(page.data.durationMin, 45)
})

check('自定义时长越界被拦截', () => {
  page.setData({ customMin: '999' })
  page.onConfirmCustom()
  assert.strictEqual(page.data.durationMin, 45)
})

check('重新加载后读回上次设置', () => {
  const p2 = Object.assign({}, pageConfig)
  p2.data = JSON.parse(JSON.stringify(pageConfig.data))
  p2.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  p2.onLoad()
  assert.strictEqual(p2.data.durationMin, 45)
})

check('切后台跨过目标时间，回前台立即进提醒态', () => {
  page.actionLockUntil = 0
  page.beginRound()
  assert.strictEqual(page.data.state, 'running')
  skip(46 * 60 * 1000)
  page.syncOnResume()
  assert.strictEqual(page.data.state, 'alert')
})

check('关闭反馈期内切后台，回前台不会卡在 closed', () => {
  page.enterAlert()
  page.actionLockUntil = 0
  page.onCloseTap()
  assert.strictEqual(page.data.state, 'closed')
  page.onHide()
  page.onShow()
  assert.strictEqual(page.data.state, 'idle')
  assert.match(page.data.mainText, /^\d{2}:\d{2}$/)
})

// ===== 冷启动恢复（持久化） =====
/** 造一个全新的页面实例，模拟小程序被系统杀掉后重进 */
function makePage() {
  const p = Object.assign({}, pageConfig)
  p.data = JSON.parse(JSON.stringify(pageConfig.data))
  p.setData = function (patch) {
    Object.assign(this.data, patch)
  }
  p.onLoad()
  p.onShow()
  pages.push(p)
  return p
}

/** 干净实例：不接上一轮持久化记录，专测传感器行为 */
function freshPage() {
  wx.removeStorageSync('flip_timer_round_target')
  return makePage()
}

check('计时中途被系统杀掉 → 重进恢复进行中计时', () => {
  page.actionLockUntil = 0
  page.toIdle()
  page.beginRound() // 45 分钟
  skip(10 * 60 * 1000 )

  const p = makePage()
  assert.strictEqual(p.data.state, 'running')
  assert.strictEqual(p.data.statusText, '计时中')
  assert.strictEqual(p.data.mainText, formatHM(new Date(vnow)), '恢复后中间仍是当前时间')
  // 中间不再显示剩余时间，所以直接查计时器本身
  assert.ok(Math.abs(p.countdown.remaining - 35 * 60000) < 5000, '应剩约 35 分钟')
  p.onHide()
})

check('到点未关闭就退出 → 重进仍在提醒态', () => {
  skip(40 * 60 * 1000 )

  const p = makePage()
  assert.strictEqual(p.data.state, 'alert')
  assert.ok(wx.getStorageSync('flip_timer_round_target') > 0, '未关闭的提醒应保留记录')
  p.onHide()
})

check('关闭提醒后重进 → 待机，不复活上一轮', () => {
  const p = makePage()
  assert.strictEqual(p.data.state, 'alert')
  p.actionLockUntil = 0
  p.onCloseTap()
  assert.strictEqual(p.data.state, 'closed')
  assert.ok(!wx.getStorageSync('flip_timer_round_target'), '关闭即刻清除记录')

  const q = makePage()
  assert.strictEqual(q.data.state, 'idle')
  assert.match(q.data.mainText, /^\d{2}:\d{2}$/)
  q.onHide()
})

// ===== 计时中主动取消 =====
check('计时中长按中央区 → 取消本轮，不进提醒态', () => {
  page.actionLockUntil = 0
  page.toIdle()
  page.beginRound()
  assert.strictEqual(page.data.state, 'running')

  page.actionLockUntil = 0
  page.onMainLongPress()
  assert.strictEqual(page.data.state, 'closed')
  assert.strictEqual(page.data.noticeText, '算了')
  assert.strictEqual(page.data.targetText, '', '取消后不该再显示目标时刻')
})

check('取消即刻废弃目标时间戳并清记录', () => {
  assert.strictEqual(page.countdown.targetTs, 0, '目标时间戳应废弃')
  assert.ok(!wx.getStorageSync('flip_timer_round_target'), '本轮记录应清除')
})

check('取消后 1.5 秒回待机，不自动开始下一轮', () => {
  rest(2000)
  assert.strictEqual(page.data.state, 'idle')
  assert.strictEqual(page.data.statusText, '翻转开始')
})

check('待机态长按不产生任何动作', () => {
  page.actionLockUntil = 0
  page.onMainLongPress()
  assert.strictEqual(page.data.state, 'idle')
})

// ===== 提醒间隔由用户自定 =====
check('自定义任意分钟数生效，不被预设档位限制', () => {
  page.applyDuration(7)
  assert.strictEqual(page.data.durationMin, 7)
  assert.strictEqual(storage.flip_timer_duration_min, 7, '应持久化用户选的值')
  assert.strictEqual(page.data.showPanel, false, '选完应收起面板')
})

check('用户设定的间隔真正用于下一轮计时', () => {
  page.actionLockUntil = 0
  page.beginRound()
  assert.strictEqual(page.data.state, 'running')
  assert.ok(Math.abs(page.countdown.remaining - 7 * 60000) < 2000, '应按 7 分钟起算')
})

check('预设档位覆盖常见间隔且含默认值', () => {
  const presets = pageConfig.data.presets
  assert.ok(presets.length >= 6, '预设档位少于 6 个')
  assert.ok(presets.includes(10) && presets.includes(60), '缺少短/长间隔档位')
  assert.ok(presets.includes(pageConfig.data.durationMin), '默认值不在预设里')
})

// ===== 边缘悬浮钮 =====
check('悬浮钮落在胶囊正下方，右边缘与胶囊对齐', () => {
  const rect = { top: 6, bottom: 38, left: 748, right: 838, width: 90, height: 32 }
  const win = { windowWidth: 844, windowHeight: 390 }
  assert.strictEqual(fabStyle({ rect, win }), 'top: 44px; right: 6px;')
})

/**
 * 不做镜像：系统已经把页面转过去了，按钮贴在页面右上角，人眼里就是右上角。
 * 再镜像一次反而把它送到对角（C-7.11）。
 */
check('胶囊坐标拿不到或坐标系错位时回落，不把钮丢到屏幕外', () => {
  assert.strictEqual(fabStyle(null), 'top: 13vh; right: 3vw;')
  // 横屏却拿到竖屏坐标：right 会算成 460px，必须判定为不可用
  const portraitRect = { top: 6, bottom: 56, right: 384, width: 87, height: 32 }
  assert.match(fabStyle({ rect: portraitRect, win: { windowWidth: 844, windowHeight: 390 } }), /13vh/)
  // 系统把页面转过去之后，胶囊在页面坐标里落到下半屏 —— 同样不可用
  const rotatedRect = { top: 320, bottom: 358, left: 6, right: 96, width: 90, height: 32 }
  assert.match(fabStyle({ rect: rotatedRect, win: { windowWidth: 844, windowHeight: 390 } }), /13vh/)
})

check('翻过去之后系统把页面转了，悬浮钮改用回落位置而不是追着胶囊跑到对角', () => {
  const p = freshPage()
  rest(1500)
  assert.match(p.data.fabStyle, /^top: 44px/, '未翻转时贴着胶囊下方')
  const real = global.wx.getMenuButtonBoundingClientRect
  global.wx.getMenuButtonBoundingClientRect = () => ({
    top: 320, bottom: 358, left: 6, right: 96, width: 90, height: 32,
  })
  spin(180, 800) // 翻过去，系统随之把页面转过来
  assert.match(p.data.fabStyle, /13vh/, '系统旋转后仍按旧坐标追胶囊，钮会跑到对角')
  global.wx.getMenuButtonBoundingClientRect = real
  p.onHide()
})

check('点细棍展开菜单', () => {
  page.actionLockUntil = 0
  page.toIdle()
  page.onToggleFab()
  assert.strictEqual(page.data.fabOpen, true)
})

check('展开后 3 秒没操作自己缩回，且不顺手开计时', () => {
  rest(3400)
  assert.strictEqual(page.data.fabOpen, false)
  assert.strictEqual(page.data.state, 'idle')
})

check('菜单展开时点空白 → 只收起，不启动计时', () => {
  page.onToggleFab()
  assert.strictEqual(page.data.fabOpen, true)
  page.onStageTap()
  assert.strictEqual(page.data.fabOpen, false)
  assert.strictEqual(page.data.state, 'idle')
})

check('点「时长」→ 收起菜单并打开设置面板', () => {
  page.onToggleFab()
  page.onOpenPanel({ currentTarget: { dataset: { mode: 'duration' } } })
  assert.strictEqual(page.data.fabOpen, false)
  assert.strictEqual(page.data.showPanel, true)
  assert.strictEqual(page.data.panelMode, 'duration')
  page.onClosePanel()
})

check('点「开始」→ 收起菜单并进入计时', () => {
  page.actionLockUntil = 0
  page.onToggleFab()
  page.onStartTap()
  assert.strictEqual(page.data.fabOpen, false)
  assert.strictEqual(page.data.state, 'running')
})

// ===== 提醒的关闭路径（真实场景：翻转启动后手机一直没动过） =====
// 这条守的是一个曾经存在的坑：翻转启动后手机停在倒置姿态，
// 提醒来了用户「翻回来」这一下如果被挡，灯会继续呼吸 —— 用户看到的是「我翻了，它没反应」。
check('翻转启动后一直没倒手，提醒来了翻回一下就关掉', () => {
  skip(60 * 60 * 1000)
  const p = makePage()
  p.toIdle() // 清掉上一轮残留
  rest(1500)
  spin(180, 800)
  assert.strictEqual(p.data.state, 'running')

  vnow = p.countdown.targetTs + 1000
  p.onTick()
  assert.strictEqual(p.data.state, 'alert')

  spin(-180, 800) // 只翻这一下，回到原来的姿态
  assert.strictEqual(p.data.state, 'closed', '翻回来没关掉，等于逼用户再翻一次')
  p.onHide()
})

// 防误启动只有一层：showClosed 的 1.5 秒反馈期。
// 反馈期内翻转被忽略（用户还在看那一下反馈），反馈期一过翻转立刻生效。
// 这条守的是两边：窗口内不被误开、窗口外不许失灵。
check('关闭反馈期内翻转被忽略，反馈期一过立刻能启动', () => {
  const p = freshPage()
  rest(1500)
  p.beginRound()
  vnow = p.countdown.targetTs + 1000
  p.onTick()
  assert.strictEqual(p.data.state, 'alert')

  p.consumeTurn() // 翻转关闭
  assert.strictEqual(p.data.state, 'closed')
  p.consumeTurn() // 手还在动，又翻了一下
  assert.strictEqual(p.data.state, 'closed', '反馈期内的翻转把下一轮开起来了')

  rest(1800) // 反馈期 1.5 秒 + 一拍滴答的余量
  assert.strictEqual(p.data.state, 'idle')
  p.consumeTurn()
  assert.strictEqual(p.data.state, 'running', '反馈期过了还启动不了，等于翻一下没反应')
  p.onHide()
})

check('提醒态连翻两下：第一下关掉，第二下仍在反馈期不开下一轮', () => {
  const p = freshPage()
  rest(1500)
  p.beginRound()
  vnow = p.countdown.targetTs + 1000
  p.onTick()
  assert.strictEqual(p.data.state, 'alert')

  p.consumeTurn()
  assert.strictEqual(p.data.state, 'closed')
  p.consumeTurn()
  assert.strictEqual(p.data.state, 'closed', '连翻第二下把下一轮开起来了')
  p.onHide()
})

// ===== 提醒光配色 =====
const prefs = require('../utils/prefs')

check('默认配色拼成完整 rgba 字符串，样式表一个色值都不用写', () => {
  const s = prefs.glowStyles('green', 'std')
  assert.strictEqual(
    s.near,
    'box-shadow: inset 0 0 2vh 0 rgba(94, 214, 160, 0.38), ' +
      'inset 0 0 6vh 0 rgba(94, 214, 160, 0.26), ' +
      'inset 0 0 12vh 0 rgba(94, 214, 160, 0.17)'
  )
  // 关键：不能出现 var(--x)，WXSS 编译期会把整条 rgba() 丢掉
  assert(!/var\(/.test(s.near + s.far + s.pre), '样式串里残留 CSS 变量，WXSS 会丢弃整条声明')
  assert(/background-size: 100% 24%, 100% 24%, 24% 100%, 24% 100%/.test(s.far), '远场带宽不是 24%')
  assert((s.far.match(/linear-gradient/g) || []).length === 4, '远场不是四条渐变')
})

check('三种颜色各不相重，且都是 rgb 三元组', () => {
  assert.strictEqual(prefs.COLORS.length, 3)
  const rgbs = prefs.COLORS.map((c) => c.rgb)
  assert.strictEqual(new Set(rgbs).size, 3, '颜色有重复')
  rgbs.forEach((r) => assert(/^\d+, \d+, \d+$/.test(r), `格式不对：${r}`))
})

check('浓档按倍率抬高全部 alpha，且不会亮到吃掉中间的时钟', () => {
  const a1 = (s) => Number(s.near.match(/rgba\(\d+, \d+, \d+, ([\d.]+)\)/)[1])
  const soft = a1(prefs.glowStyles('red', 'soft'))
  const strong = a1(prefs.glowStyles('red', 'strong'))
  assert(strong > soft, '浓档没有比淡档更亮')
  assert(strong < 0.55, `浓档最亮层 ${strong} 过高，中间的时间会被冲淡`)
})

check('非法配色 id 一律回落默认档', () => {
  const p = prefs.normalizeGlow('purple', 'huge')
  assert.strictEqual(p.color, 'green')
  assert.strictEqual(p.level, 'std')
})

check('选颜色 → 页面变量与存储同时更新；选强度只改强度', () => {
  const stateBefore = page.data.state
  page.onPickGlow({ currentTarget: { dataset: { color: 'blue' } } })
  assert.strictEqual(page.data.glowColor, 'blue')
  assert.match(page.data.glowStyle.near, /rgba\(96, 158, 226, 0\.38\)/)
  assert.strictEqual(wx.getStorageSync('flip_timer_glow'), 'blue|std')
  assert.strictEqual(page.data.glowLevel, 'std', '选颜色把强度也带跑了')

  page.onPickGlow({ currentTarget: { dataset: { level: 'strong' } } })
  assert.strictEqual(page.data.glowLevel, 'strong')
  assert.strictEqual(page.data.glowColor, 'blue', '选强度把颜色带跑了')
  assert.strictEqual(wx.getStorageSync('flip_timer_glow'), 'blue|strong')
  assert.strictEqual(page.data.state, stateBefore, '改配色动了状态机')

  page.onPickGlow({ currentTarget: { dataset: { color: 'green', level: 'std' } } })
})

// 秒的门槛写在 renderClock 内部，不靠调用方自觉：任何一处误传 true 都要拦得住。
check('秒只在计时态出现：待机态误传 true 也不露秒', () => {
  const p = freshPage()
  rest(1200)
  assert.strictEqual(p.data.state, 'idle')
  p.renderClock(true) // 故意写错，模拟调用方漏判状态
  assert.strictEqual(p.data.finalPhase, false, '待机态被误传 true 就露出秒了')
  assert.match(p.data.mainText, /^\d{2}:\d{2}$/)
  p.onHide()
})

// ===== 传感器：假可用与启停时序 =====
check('传感器起来了却一帧不送 → 判为不可用，改走点击路径（C-4.6）', () => {
  const p = freshPage()
  const saved = gyroHandlers // 接口照样成功，回调一帧都不来
  gyroHandlers = []
  rest(4500)
  gyroHandlers = saved
  assert.strictEqual(p.data.flipAvailable, false, '假可用没被判出来')
  assert.strictEqual(p.data.statusText, '点右上角小横杠开始', '没有改成点击提示')
  p.onHide()
})

check('进页面立刻切后台：迟到的启动成功不把传感器留在后台（C-4.5）', () => {
  const realStart = global.wx.startGyroscope
  let late = null
  global.wx.startGyroscope = ({ success }) => {
    late = success // success 迟迟不来
  }
  const p = freshPage()
  p.onHide() // 点进来就切走
  late() // 迟到的成功
  assert.strictEqual(p.flipDetector.running, false, '传感器被起在后台了')
  global.wx.startGyroscope = realStart
  p.onShow() // 回到前台
  assert.strictEqual(p.flipDetector.running, true, '回来后没能重新启动')
  p.onHide()
})

check('翻转动作抛异常不带走整个滴答', () => {
  const p = freshPage()
  rest(1500)
  const real = p.beginRound
  p.beginRound = () => {
    throw new Error('boom')
  }
  spin(180, 800)
  p.beginRound = real
  assert.strictEqual(p.data.state, 'idle', '异常时不该改状态')
  rest(1500) // 让"一次翻转只认一次"的保护期过去
  spin(180, 800) // 滴答还在跑，后面这次照样要被取走
  assert.strictEqual(p.data.state, 'running', '一次异常把整个滴答带走了')
  p.onHide()
})

check('计时中翻转不响应，姿态照常跟随（C-2.4 / C-4.4）', () => {
  const p = freshPage()
  rest(1500)
  p.beginRound()
  spin(180, 800)
  assert.strictEqual(p.data.state, 'running')
  assert.strictEqual(p.flipDetector.upsideDown, true, '姿态与动作是两条路，动作被挡不影响转身')
  p.onHide()
})

// ===== 积分口径：掉帧与断流 =====
// MAX_DT_MS 钳得太紧的代价是"翻了不认"：手转得越快，被吃掉的弧度越多。
check('掉到 200ms 一帧仍能认出翻转，不会把角度算小（C-4.2）', () => {
  const p = freshPage()
  rest(1500)
  // 3.2 rad/s × 5 帧 × 200ms = 3.2rad ≈ 183°；上限若是 120ms 只算得到 110°，翻了也不认
  for (let i = 0; i < 5; i++) frame(3.2, 200)
  tick()
  assert.strictEqual(p.data.state, 'running', '掉帧时这一下被积分上限吃掉了')
  p.onHide()
})

check('挂起半分钟再回来：中间那段不算数，不凭空凑出一次翻转', () => {
  const p = freshPage()
  rest(1500)
  frame(3.2) // 刚开始转，只攒了 0.06 rad
  vnow += 30000 // 被弹窗挡住 / 系统挂起，中间没有任何帧
  frame(3.2) // 回来第一帧
  assert.strictEqual(p.data.state, 'idle', '断流被当成了一次旋转')
  p.onHide()
})

check('加速度计的量纲不影响降级判据：模长跟自身比，不写死绝对值', () => {
  const d = new FlipDetector({})
  d.running = true
  // 文档里加速度单位一会儿 g（静止≈1）一会儿 m/s²（≈9.8），写死阈值等于赌一种
  for (let i = 0; i < 5; i++) d._handleAccel({ x: 0, y: 0, z: 9.8 })
  assert.ok(d.samples >= 1, 'm/s² 口径下读数被当成不可信了')
  const before = d.samples
  d._handleAccel({ x: 0, y: 0, z: 0.5 }) // 模长骤降到 5%，说明正在被甩动
  assert.strictEqual(d.samples, before, '模长骤降这一帧不该采信')
})

// ===== 面板与翻转 =====
check('面板开着时翻转只收面板，不把计时开起来（C-2.8）', () => {
  const p = freshPage()
  rest(1500)
  p.onOpenPanel({ currentTarget: { dataset: { mode: 'duration' } } })
  assert.strictEqual(p.data.showPanel, true)
  spin(180, 800)
  assert.strictEqual(p.data.showPanel, false, '翻转没把面板收掉')
  assert.strictEqual(p.data.state, 'idle', '面板开着时翻转不该启动计时')
  rest(1500) // 让"一次翻转只认一次"的保护期过去
  spin(-180, 800)
  assert.strictEqual(p.data.state, 'running', '面板收掉之后翻转就该照常启动')
  p.onHide()
})

check('计时中从右上菜单取消本轮，不落进提醒态', () => {
  const p = freshPage()
  rest(1200)
  p.beginRound()
  assert.strictEqual(p.data.state, 'running')
  p.onCloseTap() // 菜单项在计时态发的是「取消」，和长按同一个出口
  assert.strictEqual(p.data.state, 'closed')
  assert.strictEqual(p.data.noticeText, '算了')
  rest(2000)
  assert.strictEqual(p.data.state, 'idle', '取消后该回待机')
  p.onHide()
})

check('菜单里的「说明」打开使用说明面板，点空白能关掉', () => {
  const p = freshPage()
  rest(1200)
  p.onOpenPanel({ currentTarget: { dataset: { mode: 'help' } } })
  assert.strictEqual(p.data.showPanel, true, '说明面板没打开')
  assert.strictEqual(p.data.panelMode, 'help')
  p.onClosePanel()
  assert.strictEqual(p.data.showPanel, false, '点空白没关掉面板')
  p.onHide()
})

console.log('\n视觉翻转闹钟 · 逻辑仿真（立放姿态）\n')
console.log(results.join('\n'))
const failed = results.filter((r) => r.startsWith('  FAIL')).length
console.log(`\n${results.length - failed}/${results.length} 通过\n`)
process.exitCode = failed ? 1 : 0
