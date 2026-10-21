const FlipDetector = require('../../utils/flip')
const Countdown = require('../../utils/countdown')
const { formatHM, formatHMS, formatTarget } = require('../../utils/format')
const { fabStyle, menuRect } = require('../../utils/fab-pos')
const { FabSwitch } = require('../../utils/fab')
const prefs = require('../../utils/prefs')
const round = require('../../utils/round')

const PRESETS = [10, 15, 20, 25, 30, 45, 60, 90]

const TICK_MS = 200
const CLOSED_HOLD_MS = 1500
const ACTION_LOCK_MS = 400
const FINAL_MS = 60000

const NOTICE_CLOSED = '已关闭提醒'
const NOTICE_CANCELED = '已取消本轮'

Page({
  data: {
    state: 'idle', // idle | running | alert | closed
    mainText: '--:--',
    finalPhase: false,
    statusText: '',
    targetText: '',
    noticeText: '',
    durationMin: prefs.DEFAULT_MIN,
    presets: PRESETS,
    customMin: '',
    showPanel: false,
    panelMode: 'duration', // duration | glow
    glowColors: prefs.COLORS,
    glowLevels: prefs.LEVELS,
    glowColor: prefs.DEFAULT_COLOR,
    glowLevel: prefs.DEFAULT_LEVEL,
    glowStyle: {},
    flipAvailable: true,
    fabOpen: false,
    fabStyle: '',
  },

  // ===== 生命周期 =====
  onLoad() {
    this.countdown = new Countdown()
    this.fab = new FabSwitch((open) => this.setData({ fabOpen: open }))
    this.durationMin = prefs.readDuration()
    const glow = prefs.readGlow()
    this.actionLockUntil = 0
    this.closedUntil = 0
    this.onResize = () => this.placeFab()
    this.flipDetector = new FlipDetector({
      onPose: (down) => this.applyPose(down),
      onUnavailable: () => this.markFlipUnavailable(),
    })
    this.setData({
      durationMin: this.durationMin,
      glowColor: glow.color,
      glowLevel: glow.level,
      glowStyle: prefs.glowStyles(glow.color, glow.level),
      mainText: formatHM(new Date()),
      statusText: this.idleHint(true),
    })

    this.restoreRound()
    this.placeFab()
  },

  onShow() {
    // 常亮是产品成立的前提，每次回前台都要重设（C-1.3）
    wx.setKeepScreenOn({ keepScreenOn: true, fail: () => {} })
    this.flipDetector.reset()
    this.flipDetector.start()
    this.startTick()
    this.syncOnResume()
    // 窗口转动后胶囊会换到另一个角，钮的位置必须重算，不能只在 onLoad 算一次
    if (wx.onWindowResize) wx.onWindowResize(this.onResize)
  },

  onHide() {
    this.stopTick()
    this.flipDetector.stop()
    // 收起而不是只掐定时器：只掐定时器的话菜单会开着回到前台，
    // 而那个"3 秒后自己缩回"的定时器已经被掐掉了，它就再也不会收。
    this.fab.close()
    if (wx.offWindowResize) wx.offWindowResize(this.onResize)
  },

  onUnload() {
    this.onHide()
  },

  /**
   * 姿态变化了。内容由系统旋转保证正立（C-7.11），这里只做一件事：
   * 手机翻过去之后，微信胶囊在页面坐标系里换了个角，钮的位置得跟着重算。
   */
  applyPose() {
    this.placeFab()
  },

  startTick() {
    this.stopTick()
    this.timer = setInterval(() => this.onTick(), TICK_MS)
  },

  stopTick() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  },

  onTick() {
    // 动作在这里执行而非回调里（见 utils/flip.js 头部）：回调里的异常页面上看不见
    const turns = this.flipDetector.takeTurns()
    for (let i = 0; i < turns; i++) this.consumeTurn()

    const state = this.data.state
    if (state === 'running') this.refreshRunning()
    // 提醒态也是时钟：光在呼吸，数字照走，用户不必为了看时间先关提醒
    else if (state === 'idle' || state === 'alert') this.renderClock(false)
    // 关闭反馈的收尾交给滴答，不用 setTimeout：那个定时器一被 onHide 清掉就永远回不到待机
    else if (state === 'closed' && Date.now() >= this.closedUntil) this.toIdle()
    // 传感器"起来了却不送数"不会被判成失败，只能自己每秒查一次（C-4.6）
    if (this.flipDetector.pollSilent()) this.markFlipUnavailable()
  },

  refreshRunning() {
    if (this.countdown.remaining <= 0) {
      this.enterAlert()
      return
    }
    this.renderClock(this.countdown.remaining <= FINAL_MS)
  },

  /**
   * 中间区永远显示当前时间，不显示倒计时。finalPhase 只在最后一分钟为真。
   * 带秒还必须满足「正在计时」（C-3.4）：提醒态是"到点了"，秒要立刻收掉。
   * 守卫写在这里而不是靠调用方自觉 —— 任何一处误传 true 都拦得住。
   */
  renderClock(finalPhase) {
    const withSec = this.data.state === 'running' && !!finalPhase
    const text = withSec ? formatHMS(new Date()) : formatHM(new Date())
    if (text === this.data.mainText && withSec === this.data.finalPhase) return
    this.setData({ mainText: text, finalPhase: withSec })
  },

  /** 回到前台后按目标时间戳重算，不靠定时器累加 */
  syncOnResume() {
    const state = this.data.state
    // 关闭反馈期的定时器在 onHide 时被清掉了，这里补一次收敛，避免卡在 closed
    if (state === 'closed') {
      this.toIdle()
      return
    }
    if (state !== 'running') return
    if (this.countdown.finished) this.enterAlert()
    else this.refreshRunning()
  },

  // ===== 状态迁移 =====
  handleAction() {
    const now = Date.now()
    if (now < this.actionLockUntil) return
    this.actionLockUntil = now + ACTION_LOCK_MS
    if (this.data.state === 'idle') this.beginRound()
    else if (this.data.state === 'alert') this.closeAlert()
  },

  /** 消费一次翻转，两个方向一视同仁。异常只吞到这一层：一次动作出问题不能带走整个滴答 */
  consumeTurn() {
    try {
      this.applyTurn()
    } catch (e) {
      // 动作失败到此为止，滴答继续
    }
  },

  applyTurn() {
    // 面板开着说明手正在屏幕上操作，这一下更可能是误触：只收面板，不动计时（C-2.8）
    if (this.data.showPanel) return this.onClosePanel()
    if (this.data.state === 'alert') return this.closeAlert()
    // 计时中按 C-2.4 不响应；关闭反馈那 1.5 秒是防误启动唯一剩下的窗口（C-2.3），
    // 这期间翻一下没反应是预期行为，不是事件被吞了。
    if (this.data.state !== 'idle') return
    this.beginRound()
  },

  beginRound() {
    this.countdown.start(this.durationMin * 60000)
    this.saveRound()
    this.collapseFab()
    this.setData({
      state: 'running',
      statusText: '计时中',
      targetText: formatTarget(this.countdown.targetTs),
    })
    this.refreshRunning()
  },

  /**
   * 进入提醒态。三件事同时发生，缺一件用户就会觉得"到点了怎么不对劲"：
   * 秒立刻收掉回到 HH:mm（最后一分钟的秒是临近提示，到点即失效）；
   * 时钟继续走，不为提醒让位（C-1.7 / C-7.14）；光一直亮到用户主动关闭（C-1.6 / C-7.16）。
   */
  enterAlert() {
    this.closedUntil = 0
    this.collapseFab()
    this.setData({
      state: 'alert',
      finalPhase: false,
      mainText: formatHM(new Date()), // 中间不换字，提醒只由边缘的光表达（C-7.14）
      targetText: '',
      noticeText: '', // 上一轮「已关闭提醒」的残留，不清会在数据里待着
      statusText: '翻转或点击关闭',
    })
  },

  /**
   * 关闭提醒。防误启动只靠 showClosed 那 1.5 秒反馈期，不额外加冷却：
   * 冷却叠在反馈期后面不会多拦任何动作，却会让用户在待机态白翻一下。
   */
  closeAlert() {
    this.clearRound() // 关闭即清，避免 1.5s 反馈期内被杀、重进又弹出提醒
    this.showClosed(NOTICE_CLOSED)
  },

  /** 计时中途长按中央区：主动结束本轮，不进入提醒 */
  cancelRound() {
    this.clearRound()
    this.countdown.reset()
    this.showClosed(NOTICE_CANCELED)
  },

  /** 关闭反馈：中间一句大字，1.5 秒后由 onTick 收回待机。不用 setTimeout —— 它会被 onHide 清掉 */
  showClosed(text) {
    this.closedUntil = Date.now() + CLOSED_HOLD_MS
    this.collapseFab()
    this.setData({ state: 'closed', mainText: '', statusText: '', targetText: '', noticeText: text })
  },

  toIdle() {
    this.closedUntil = 0
    this.countdown.reset()
    this.clearRound()
    this.setData({
      state: 'idle',
      finalPhase: false,
      mainText: formatHM(new Date()),
      statusText: this.idleHint(),
    })
  },

  /** 冷启动重进时接上上一轮：没到点继续计时，过了点说明提醒从未被关闭，重新亮起（C-11.1） */
  restoreRound() {
    const saved = round.read()
    if (!saved) return

    this.countdown.resume(saved)
    if (saved <= Date.now()) {
      this.enterAlert()
      return
    }

    this.setData({
      state: 'running',
      statusText: '计时中',
      targetText: formatTarget(saved),
    })
    this.refreshRunning()
  },

  // ===== 本轮持久化（冷启动恢复）：键名与值域校验在 utils/round.js =====
  saveRound() {
    round.save(this.countdown.targetTs)
  },

  clearRound() {
    round.clear()
  },

  /** 点空白处：菜单展开时先收起，别顺手把计时开起来 */
  onStageTap() {
    if (this.data.fabOpen) {
      this.collapseFab()
      return
    }
    if (this.data.state !== 'alert') return
    this.handleAction()
  },

  onStartTap() {
    if (this.data.state === 'idle') this.handleAction()
  },

  onCloseTap() {
    if (this.data.state === 'alert') this.handleAction()
  },

  /**
   * 长按中央区：计时中取消本轮，提醒中关闭提醒。
   * 计时态不走 handleAction —— 翻转在计时态不响应（C-2.4），
   * 取消只能靠长按这个独立入口，两条路径互不干扰。
   */
  onMainLongPress() {
    const now = Date.now()
    if (now < this.actionLockUntil) return
    const state = this.data.state
    if (state === 'running') {
      this.actionLockUntil = now + ACTION_LOCK_MS
      this.cancelRound()
    } else if (state === 'alert') {
      this.handleAction()
    }
  },

  /** 细棍贴胶囊下沿，点开才长出菜单；3 秒不动自己缩回去（FabSwitch 管） */
  onToggleFab() {
    this.fab.toggle()
  },

  collapseFab() {
    this.fab.close()
  },

  /** 位置只能由胶囊矩形算：写死 vh 在异形屏上会撞进胶囊里（C-7.11） */
  placeFab() {
    this.setData({ fabStyle: fabStyle(menuRect()) })
  },

  /** 两套内容共用一层遮罩，靠 panelMode 切换 */
  onOpenPanel(e) {
    this.fab.close()
    if (this.data.state !== 'idle') return
    const mode = e.currentTarget.dataset.mode
    this.setData({ showPanel: true, panelMode: mode, customMin: String(this.durationMin) })
  },

  onClosePanel() {
    this.setData({ showPanel: false })
  },

  /** 改配色只影响下一轮（以及正在呼吸的这一轮），不碰计时 */
  onPickGlow(e) {
    const d = e.currentTarget.dataset
    const color = d.color || this.data.glowColor
    const level = d.level || this.data.glowLevel
    this.setData({ glowColor: color, glowLevel: level, glowStyle: prefs.glowStyles(color, level) })
    prefs.writeGlow(color, level)
  },

  /** 点预设只填进输入框，不动计时 —— 真正生效必须按「确定」 */
  onPickPreset(e) {
    const min = Number(e.currentTarget.dataset.min)
    if (!min) return
    this.setData({ customMin: String(min) })
  },

  onCustomInput(e) {
    this.setData({ customMin: e.detail.value })
  },

  onConfirmCustom() {
    const min = Math.round(Number(this.data.customMin))
    if (!min || min < prefs.MIN_MIN || min > prefs.MAX_MIN) {
      wx.showToast({ title: `请输入 ${prefs.MIN_MIN}-${prefs.MAX_MIN} 分钟`, icon: 'none' })
      return
    }
    this.applyDuration(min)
  },

  applyDuration(min) {
    this.durationMin = prefs.writeDuration(min)
    this.setData({
      durationMin: this.durationMin,
      customMin: String(this.durationMin),
      showPanel: false,
      statusText: this.data.state === 'idle' ? this.idleHint() : this.data.statusText,
    })
  },

  idleHint(flipAvailable) {
    const ok = flipAvailable === undefined ? this.data.flipAvailable : flipAvailable
    return ok ? '翻转开始' : '点右上小钮开始'
  },

  markFlipUnavailable() {
    if (!this.data.flipAvailable) return
    const idle = this.data.state === 'idle'
    this.setData({ flipAvailable: false, statusText: idle ? this.idleHint(false) : this.data.statusText })
  },

  // ===== 防烧屏 ===== 不做像素偏移：1px 相对 9vh 的大字只换掉百分之一的行，属伪防护（C-7.4）。

  noop() {},
})
