/**
 * 180° 翻转识别器
 *
 * 上一版是错的，错在传感器选型，不在阈值：加速度计读的是**重力在设备坐标系里的方向**。
 * 手机平放在桌上、在桌面平面内转 180°，屏幕朝向变了，重力方向一点没变——
 * 前后两帧的读数完全相同。只要手机是平放的，加速度计就永远不知道你翻了。
 * 真机上「翻十次中一次、只在一个方向像是有效」，根源就在这里。
 *
 * 绕屏幕法线旋转，唯一有明确读数的是陀螺仪 z 轴角速度。主判据是角速度积分：
 *
 *   OMEGA_DEAD    0.35 rad/s 死区。静止零偏远低于此值，正常转动至少高一个量级
 *   TURN_RAD      150°。剩下 30° 交给惯性，不要求转满整圈
 *   SPIN_HOLD_MS  8 秒不转才清零。分段旋转（转 90° 停一下再转 90°）要能累积起来，
 *                 但长期静止的残余也不能留着，否则攒几次抖动就成了假翻转
 *   MAX_DT_MS     单帧积分上限。采样周期 60ms，掉三四帧仍按真实间隔积分，
 *                 钳得太紧（比如 120ms）会把快速翻转的角度算小、翻了不认
 *   STALL_MS      间隔超过这个数算断流：挂起再回来、被弹窗挡住都会是秒级，
 *                 中间发生了什么无从得知，积分它就是凭空造角度，直接丢帧
 *
 * ── 为什么不再只认 z 轴（2026-10-21 真机）──
 * 只积 z 轴时，**竖翻（手机上下颠倒）能认，横翻（绕屏幕纵轴转半圈、屏幕由朝自己
 * 变成朝外）一点反应都没有** —— 那个动作的角速度全在 y 轴上。用户不该记
 * "哪个方向翻才算翻"，所以改成积**当前主导轴**：三轴里谁在转就积谁。
 * 两根轴的积分不能拼在一起（斜着翻到一半换轴，凑出来的角度是假的），
 * 换轴时把攒过的作废；换轴还要防抖，手腕歪一下不算换轴，否则一次竖翻会被打断。
 *
 * 积分对正负两个方向一视同仁：A→B 和 B→A 是同一条判据，天然对称，
 * 不存在「只认一个方向」这回事。
 *
 * 加速度计不删，作为陀螺仪起不来时的降级路径：它那套点积判据只在
 * 「手机立着翻面」这类重力方向真会反向的姿态下有效，够兜底。
 *
 * ── 为什么动作走队列，不走回调（2026-10-20 真机教训）──
 * 上一版在确认翻转后顺手调 onFlip()，姿态和动作挤在同一个回调栈里。
 * 真机上出现「内容转过来了、计时却没起来」：界面转了说明 _setPose 跑到了，
 * 动作却没了 —— 只要中间任何一步出岔子（setData 抛错、页面状态不对、
 * 冷却没走完），动作就静默消失，而回调栈里的异常只进 console，页面上看不见。
 *
 * 现在 _commitTurn() 只做两件事：pending++ 和 _setPose()。动作由页面在自己的
 * 滴答里 takeTurns() 取走执行。事件先落在计数里，就算渲染那侧出问题也不会丢。
 *
 * ── 启停为什么要记 wantRun（2026-10-20 第二处真机时序）──
 * startGyroscope 的 success 是**异步**的。点进页面立刻切后台时，stop() 看到
 * running 还是 false 就什么都没停，等 success 迟到，传感器被起在后台
 * （C-4.5 禁止后台空跑）；下一次 onShow 的 start() 又被 running=true 挡住，
 * 不再重启 —— 翻转从此失灵，而且不掉降级路径，页面还写着「翻转开始」。
 * 所以停止不是一个瞬时动作：没起来就只把 wantRun 置 false，让迟到的 success
 * 自己把自己关掉。
 *
 * ── 为什么要有 pollSilent() ──
 * 还有一种更阴的失败：接口调用成功、running=true，但**一帧都不送**。
 * 它不算失败，走不到 C-4.6 的降级；页面一直以为能翻，用户翻到手酸也没反应。
 * 判定交给页面轮询（见 pollSilent），连续 SILENT_MS 没有新帧就当不可用。
 */

const TURN_RAD = (Math.PI * 150) / 180 // 150°
const OMEGA_DEAD = 0.35 // rad/s，约 20°/s
const SPIN_HOLD_MS = 8000 // 静止多久后丢弃累积量
const SPIN_DONE_HOLD_MS = 1200 // 一次翻转兑现后，多久之内不再计入角度
const MAX_DT_MS = 250 // 单帧积分上限：够覆盖掉帧，又不至于把挂起恢复当成旋转
const STALL_MS = 1000 // 超过这个间隔视为断流，丢掉这一帧
const COMMIT_LOCK_MS = 400 // 一次翻转只认一次，挡掉拆包
const SILENT_MS = 3000 // 启动成功却迟迟不送帧，判定为「假可用」
const POLL_MS = 1000 // 假可用判定的查询节奏，页面每个滴答问一次也不用自己记拍
const AXIS_SWITCH_RATIO = 1.5 // 新轴要明显压过当前轴才换，手腕歪一下不算换轴

const GRAV_DOT = -0.7 // 降级路径：反向区，夹角大于约 134°
const GRAV_HOME = 0.7 // 降级路径：同向区，夹角小于约 46°
const GRAV_SETTLE_MS = 260
const GRAV_REBASE_MS = 1200
const MIN_MAG_RATIO = 0.35 // 模长下限占"正常量级"的比例
const MAG_EMA = 0.2 // 正常量级用指数平滑跟着读数走

/**
 * 加速度读数归一化成单位重力向量。
 * 模长下限不写绝对值：微信文档里加速度单位一会儿 g（静止约 1）一会儿 m/s²（约 9.8），
 * 写死一个数等于赌其中一种量纲，赌错这条防御就形同虚设。
 * 所以跟**自身量级**比：低于近几帧均值的 35% 才算读数不可信（正在被甩动）。
 * @param {{x:number,y:number,z:number}} res
 * @param {number} ref 近几帧的模长均值；首帧传 0 表示还没有参考
 */
function unitGravity(res, ref) {
  const x = Number(res.x) || 0
  const y = Number(res.y) || 0
  const z = Number(res.z) || 0
  const mag = Math.sqrt(x * x + y * y + z * z)
  if (!mag) return null
  if (ref > 0 && mag < ref * MIN_MAG_RATIO) return null
  return { x: x / mag, y: y / mag, z: z / mag, mag }
}

/** 与基准的方向关系：反向（真翻了）/ 同向 / 换了摆放方式（立 ↔ 平） */
function zoneOf(a, b) {
  const dot = a.x * b.x + a.y * b.y + a.z * b.z
  if (dot < GRAV_DOT) return 'down'
  return dot > GRAV_HOME ? 'home' : 'neutral'
}

class FlipDetector {
  constructor({ onPose, onUnavailable } = {}) {
    this.onPose = onPose || (() => {})
    this.onUnavailable = onUnavailable || (() => {})

    this.upsideDown = false
    this.running = false
    this.wantRun = false // 页面是否希望传感器在跑。start/stop 的真正意图，见头部说明
    this.available = true
    this.sensor = null // 'gyro' | 'accel'
    this.omega = 0 // 最近一帧的 z 角速度，只给自检看
    this.samples = 0 // 收到过多少帧，用来判断传感器到底有没有在送数
    this.turns = 0 // 累计确认过多少次翻转，只给自检看
    this.pending = 0 // 已确认但页面还没取走的翻转次数

    this._handleGyro = this._handleGyro.bind(this)
    this._handleAccel = this._handleAccel.bind(this)
    this.reset()
  }

  /**
   * 复位记账。不碰姿态：切后台再回来手机还是那个朝向，界面不该自己翻回去。
   * pending 也清掉 —— 后台期间攒下的翻转不该回到前台后补触发一串动作。
   */
  reset() {
    this.spin = 0
    this.spinStart = 0 // 当前这段旋转从何时开始攒角度
    this.spinDone = false
    this.doneAt = 0
    this.lastAt = 0
    this.lockUntil = 0
    this.baseline = null
    this.zone = null
    this.magRef = 0 // 加速度模长参考量级，随读数平滑更新
    this.axis = null // 当前正在积分的那根轴，null 表示还没定
    this.pending = 0
    this.seenSamples = 0
    this.silentAt = 0
    this.pollAt = 0
  }

  /** 页面滴答里取走待处理的翻转次数 */
  takeTurns() {
    if (!this.pending) return 0
    const n = this.pending
    this.pending = 0
    return n
  }

  /**
   * 传感器"假可用"检测：接口起来了、running 为真，却连续 SILENT_MS 一帧都没送。
   * 它不算启动失败，走不到 C-4.6 的静默降级，页面却一直以为能翻 ——
   * 用户翻到手酸也没反应，还不知道可以改用按钮。
   * 判据自带 1 秒节奏（POLL_MS），页面每个滴答问一次即可，不必自己记拍。
   */
  pollSilent() {
    if (!this.running) return false
    const now = Date.now()
    if (now - this.pollAt < POLL_MS) return false
    this.pollAt = now
    if (this.samples !== this.seenSamples) {
      this.seenSamples = this.samples
      this.silentAt = 0
      return false
    }
    if (!this.silentAt) {
      this.silentAt = now
      return false
    }
    return now - this.silentAt >= SILENT_MS
  }

  start() {
    this.wantRun = true
    if (this.running) return
    this._startGyro()
  }

  /**
   * 停传感器。running 为 false 时**不能**直接返回了事：
   * 启动的 success 还在路上，这一次什么都没停，它就迟到了（见头部说明）。
   */
  stop() {
    this.wantRun = false
    if (!this.running) return
    this.running = false
    this._teardown(this.sensor)
  }

  /** 按当前路径摘监听 + 关硬件。sensor 为空说明还没起来，无从摘起 */
  _teardown(sensor) {
    if (sensor === 'accel') {
      wx.offAccelerometerChange(this._handleAccel)
      wx.stopAccelerometer({ complete: () => {} })
    } else {
      wx.offGyroscopeChange(this._handleGyro)
      wx.stopGyroscope({ complete: () => {} })
    }
  }

  /** 陀螺仪优先；起不来才换加速度计。两条路不并行，姿态只由其中一条维护 */
  _startGyro() {
    if (typeof wx.startGyroscope !== 'function') return this._startAccel()
    wx.startGyroscope({
      interval: 'ui',
      success: () => {
        // success 迟到时页面已经切走：只能把刚起来的传感器关掉，
        // 既不注册回调也不置 running —— 否则传感器起在后台，还会挡住下次 start
        if (!this.wantRun) return wx.stopGyroscope({ complete: () => {} })
        this._ready('gyro')
        wx.onGyroscopeChange(this._handleGyro)
      },
      fail: () => this._startAccel(),
    })
  }

  _startAccel() {
    if (typeof wx.startAccelerometer !== 'function') return this._fail()
    wx.startAccelerometer({
      interval: 'ui',
      success: () => {
        if (!this.wantRun) return wx.stopAccelerometer({ complete: () => {} })
        this._ready('accel')
        wx.onAccelerometerChange(this._handleAccel)
      },
      fail: () => this._fail(),
    })
  }

  _ready(sensor) {
    this.sensor = sensor
    this.running = true
    this.available = true
  }

  _fail() {
    this.available = false
    this.running = false
    this.onUnavailable()
  }

  /** 角速度积分求转角。正负都累积，所以两个方向对称；哪根轴在转就积哪根 */
  _handleGyro(res) {
    if (!this.running) return
    const now = Date.now()
    const v = [Number(res.x) || 0, Number(res.y) || 0, Number(res.z) || 0]
    this.omega = v[2]
    this.samples++
    // dt 必须换成秒：角速度是 rad/s，直接拿毫秒相乘会放大一千倍
    const dt = this._dtSeconds(now)
    if (!dt) return

    // 一段旋转有总时长上限，超时就把攒下的角度丢掉重来。
    // 判据必须在死区分支**外面**：手一直轻微动时角速度常年高于死区，
    // 只在"停下来"那一刻才判超时，就永远等不到清零，攒几次抖动会攒出一次假翻转。
    if (this.spin !== 0 && now - this.spinStart > SPIN_HOLD_MS) this.spin = 0

    const pick = this._pickOmega(v)
    // 换轴：两根轴的积分拼在一起就是个假角度，攒过的那点直接作废
    if (pick.axis !== this.axis) {
      this.axis = pick.axis
      this.spin = this.spinStart = 0
    }
    if (Math.abs(pick.w) < OMEGA_DEAD) {
      this.spinDone = false // 停下来了：下一次旋转重新计数
      return
    }

    this._accumulate(pick.w, now, dt)
  }

  /**
   * 这一帧该积哪根轴的角速度。只认 z 轴的话，竖翻能认、横翻完全没反应 ——
   * 用户不该记"哪个方向才算翻"（C-4.2）。
   * 换轴要防抖：新轴得明显压过当前轴才换，否则一次竖翻会被手腕的歪动打断。
   * @returns {{w:number, axis:number}} w 为 0 表示三轴都在死区里
   */
  _pickOmega(v) {
    const a = [Math.abs(v[0]), Math.abs(v[1]), Math.abs(v[2])]
    const top = a[0] >= a[1] && a[0] >= a[2] ? 0 : a[1] >= a[2] ? 1 : 2
    if (a[top] < OMEGA_DEAD) return { w: 0, axis: this.axis }
    if (this.axis === null || this.axis === top || a[top] > a[this.axis] * AXIS_SWITCH_RATIO) {
      return { w: v[top], axis: top }
    }
    return { w: v[this.axis], axis: this.axis }
  }

  /** 把这一帧的角度累进去；够 150° 就兑现一次，并把剩下的角度丢掉 */
  _accumulate(w, now, dt) {
    // 这一下已经兑现过了，手还在把剩下的角度转完，不许再计入。
    // 不能只靠"停下来"复位：手一直轻微动时角速度可能一直在死区上方，
    // 那样后面所有翻转都会被吞掉，所以再给一条时间兜底。
    if (this.spinDone) {
      if (now - this.doneAt < SPIN_DONE_HOLD_MS) return
      this.spinDone = false
    }

    if (!this.spin) this.spinStart = now
    this.spin += w * dt
    if (Math.abs(this.spin) < TURN_RAD) return

    // 被 lock 挡下时**不清零**：留着累计量，下一帧接着试。
    // 清零再 return 等于把用户已经转过的 150° 直接扔掉，这一下就白翻了。
    if (!this._commitTurn()) return

    this.spin = this.spinStart = 0
    this.spinDone = true
    this.doneAt = now
  }

  /**
   * 这一帧该积多长时间（秒）。返回 null 表示这一帧不积：
   * 首帧没有上一帧可比；断流（挂起 / 被弹窗挡住）期间手转没转无从得知，
   * 拿它积分就是凭空造角度。
   */
  _dtSeconds(now) {
    if (!this.lastAt) {
      this.lastAt = now
      return null
    }
    const gap = now - this.lastAt
    this.lastAt = now
    if (gap > STALL_MS) return null
    return Math.min(gap, MAX_DT_MS) / 1000
  }

  /** 降级路径：只在陀螺仪起不来时跑，判据是单位重力向量的点积 */
  _handleAccel(res) {
    if (!this.running) return
    const n = unitGravity(res, this.magRef)
    if (!n) return
    this.magRef = this.magRef ? this.magRef + (n.mag - this.magRef) * MAG_EMA : n.mag
    this.samples++

    const now = Date.now()
    if (!this.baseline) {
      this.baseline = n
      return
    }

    const zone = zoneOf(n, this.baseline)
    if (!this.zone || this.zone.name !== zone) {
      this.zone = { name: zone, since: now }
      return
    }

    const held = now - this.zone.since
    if (held < GRAV_SETTLE_MS) return

    if (zone === 'down') {
      this.baseline = n
      this.zone = null
      this._commitTurn()
    } else if (zone === 'neutral' && held >= GRAV_REBASE_MS) {
      this.baseline = n
      this.zone = null
    }
  }

  /**
   * 确认一次翻转：先记账，再改姿态。
   * 顺序是关键 —— pending++ 是纯数值，不可能失败；_setPose 要碰 setData，
   * 万一它出岔子，动作也已经记在账上了，页面的滴答照样能取走。
   * 返回 false 表示被 lock 挡下（没有记账）。
   */
  _commitTurn() {
    const now = Date.now()
    if (now < this.lockUntil) return false
    this.lockUntil = now + COMMIT_LOCK_MS
    this.turns++
    this.pending++
    this._setPose(!this.upsideDown)
    return true
  }

  /** 姿态只影响渲染。渲染失败不能反过来吃掉动作 */
  _setPose(down) {
    if (this.upsideDown === down) return
    this.upsideDown = down
    try {
      this.onPose(down)
    } catch (e) {
      // 视图失败静默：动作那侧已经记在 pending 里了
    }
  }
}

module.exports = FlipDetector
