/**
 * 宪法自检
 *
 * 把 CONSTITUTION.md 里能自动判定的条款变成断言。
 * 改宪法条款时必须同步改这里（C-0.3）。
 *
 * 跑法：node test/constitution-check.js
 */

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const ROOT = path.resolve(__dirname, '..')
const results = []

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')
const exists = (p) => fs.existsSync(path.join(ROOT, p))

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function check(id, title, fn) {
  try {
    const detail = fn()
    results.push({ id, title, ok: true, detail: detail || '' })
  } catch (e) {
    results.push({ id, title, ok: false, detail: e.message })
  }
}

/** 从源码里抠出某个缩进 2 空格的方法体 */
/**
 * 取一个函数的函数体。
 * 既要认 Page 里的对象方法（缩进两格），也要认 utils 里的顶层函数 ——
 * 只认前者的话，检查挪到 utils 就会静默取到空串、永远通过。
 */
function methodBody(src, name) {
  const lines = src.split('\n')
  const asMethod = new RegExp('^  ' + name + '\\s*\\(')
  const asFunc = new RegExp('^function ' + name + '\\s*\\(')
  for (let i = 0; i < lines.length; i++) {
    const isMethod = asMethod.test(lines[i])
    const isFunc = asFunc.test(lines[i])
    if (!isMethod && !isFunc) continue
    const close = isMethod ? /^  \}/ : /^\}/
    let j = i + 1
    while (j < lines.length && !close.test(lines[j])) j++
    return lines.slice(i + 1, j).join('\n')
  }
  return ''
}

/** 统计一个方法体内非空非注释的行数 */
function codeLines(text) {
  return text.split('\n').filter((l) => l.trim() && !/^\s*(\/\/|\*|\/\*)/.test(l)).length
}

/** 递归收集指定目录下的源码文件 */
function walkDirs(roots) {
  const out = []
  const visit = (rel) => {
    for (const e of fs.readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const p = rel + '/' + e.name
      if (e.isDirectory()) visit(p)
      else if (/\.(js|wxml|wxss)$/.test(e.name)) out.push(p)
    }
  }
  roots.forEach(visit)
  return out.sort()
}

const PAGE_JS = 'pages/clock/index.js'
const PAGE_JSON = 'pages/clock/index.json'
const PAGE_WXML = 'pages/clock/index.wxml'
const PAGE_WXSS = 'pages/clock/index.wxss'
const GLOW_WXSS = 'styles/glow.wxss'
const PREFS_JS = 'utils/prefs.js'
const FLIP_JS = 'utils/flip.js'

// ===== 第 0 条 =====
check('C-0.6', '宪法与自检脚本同时存在', () => {
  assert(exists('CONSTITUTION.md'), '缺少 CONSTITUTION.md')
  assert(exists('test/constitution-check.js'), '缺少自检脚本')
  const doc = read('CONSTITUTION.md')
  assert(/版本 1\.\d+/.test(doc), 'CONSTITUTION.md 缺少版本号')
  return '版本 1.x'
})

check('C-0.3', '自检条款都能在宪法里找到', () => {
  const self = fs.readFileSync(__filename, 'utf8')
  const doc = read('CONSTITUTION.md')
  const ids = Array.from(self.matchAll(/check\('(C-[\w.]+)'/g), (m) => m[1])
  const missing = ids.filter((id) => !doc.includes(id.replace(/[ab]$/, '')))
  assert(missing.length === 0, '宪法里找不到：' + missing.join(', '))
  return ids.length + ' 条已对上'
})

check('C-6.1', '目录职责与必需文件齐全', () => {
  const need = [
    'app.js', 'app.json', 'app.wxss', 'sitemap.json', 'project.config.json',
    PAGE_JS, PAGE_WXML, PAGE_WXSS, 'pages/clock/index.json',
    'utils/flip.js', 'utils/countdown.js', 'utils/format.js', 'utils/fab.js', 'utils/fab-pos.js',
    'test/simulate.js', 'test/gap-check.js', 'test/constitution-check.js', 'test/mutation-check.js',
  ]
  const miss = need.filter((f) => !exists(f))
  assert(miss.length === 0, '缺失：' + miss.join(', '))
  return need.length + ' 个文件'
})

// ===== 第二章 状态机 =====
check('C-1.6', '提醒态不设自动超时，只有用户能关', () => {
  const js = read(PAGE_JS)
  // 提醒态的出口只允许是用户动作：翻转、点击、长按。
  // 任何定时器或"到点自愈"都不许碰 alert —— 手机摆桌上就是为了到点能看见，
  // 提醒自己没了，这台钟就是坏的。
  assert(!/setTimeout\([\s\S]{0,120}(closeAlert|toIdle)/.test(js), '用定时器自动结束了提醒')

  const turn = methodBody(js, 'applyTurn')
  assert(turn, '未找到 applyTurn')
  assert(
    /state === 'alert'[\s\S]{0,90}closeAlert\(\)/.test(turn),
    '提醒态缺少翻转关闭入口'
  )

  const tick = methodBody(js, 'onTick')
  assert(!/alert[\s\S]{0,120}(toIdle|closeAlert|showClosed)/.test(tick), 'onTick 里有自动退出提醒的分支')

  assert(/提醒态不设自动超时/.test(read('test/simulate.js')), '缺少「提醒态不自动消退」的仿真用例')
  return '无自动超时，仅用户可关'
})

check('C-2.1', '合法状态恰为 4 个且无越界', () => {
  const LEGAL = ['idle', 'running', 'alert', 'closed']
  const found = Array.from(read(PAGE_JS).matchAll(/state:\s*'([a-z]+)'/g), (m) => m[1])
  const illegal = found.filter((s) => !LEGAL.includes(s))
  assert(illegal.length === 0, '出现非法状态：' + illegal.join(', '))
  const uniq = Array.from(new Set(found))
  assert(uniq.length === 4, `状态应为 4 个，实际 ${uniq.length}（${uniq.join('/')}）`)
  return uniq.join(' / ')
})

check('C-2.2', '交互回调不得直接改 state', () => {
  const src = read(PAGE_JS)
  const events = [
    'onStageTap', 'onStartTap', 'onCloseTap', 'onMainLongPress', 'onPickPreset',
    'onCustomInput', 'onConfirmCustom', 'onOpenPanel', 'onClosePanel', 'applyPose',
  ]
  const bad = events.filter((m) => /state:\s*'/.test(methodBody(src, m)))
  assert(bad.length === 0, '这些回调直接写了 state：' + bad.join(', '))
  return events.length + ' 个回调已检查'
})

check('C-2.5', 'closed 有兜底收敛到 idle', () => {
  const body = methodBody(read(PAGE_JS), 'syncOnResume')
  assert(/state === 'closed'/.test(body), 'syncOnResume 未处理 closed')
  assert(/toIdle\(\)/.test(body), 'syncOnResume 未调用 toIdle')
  return 'syncOnResume 覆盖 closed → idle'
})

check('C-2.8', '面板开着时翻转只收面板，不启动计时', () => {
  const body = methodBody(read(PAGE_JS), 'applyTurn')
  assert(body, '未找到 applyTurn')
  assert(/showPanel/.test(body), '翻转没管面板：手在屏幕上操作时的误触会直接开一轮')
  assert(/onClosePanel\(\)/.test(body), '翻转不是收面板，而是穿过去了')
  return '翻转先收面板，不动计时'
})

check('C-2.6', '状态反馈不重复，且文案是人的口气', () => {
  const js = read(PAGE_JS)
  assert(/state: 'closed'[^}]*statusText: ''/.test(js), 'closed 态底部小字未清空，与中间大字重复')
  assert(!/alert-sub/.test(read(PAGE_WXML)), '提醒态出现第二处关闭提示，与底部小字重复')

  // 「已关闭提醒」那种是系统日志：用户刚翻完手机，再告诉他"你关闭了提醒"等于零信息。
  // 这一屏只有 1.5 秒，超过三个字读不完也等于没写。
  for (const m of js.matchAll(/NOTICE_(?:CLOSED|CANCELED) = '([^']*)'/g)) {
    assert(!/已/.test(m[1]), `反馈文案「${m[1]}」是系统播报体，要写成人的口气`)
    assert(m[1].length <= 3, `反馈文案「${m[1]}」太长，1.5 秒读不完`)
  }
  return 'closed 只留一句人话'
})

check('C-2.7', '计时中可长按取消，且不落回提醒态', () => {
  const src = read(PAGE_JS)
  const cancel = methodBody(src, 'cancelRound')
  assert(cancel, '缺少 cancelRound')
  assert(/this\.countdown\.reset\(\)/.test(cancel), '取消时未废弃目标时间戳')
  assert(/clearRound\(\)/.test(cancel), '取消时未清本轮记录')
  assert(!/enterAlert/.test(cancel), '取消不该进入提醒态')

  const long = methodBody(src, 'onMainLongPress')
  assert(/state === 'running'/.test(long), '长按未判断 running 态')
  assert(/cancelRound\(\)/.test(long), '长按未调用 cancelRound')
  assert(/bindlongpress="onMainLongPress"/.test(read(PAGE_WXML)), 'wxml 未绑定长按事件')

  // 第二条入口：菜单里的「取消」。它必须落到同一个 cancelRound，
  // 不能自己拼一套"清计时 + 弹提示"的流程
  const menu = methodBody(src, 'onCloseTap')
  assert(/cancelRound\(\)/.test(menu), '菜单里的取消没落到 cancelRound')
  assert(/state === 'running'/.test(menu), '菜单取消没判断 running 态')
  assert(/bindlongpress|onCloseTap/.test(read(PAGE_WXML)), 'wxml 未绑定菜单项事件')
  return '长按 + 菜单两条入口，同一个出口'
})

// ===== 第三章 时间 =====
check('C-3.2', '无累加式计时', () => {
  const src = read(PAGE_JS) + read('utils/countdown.js')
  const bad = /remain\s*[-+]=|elapsed\s*[-+]=|remain--|remain\+\+/.test(src)
  assert(!bad, '出现累加式计时')
  return '剩余时间全部现算'
})

check('C-3.4', '格式由剩余时间决定：HH:mm / HH:mm:ss', () => {
  const src = read(PAGE_JS)
  assert(/formatHMS\(new Date\(\)\)/.test(src), '最后一分钟未使用 formatHMS')
  assert(/formatHM\(new Date\(\)\)/.test(src), '常规态未使用 formatHM')
  assert(/renderClock\(/.test(src), '缺少统一取时入口 renderClock')
  assert(/FINAL_MS/.test(src), '缺少最后一分钟阈值')

  // 门槛写在 renderClock 内部：带秒必须同时满足「剩余 ≤60 秒」和「正在计时」。
  // 只靠调用方传参，迟早有一处漏判，到点后秒会赖在屏幕上不走。
  const body = methodBody(src, 'renderClock')
  assert(body, '未找到 renderClock')
  assert(/state === 'running'/.test(body), 'renderClock 没校验状态，到点后秒会赖着不走')
  return 'renderClock 取时 + 状态守卫'
})

check('C-3.5', '中间区不出现倒计时数字', () => {
  const src = read(PAGE_JS) + read('utils/format.js')
  assert(!/toCeilMinutes|toCeilSeconds/.test(src), '回归了剩余时间取整逻辑')
  assert(!/unit:/.test(read(PAGE_JS)), '残留 unit 单位字段')
  return '无倒计时、无单位'
})

check('C-3.6', 'mainText 只来自 formatHM/formatHMS', () => {
  const src = read(PAGE_JS)
  const ALLOW = /^(''|'--:--'|text|formatHMS?\(new Date\(\)\))$/
  const assigns = Array.from(src.matchAll(/mainText:\s*([^,\n}]+)/g), (m) => m[1].trim())
  assert(assigns.length >= 3, '未找到足够的 mainText 赋值')
  const bad = assigns.filter((v) => !ALLOW.test(v))
  assert(bad.length === 0, '非法来源：' + bad.join(' | '))
  return assigns.length + ' 处赋值全部合规'
})

check('C-3.7', '页面不自行赋值 targetTs', () => {
  const src = read(PAGE_JS)
  assert(!/targetTs\s*=/.test(src), '页面直接给 targetTs 赋值了')
  assert(/resume\(/.test(read('utils/countdown.js')), 'countdown 缺少 resume()')
  return '赋值只在 countdown 内部'
})

check('C-3.8', '右下角提醒时刻带秒', () => {
  const fmt = read('utils/format.js')
  assert(/function formatTarget[\s\S]*?'提醒时间 ' \+ formatHMS\(/.test(fmt), '提醒时刻退回只到分，用户等到整分没响会以为坏了')
  assert(/nowrap/.test(read(PAGE_WXSS).match(/\.target\s*\{[^}]*\}/)[0]), '角标没禁折行，长了会断成两行')
  return '提醒时刻 HH:mm:ss'
})

// ===== 第四章 传感器 =====
check('C-4.1', '主判据走陀螺仪，不用已废弃的方向接口', () => {
  const src = read(PAGE_JS) + read(FLIP_JS)
  const flip = read(FLIP_JS)
  assert(!/onDeviceOrientationChange/.test(src), '使用了已废弃的 onDeviceOrientationChange')
  // 加速度计测的是重力方向，平放在桌上转 180° 读数完全不变 —— 它不能当主判据
  assert(/onGyroscopeChange/.test(flip), '主判据不是陀螺仪，平放旋转会漏检')
  assert(/startGyroscope/.test(flip), '未启动陀螺仪')
  assert(/onAccelerometerChange/.test(flip), '缺少加速度计降级路径')
  // 模长下限必须跟自身量级比：加速度单位在文档里一会儿 g（≈1）一会儿 m/s²（≈9.8），
  // 写死绝对值等于赌其中一种，赌错这条防御就形同虚设
  assert(/ref \* MIN_MAG_RATIO/.test(flip), '模长下限写成了绝对值，量纲一变就失效')
  return '陀螺仪为主，加速度计降级'
})

check('C-4.2', '判据是三轴向量积分，且单位换算正确', () => {
  const src = read(FLIP_JS)
  const body = methodBody(src, '_handleGyro')
  assert(body, '未找到 _handleGyro')
  const acc = methodBody(src, '_accumulate')
  // 三根轴各自积分。只积一根、或者"挑主导轴再换轴清零"，都会把复合运动切碎：
  // 横翻时手腕必然带俯仰，主分量在 x / y 之间来回抢（真机就是这么翻不动）
  assert(
    /this\.rx \+= v\[0\] \* dt/.test(acc) &&
      /this\.ry \+= v\[1\] \* dt/.test(acc) &&
      /this\.rz \+= v\[2\] \* dt/.test(acc),
    '三轴没有各自积分，复合运动会被切碎',
  )
  // 总转角必须是三轴合成，不许只看某根轴
  assert(
    /Math\.sqrt\(this\.rx \* this\.rx \+ this\.ry \* this\.ry \+ this\.rz \* this\.rz\)/.test(
      methodBody(src, '_turned'),
    ),
    '总转角没做三轴合成',
  )
  assert(!/_pickOmega|AXIS_SWITCH_RATIO/.test(src), '残留"挑主导轴 / 换轴清零"那套')
  // 死区必须三轴都停才算停
  assert(
    /Math\.abs\(v\[0\]\) < OMEGA_DEAD && Math\.abs\(v\[1\]\) < OMEGA_DEAD && Math\.abs\(v\[2\]\) < OMEGA_DEAD/.test(
      body,
    ),
    '死区只看了一根轴',
  )
  // dt 是毫秒，乘 rad/s 之前必须换成秒；漏了这一步会放大一千倍，什么都触发。
  // 换算现在收在 _dtSeconds 里（断流判定也住那儿），所以查方法体而非 _handleGyro
  assert(/\/ 1000/.test(methodBody(src, '_dtSeconds')), 'dt 没换算成秒，积分放大一千倍')
  // 断流：挂起再回来的间隔是秒级，那段空隙无从得知，积分它就是凭空造角度
  assert(/gap > STALL_MS/.test(methodBody(src, '_dtSeconds')), '没有断流判定，挂起恢复会被当成一次旋转')
  // 上限不许往下收：钳到 120ms 时一次 200ms 一帧的快速翻转只算得到六成弧度，
  // 转满 180° 也认不出来 —— 翻了不认比误触发更难查
  assert(/MAX_DT_MS = 250/.test(src), '积分上限被收窄，掉帧时会把角度算小')
  assert(/OMEGA_DEAD/.test(body), '缺少死区，静止零偏会慢慢攒成假翻转')
  assert(!/lastSign/.test(src), '残留主轴符号记账（旧判据）')
  assert(/TURN_RAD\s*=\s*\(Math\.PI \* 150\) \/ 180/.test(src), '翻转阈值不是 150°')
  return 'z 轴积分 150° 确认'
})

check('C-4.3', '两个方向一视同仁，动作走队列不丢', () => {
  const flip = read(FLIP_JS)
  const page = read(PAGE_JS)
  // 判据里不许再出现"上一次翻转是否已用过"这种单向状态 —— 那正是"只认一侧"的来源
  assert(!/this\.armed/.test(flip), '又回到 armed 那套单向记账了')
  assert(!/rearm\(/.test(flip), '残留 rearm')
  // 判据天然不分方向：三轴积分取模长（_turned），正转反转走同一条式子
  assert(/this\._turned\(\) < TURN_RAD/.test(flip), '判据没对两个方向一视同仁')

  // 姿态渲染会碰 setData。它一旦出岔子，动作不能跟着一起消失 ——
  // 真机上"内容转过来了、计时没起来"就是这么来的。先记账，再渲染。
  const commit = methodBody(flip, '_commitTurn')
  assert(commit, '未找到 _commitTurn')
  const iPend = commit.indexOf('this.pending++')
  const iPose = commit.indexOf('_setPose')
  assert(iPend > -1, '确认翻转时没有记账，动作会跟着渲染一起丢')
  assert(iPose > iPend, '先渲染后记账：渲染出岔子就再也没有动作了')
  assert(/takeTurns\(\)/.test(flip), '缺少 takeTurns，页面取不走动作')

  const tick = methodBody(page, 'onTick')
  assert(/takeTurns\(\)/.test(tick), 'onTick 没取翻转动作，队列会永远堆着')

  const body = methodBody(page, 'applyTurn')
  assert(body, '未找到 applyTurn')
  assert(/state === 'alert'[\s\S]{0,90}closeAlert\(\)/.test(body), '提醒态翻转没关闭，用户得翻两次')
  assert(/state !== 'idle'/.test(body), '非待机态没拦，计时中翻一下就重启一轮')
  assert(/beginRound\(\)/.test(body), '待机态翻转没有启动入口')

  // 关闭后不再加时间冷却：它被 1.5 秒反馈期整个覆盖、多拦不到任何动作，
  // 只会让用户在待机态翻一下没反应。防误启动就靠反馈期这一层。
  assert(!/flipQuietUntil/.test(page), '又加回时间冷却了，翻一下会没反应')
  assert(/关闭反馈期内翻转被忽略/.test(read('test/simulate.js')), '缺少反馈期忽略翻转的仿真用例')
  return '双向对称 + 队列不丢 + 只靠反馈期'
})

check('C-4.5', 'onShow 启动、onHide 停止传感器', () => {
  const src = read(PAGE_JS)
  assert(/flipDetector\.start\(\)/.test(methodBody(src, 'onShow')), 'onShow 未启动传感器')
  assert(/flipDetector\.stop\(\)/.test(methodBody(src, 'onHide')), 'onHide 未停止传感器')
  return '生命周期对称'
})

check('C-4.6', '传感器失败有纯点击降级', () => {
  const src = read(PAGE_JS)
  assert(/markFlipUnavailable/.test(src), '缺少降级处理')
  assert(/点右上角小横杠开始/.test(src), '降级文案缺失')
  assert(/onStartTap/.test(src) && /onCloseTap/.test(src), '缺少按钮备用路径')
  return '降级 + 按钮'
})

check('C-4.7', '传感器启动不套隐私授权', () => {
  const src = read(FLIP_JS)
  // 加速度计不在微信隐私接口名单，套 requirePrivacyAuthorize 会在隐私指引缺失时把传感器拖死
  assert(!/requirePrivacyAuthorize/.test(src), '加速度计不属于隐私接口，套上会把传感器一起拖死')
  assert(/this\.onUnavailable\(\)/.test(src), '失败未上报降级')
  return '不套隐私授权，失败直接降级'
})

check('C-4.8', '两条传感器路径的采样频率都是 ui', () => {
  // 两个 start 各写一次 interval，只查其中一处会漏掉另一处 —— 变异测试就是靠这个暴露的
  const flip = read(FLIP_JS)
  ;['_startGyro', '_startAccel'].forEach((m) => {
    const body = methodBody(flip, m)
    assert(body, `未找到 ${m}`)
    assert(/interval:\s*'ui'/.test(body), `${m} 的采样频率不是 ui`)
  })
  return "两处都是 'ui'"
})

check('C-4.9', '传感器"假可用"能判出来；启停不把传感器留在后台', () => {
  const flip = read('utils/flip.js')
  const page = read('pages/clock/index.js')
  // 接口成功却一帧不送，不算失败，走不到 C-4.6 的降级：只能自己轮询
  assert(/pollSilent\(\)/.test(flip), '缺少假可用检测')
  assert(/pollSilent\(\)/.test(page), '页面没有轮询，判出来也不会降级')

  // 启动的 success 是异步的：stop 不能因为 running 还是 false 就什么都不做
  assert(/wantRun/.test(flip), '启停没有意图标志，迟到的 success 会把传感器起在后台')
  ;['stopGyroscope', 'stopAccelerometer'].forEach((api) => {
    assert(
      new RegExp(`if \\(!this\\.wantRun\\) return wx\\.${api}`).test(flip),
      `迟到的 ${api} 成功没有自我了断，传感器会起在后台`
    )
  })

  // 自检收敛：读数面板与它的模块都不许再出现（C-6.4 回落到 400 的前提）
  assert(!/utils\/debug/.test(page), '自检读数模块还在被引用')
  assert(!/dbg/.test(read('pages/clock/index.wxml')), '自检面板还渲染在页面上')
  return '假可用可判 + 启停无竞态 + 自检已删'
})

// ===== 第五章 存储 =====
check('C-5.1', '存储 key 统一前缀', () => {
  // 键名现在分散在 prefs.js（偏好）和页面（本轮记录）两处。
  // 只扫页面会扫到空集然后静默通过 —— 这正是这次漏掉一个变异的原因。
  const src = read(PREFS_JS) + '\n' + read(PAGE_JS)
  const keys = Array.from(src.matchAll(/const (?:KEY|STORE)_\w+\s*=\s*'([^']+)'/g), (m) => m[1])
  assert(keys.length > 0, '未找到任何存储 key 常量')
  const bad = keys.filter((k) => !k.startsWith('flip_timer_'))
  assert(bad.length === 0, '前缀不合规：' + bad.join(', '))
  return keys.join(' / ')
})

check('C-5.4', 'closeAlert 即刻清理本轮记录', () => {
  const body = methodBody(read(PAGE_JS), 'closeAlert')
  assert(/clearRound\(\)/.test(body), 'closeAlert 未清理存储')
  const at = body.indexOf('clearRound()')
  const set = body.indexOf('setData')
  assert(set === -1 || at < set, 'clearRound 应在反馈提示之前')
  return '先清再提示'
})

check('C-5.5', '读存储有值域校验', () => {
  const src = read(PREFS_JS)
  const body = methodBody(src, 'readDuration')
  assert(/MIN_MIN/.test(body) && /MAX_MIN/.test(body), 'readDuration 缺少值域校验')
  assert(/DEFAULT_MIN/.test(body), '缺少默认值回落')
  assert(/normalizeGlow/.test(methodBody(src, 'readGlow')), 'readGlow 缺少合法化')
  return '越界回落默认值'
})

// ===== 第六章 结构 =====
check('C-6.2', 'utils 不反向依赖 pages', () => {
  const files = fs.readdirSync(path.join(ROOT, 'utils')).filter((f) => f.endsWith('.js'))
  const bad = files.filter((f) => /require\([^)]*pages\//.test(read('utils/' + f)))
  assert(bad.length === 0, '反向依赖：' + bad.join(', '))
  return files.length + ' 个工具文件'
})

check('C-6.3', '只有 flip.js 接触传感器接口', () => {
  // 这里只管传感器。storage 归第五章管，prefs.js 用 wx.setStorageSync 不算越界；
  // 原来按"任何 wx."判定，等于变相要求所有 util 都不许落盘，这不是本章的意思。
  const files = fs.readdirSync(path.join(ROOT, 'utils')).filter((f) => f.endsWith('.js') && f !== 'flip.js')
  const sensor = /Accelerometer|Gyroscope|DeviceMotion|requirePrivacyAuthorize/
  const bad = files.filter((f) => sensor.test(read('utils/' + f)))
  assert(bad.length === 0, '这些 utils 碰了传感器：' + bad.join(', '))
  return files.length + ' 个其余 utils 不碰传感器'
})

check('C-6.4', '单文件总行数不超过 400', () => {
  const files = walkDirs(['pages', 'utils', 'styles'])
  let max = 0
  let maxName = ''
  for (const f of files) {
    const n = read(f).replace(/\n$/, '').split('\n').length
    assert(n <= 400, `${f} 有 ${n} 行，超过 400`)
    if (n > max) {
      max = n
      maxName = f
    }
  }
  return `${files.length} 个文件，最大 ${path.basename(maxName)}:${max}`
})

check('C-6.5', '单函数不超过 25 行代码', () => {
  const files = [PAGE_JS, FLIP_JS, 'utils/fab.js', 'utils/fab-pos.js']
  const over = []
  let max = 0
  let maxName = ''
  for (const f of files) {
    const lines = read(f).split('\n')
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^  (\w+)\s*\([^)]*\)\s*\{/)
      if (!m) continue
      let j = i + 1
      while (j < lines.length && !/^  \}/.test(lines[j])) j++
      const n = codeLines(lines.slice(i + 1, j).join('\n'))
      if (n > max) {
        max = n
        maxName = m[1]
      }
      if (n > 25) over.push(`${path.basename(f)}.${m[1]}=${n}`)
    }
  }
  assert(over.length === 0, '超限：' + over.join(', '))
  return `最长 ${maxName} ${max} 行`
})

check('C-6.7', '未引入 npm 依赖', () => {
  if (!exists('package.json')) return '无 package.json'
  const pkg = JSON.parse(read('package.json'))
  const deps = Object.keys(Object.assign({}, pkg.dependencies, pkg.devDependencies))
  assert(deps.length === 0, '存在依赖：' + deps.join(', '))
  return '依赖数 0'
})

check('C-6.10', '基础库版本不低于 2.32.3', () => {
  const ver = JSON.parse(read('project.config.json')).libVersion
  assert(ver, 'libVersion 缺失')
  const parts = (v) => String(v).split('.').map(Number)
  const a = parts(ver)
  const b = parts('2.32.3')
  for (let i = 0; i < 3; i++) {
    const x = a[i] || 0
    const y = b[i] || 0
    if (x > y) return 'libVersion ' + ver
    assert(x === y, `libVersion ${ver} 低于 2.32.3`)
  }
  return 'libVersion ' + ver
})

// ===== 第七章 样式 =====
check('C-7.1', '背景纯黑', () => {
  assert(/background:\s*#000000/i.test(read('app.wxss')), 'app.wxss 背景不是纯黑')
  assert(/background:\s*#000000/i.test(read(PAGE_WXSS)), '页面舞台背景不是纯黑')
  return '#000000'
})

check('C-7.2', '无 px 写死的字号', () => {
  const bad = Array.from(read(PAGE_WXSS).matchAll(/font-size:\s*([\d.]+)px/g), (m) => m[0])
  assert(bad.length === 0, '出现 px 字号：' + bad.join(', '))
  return '全部使用 vh/vw'
})

check('C-7.3', '数字等宽', () => {
  assert(/tabular-nums/.test(read(PAGE_WXSS)), '缺少 tabular-nums')
  return 'tabular-nums'
})

check('C-7.4', '未复活像素偏移', () => {
  const bad = [PAGE_JS, PAGE_WXML, PAGE_WXSS].filter((f) => /drift/i.test(read(f)))
  assert(bad.length === 0, 'drift 残留：' + bad.join(', '))
  return '无 drift'
})

check('C-7.5', '近场阴影 + 远场渐变带，带宽够且无折线', () => {
  const css = read(PAGE_WXSS)
  const glow = read(GLOW_WXSS)
  const dur = (css + glow).match(/animation:\s*breathe\s+([\d.]+)s/)
  assert(dur, '未找到 breathe 动画挂载点')
  const s = Number(dur[1])
  assert(s >= 4 && s <= 6, `呼吸周期 ${s}s 不在 4~6 秒`)
  assert(!/rainbow|hue-rotate/.test(css + glow), '出现色相循环')
  // 光效是独立视觉单元，必须从 styles/ 引入，不许又长回页面文件
  assert(/@import\s+["']\.\.\/\.\.\/styles\/glow\.wxss["']/.test(css), 'index.wxss 没有引入 styles/glow.wxss')
  assert(!/\.glow\s*\{/.test(css), '光效样式又长回 index.wxss 了')

  // 阴影和渐变的实际内容由 prefs.glowStyles() 生成——WXSS 会丢弃 rgba(var())，
  // 所以这两块只能查生成的字符串，不能只查样式表。
  const st = require('../utils/prefs').glowStyles('green', 'std')

  const layers = (st.near.match(/inset/g) || []).length
  assert(layers >= 3, `近场只有 ${layers} 层阴影，贴边最亮那一圈做不出来`)
  // spread 非零 = 从一条内缩的线开始发光，边缘必然是断崖
  assert(!/inset 0 0 [\d.]+vh [1-9]/.test(st.near), '近场用了 spread，会形成硬边亮带')

  const box = glow.match(/\.glow,\s*\n\.glow-far\s*\{[^}]*\}/)
  assert(box, '.glow 与 .glow-far 没有共用定位块')
  assert(/top:\s*0;/.test(box[0]) && /left:\s*0;/.test(box[0]), '发光层没铺到屏幕物理边缘')

  // 远场：只有 box-shadow 做不出带宽（高斯衰减在远处已归零），必须有渐变带补
  const grads = (st.far.match(/linear-gradient/g) || []).length
  assert(grads === 4, `远场有 ${grads} 条渐变，四边各一条才对`)
  assert(
    /background-size: 100% 24%, 100% 24%, 24% 100%, 24% 100%/.test(st.far),
    '远场带宽不是 24%，短边会被压成一条细线'
  )
  // stop 中途归零会留下一条能看见的直边；带宽只允许由 background-size 表达
  const gradPart = st.far.split('; background-size')[0]
  const badStop = gradPart.split(', linear-gradient').filter((l) => /\d+%/.test(l))
  assert(badStop.length === 0, `渐变里写了百分比 stop，会留下折线：${badStop.length} 处`)

  const frames = glow.match(/@keyframes breathe[\s\S]*?\n\}/)
  assert(frames && /opacity:\s*0\.[3-9]/.test(frames[0]), '呼吸谷底太暗，大半个周期会看起来没在提醒')
  return `近场 ${layers} 层 + 远场 ${grads} 条渐变带，周期 ${s}s`
})

check('C-7.7', '无 emoji；渐变只出现在发光层', () => {
  const emoji = [PAGE_WXML, PAGE_WXSS, GLOW_WXSS, 'app.wxss'].filter((f) => /[\u{1F300}-\u{1FAFF}]/u.test(read(f)))
  assert(emoji.length === 0, '出现 emoji：' + emoji.join(', '))

  // 渐变是功能性用途（C-7.5 的远场），只许出现在 prefs.glowStyles() 生成的远场串里；
  // 出现在样式表或页面里就是"渐变色卡片"，那是 AI 三件套
  const outside = [PAGE_WXSS, PAGE_WXML, GLOW_WXSS, 'app.wxss'].filter((f) =>
    /linear-gradient|radial-gradient/.test(read(f))
  )
  assert(outside.length === 0, '渐变跑到 prefs 之外了：' + outside.join(', '))

  const st = require('../utils/prefs').glowStyles('green', 'std')
  assert((st.far.match(/linear-gradient/g) || []).length === 4, '远场渐变只有四条才够围一圈')
  assert(!/gradient/.test(st.near) && !/gradient/.test(st.pre), '近场和预览条不该出现渐变')
  return '无 emoji，4 处渐变全在远场串里'
})

check('C-7.10', '可点击元素有最小触摸高度', () => {
  const css = read(PAGE_WXSS)
  const need = ['.fab-pin', '.fab-item', '.preset', '.custom-ok']
  const miss = need.filter((sel) => {
    const block = css.match(new RegExp('\\' + sel + '\\s*\\{[^}]*\\}'))
    return !block || !/min-height:\s*[\d.]+vh/.test(block[0])
  })
  assert(miss.length === 0, '缺少 min-height：' + miss.join(', '))
  assert(!/color:\s*#5f5a52/i.test(css), '设置入口又暗回去了')
  return need.length + ' 个可点元素达标'
})

check('C-7.11', '悬浮钮贴胶囊下方、在内容层之外，且内容不做 180° 主动补偿', () => {
  // 矩形读取与换算已收进 utils/fab-pos.js（页面那侧只留一行调用），两处都要查
  const pos = read('utils/fab-pos.js')
  assert(/getMenuButtonBoundingClientRect/.test(pos), '位置没从胶囊矩形取，写死迟早撞进胶囊')

  const js = read(PAGE_JS)
  assert(/fabStyle\(menuRect\(\)/.test(js), '页面没走 fabStyle 换算')
  assert(/placeFab\(\)/.test(methodBody(js, 'applyPose')), '姿态变了没重算位置，胶囊换角后钮会漂')

  // 红线：内容层不许做姿态补偿。页面固定横屏，翻 180° 时重力反号、
  // 系统自己会把页面转过来，再补一次就是两遍 —— 真机上字是倒的
  const wxml = read(PAGE_WXML)
  const css = read(PAGE_WXSS)
  assert(/"pageOrientation":\s*"landscape"/.test(read(PAGE_JSON)), '页面不是固定横屏，C-7.11 的前提不成立')
  assert(!/rotate\(\s*180deg\s*\)/.test(wxml + css), '内容在做 180° 主动补偿，会和系统旋转叠加成倒立')
  assert(!/\.flipper\.up/.test(css), '残留 .flipper.up 旋转补偿')

  const fab = css.match(/\.fab\s*\{[^}]*\}/)
  assert(fab, '未找到 .fab')
  assert(/position:\s*absolute/.test(fab[0]), '.fab 不是绝对定位，进不了边缘')
  assert(/z-index:\s*2\d/.test(fab[0]), '.fab 缺 z-index，会被铺满全屏的 .main 吃掉点击')

  const flipStart = wxml.indexOf('class="flipper')
  const flipEnd = wxml.indexOf('<!-- /flipper')
  const fabAt = wxml.indexOf('class="fab')
  assert(flipEnd > 0, '缺少 /flipper 结束标记，无法判断悬浮钮在不在内容层内')
  assert(fabAt > 0 && fabAt < flipStart, '悬浮钮被放进内容层，会跟着一起被系统转')
  return '贴胶囊下方，内容层之外'
})

check('C-7.12', '收起态只是一根细棍，展开才长出菜单', () => {
  const css = read(PAGE_WXSS)
  assert(/\.fab-pin::after\s*\{[^}]*height:\s*[\d.]+vh/.test(css), '细棍没画出来')

  const pin = css.match(/\.fab-pin\s*\{[^}]*\}/)
  assert(/min-height:\s*[\d.]+vh/.test(pin[0]), '细棍点击区没撑起来，戳不中')
  assert(/min-width:\s*[\d.]+vh/.test(pin[0]), '细棍点击区太窄，戳不中')

  // 只认行首那条 `.fab-menu {`：翻转态的 `.fab.mirror .fab-menu` 是覆盖块，
  // 拿它当基准会误判"收起态菜单没隐藏"
  const menu = css.match(/\n\.fab-menu\s*\{[^}]*\}/)
  assert(menu, '未找到 .fab-menu 基准块')
  assert(/visibility:\s*hidden/.test(menu[0]), '收起态菜单没隐藏')
  assert(/pointer-events:\s*none/.test(menu[0]), '收起态菜单还接收点击，会误触')
  const on = css.match(/\n\.fab-menu\.on\s*\{[^}]*\}/)
  assert(on && /pointer-events:\s*auto/.test(on[0]), '展开态菜单点不动')

  // 三态都得出得来：计时态藏掉的话，用户想中途取消只剩没人会猜的长按
  const wxml = read(PAGE_WXML)
  const fabIf = wxml.match(/class="fab"[^>]*wx:if="([^"]+)"/)
  assert(fabIf, '未找到悬浮钮的显示条件')
  assert(!/state !== 'running'/.test(fabIf[1]), '计时中把悬浮钮藏了，用户没法手动取消（C-2.7）')
  assert(/state !== 'closed'/.test(fabIf[1]), 'closed 反馈期不该显示，会挡着那句大字')
  return '三态可达，菜单按需展开'
})

check('C-7.13', '菜单会自己缩回，点空白优先收起', () => {
  const fab = read('utils/fab.js')
  assert(/FAB_HOLD_MS\s*=\s*\d{4}/.test(fab), '缺少自动收起时长')
  assert(/setTimeout\(/.test(fab), '缺少收起定时器')
  assert(/clearTimeout\(/.test(fab), '收起时没清定时器，会晚一步又缩一次')

  const tap = methodBody(read(PAGE_JS), 'onStageTap')
  const at = tap.indexOf('fabOpen')
  assert(at >= 0, 'onStageTap 没处理展开态')
  assert(at < tap.indexOf('handleAction'), '展开时点空白会直接触发动作，应先收起')
  return '3 秒自动收起，点空白优先收起'
})

check('C-7.14', '提醒态不换字，时钟照走', () => {
  assert(!/alert-title/.test(read(PAGE_WXML)), '提醒态又换成了文案标题，时钟被从屏幕上拿走了')

  const js = read(PAGE_JS)
  const enter = methodBody(js, 'enterAlert')
  assert(enter, '未找到 enterAlert')
  assert(!/mainText:\s*''/.test(enter), 'enterAlert 把时钟清空了')
  assert(/mainText:\s*formatHM\(new Date\(\)\)/.test(enter), 'enterAlert 没有重设当前时间')

  const tick = methodBody(js, 'onTick')
  assert(tick, '未找到 onTick')
  assert(/state === 'alert'|'alert'/.test(tick), '提醒态没有接入走时')
  assert(/renderClock/.test(tick), '提醒态只切状态不刷新时钟，数字会冻在到点那一分')
  return '提醒态时钟继续走'
})

check('C-7.15', '发光样式不用 CSS 变量，三色三档只算一次', () => {
  const cssAll = read(GLOW_WXSS) + read(PAGE_WXSS) + read(PAGE_WXML)
  // 核心红线：rgba(var(--x)) 在 WXSS 编译期会被整条丢弃，真机表现为「到点一片黑」
  assert(!/rgba?\(\s*var\(/.test(cssAll), '出现 rgba(var())，WXSS 会把整条声明丢掉')
  assert(!/var\(--gc\)|var\(--a[123]\)|var\(--fa\)/.test(cssAll), '还在消费已废弃的发光变量')

  const prefs = read(PREFS_JS)
  const ids = prefs.match(/id: '(green|red|blue)'/g) || []
  assert(ids.length === 3, `预置颜色应为 3 个，实际 ${ids.length}`)

  const p = require('../utils/prefs')
  assert(/rgba\(96, 158, 226,/.test(p.glowStyles('blue', 'strong').near), '换色没进到近场串里')
  assert(/rgba\(228, 92, 84,/.test(p.glowStyles('red', 'soft').near), '换色没进到近场串里')
  assert(!/var\(/.test(p.glowStyles('green', 'std').near + p.glowStyles('green', 'std').far), '样式串里残留变量')

  // 强度必须是倍率，不能是用户直接填的 alpha
  assert(/k: [\d.]+/.test(prefs), '强度档没有倍率定义')

  // 非法值要回落到显式默认档；用 list[0] 兜底会让"存储坏了"掉到「淡」
  const norm = methodBody(prefs, 'normalizeGlow')
  assert(/DEFAULT_COLOR/.test(norm) && /DEFAULT_LEVEL/.test(norm), '非法值没回落到显式默认档')
  return '3 色 × 3 档，输出完整 rgba 串'
})

// ===== 第十一章 禁止清单 =====
check('C-7.16', '提醒光不靠动画独撑，animation 被掐掉也还在', () => {
  const glow = read(GLOW_WXSS)
  const on = glow.match(/\.glow-on\s*\{[^}]*\}/)
  assert(on, '未找到 .glow-on')

  // 呼吸是 animation 改 opacity，而 .glow 的基准值是 0。
  // iOS「减弱动态效果」、低电量模式、WebView 回收合成层都会让动画不跑，
  // 没有静态兜底就是「到点一片黑」——和 C-7.15 那个坑外观完全一样。
  assert(/opacity:\s*1/.test(on[0]), '.glow-on 没有静态 opacity 兜底，动画被禁用时整块光消失')
  assert(/animation:\s*breathe/.test(on[0]), '.glow-on 没接呼吸动画')
  return '静态兜底 + 呼吸叠加'
})

check('C-7.17', '菜单里有「说明」入口，面板是纯文字说明', () => {
  const wxml = read(PAGE_WXML)
  assert(/data-mode="help"/.test(wxml), '菜单里没有「说明」入口，新用户不知道该翻手机')
  assert(/panelMode === 'help'/.test(wxml), '没有对应的说明面板')

  const list = wxml.match(/class="help-list"[\s\S]*?<\/view>/)
  assert(list, '说明内容没放进 help-list')
  const rows = (list[0].match(/<text>/g) || []).length
  assert(rows >= 3 && rows <= 5, `说明 ${rows} 条，超出 3~5 条的范围`)
  assert(!/onStartTap|onCloseTap/.test(list[0]), '说明面板里塞了动作按钮，说明只负责解释')

  // 说明面板的样式独立成 styles/help.wxss（自带尺寸与字号，见 C-7.17）
  const help = read('styles/help.wxss')
  assert(/\.help-list\s*\{[^}]*\}/.test(help), '缺少 help-list 样式')
  // 它是拿来读的，字号必须比设置面板大一档，否则真机上「看着费劲」
  const size = help.match(/\.help-list\s*\{[^}]*font-size:\s*([\d.]+)vh/)
  assert(size && Number(size[1]) >= 4, `说明正文 ${size && size[1]}vh，太小了`)
  assert(/\.panel\.wide\s*\{[^}]*width:\s*8\dvw/.test(help), '说明面板没放大，长句子会挤成一堆')
  return `菜单有说明入口，${rows} 条说明，正文 ${size[1]}vh`
})

check('C-11.1', '业务代码无 console 残留', () => {
  const files = ['app.js', PAGE_JS, FLIP_JS, 'utils/countdown.js', 'utils/format.js']
  const bad = files.filter((f) => /console\.(log|debug|info)\(/.test(read(f)))
  assert(bad.length === 0, '有 console：' + bad.join(', '))
  return files.length + ' 个文件干净'
})

// ===== 第八章 测试 =====
function runNode(rel) {
  try {
    const out = execFileSync(process.execPath, [rel], { cwd: ROOT, encoding: 'utf8' })
    return { ok: true, out }
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') }
  }
}

check('C-8.5a', '逻辑仿真全绿且条数达标', () => {
  const r = runNode('test/simulate.js')
  assert(r.ok, 'simulate.js 未通过')
  const m = r.out.match(/(\d+)\/(\d+) 通过/)
  assert(m, '未识别到通过数')
  assert(m[1] === m[2], `有失败用例 ${m[1]}/${m[2]}`)
  assert(Number(m[1]) >= 50, `用例仅 ${m[1]} 条，少于基线 50`)
  return `${m[1]}/${m[2]}`
})

check('C-8.5b', '真实轨迹不漏检', () => {
  const r = runNode('test/gap-check.js')
  assert(r.ok, 'gap-check.js 未通过（真实翻转漏检）')
  const hits = r.out.match(/触发 (\d+) 次/g) || []
  assert(hits.length === 2, '场景数应为 2')
  assert(hits.every((h) => h === '触发 1 次'), '存在漏检或误触发')
  return '2/2 场景正常'
})

// ===== 输出 =====
const failed = results.filter((r) => !r.ok)

console.log('\n宪法自检 v1.11 · 对应 CONSTITUTION.md\n')
for (const r of results) {
  const mark = r.ok ? 'PASS' : 'FAIL'
  console.log(`  ${mark}  ${r.id.padEnd(8)} ${r.title.padEnd(26)} ${r.detail}`)
}
console.log(`\n通过 ${results.length - failed.length} / ${results.length}\n`)
process.exitCode = failed.length ? 1 : 0
