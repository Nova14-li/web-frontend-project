const DATA_URL = '../data/d1.json'; // d1.html 在 src/，数据在 data/，故回退一层
const PLAY_INTERVAL = 800;          // 播放时每步停留毫秒数，只影响节奏，不影响结果

/** 一次性抓取页面要用到的元素，避免在函数里反复查询 */
const el = {
  title: $('#title'),
  summary: $('#summary'),
  narration: $('#narration'),
  code: $('#code'),
  stack: $('#stack'),
  depth: $('#depth'),
  legend: $('#legend'),
  counter: $('#counter'),
  hint: $('#hint'),
  status: $('#status'),
  paramLabel: $('#param-label'),
  paramInput: $('#param-input'),
  playBtn: $('[data-act="play"]'),
  prevBtn: $('[data-act="prev"]'),
  nextBtn: $('[data-act="next"]'),
};

/** 运行期状态；步骤下标与定时器已经交给 common.js 的 player 管 */
let data = null;     // 整份 JSON（模板都从这里取）
let steps = [];      // 当前 n 生成出来的步骤序列
let currentN = 3;    // 当前使用的 n
let labels = {};     // 「状态 → 中文名」映射，由 renderLegend 生成

const stepById = (id) => data.steps.find((s) => s.id === id);
const codePanel = createCodePanel(el.code); // 代码区组件，渲染与高亮都委托给它

/* ---------- 1. 按 n 生成整条调用序列（d1 独有） ---------- */

/**
 * 模拟 fib(n) 的执行，把「每发生一件事」记成一条步骤快照。
 * 每步存完整栈快照，渲染端只管照着画，因此单步回退天然成立。
 *
 * 快照字段：line（高亮行号）、text（解说）、call（即将执行的调用）、stack（栈底 → 栈顶）
 * 帧字段：  n（本层的参数）、state（run/wait/done）、note（局部状态）、ret（返回地址）
 *
 * @param {number} n 递归参数
 * @returns {Array} 步骤数组
 */
function buildTrace(n) {
  const out = [];
  const stack = [];
  const snap = (id, vars) => {
    const tpl = stepById(id);
    out.push({
      line: tpl.line,
      text: fill(tpl.text, vars),
      call: tpl.call, // 该步「即将执行」的调用表达式，模板里没写就是 undefined
      stack: stack.map((f) => ({ ...f })), // 复制一份，避免后续改动污染快照
    });
  };

  let calls = 0;      // 累计调用次数
  let maxDepth = 0;   // 最大栈深

  // 真递归：与讲解的算法一一对应，压栈/弹栈就是数组 push/pop
  function fib(k, ret, depth) {
    calls += 1;
    maxDepth = Math.max(maxDepth, depth);

    // 入栈：这一层的 n 是独立的一份拷贝
    const frame = { n: k, state: 'run', note: fill(data.frame.noteEnter, { n: k }), ret };
    stack.push(frame);
    snap(depth === 1 ? 'enter' : 'push', { n: k, depth });

    // 基线：n <= 1 直接返回，不再往下递归
    if (k <= 1) {
      frame.state = 'done';
      frame.note = fill(data.frame.noteBase, { n: k });
      snap('base', { n: k });
      stack.pop();
      return k;
    }

    // 先算左槽 fib(k-1)，本层转入等待
    frame.state = 'wait';
    frame.note = fill(data.frame.noteWaitLeft, { m: k - 1 });
    snap('test', { n: k, m: k - 1 });
    const a = fib(k - 1, fill(data.frame.retLeft, { line: stepById('test').line }), depth + 1);

    // 左槽回来：本层恢复执行，接着算右槽 fib(k-2)
    frame.state = 'run';
    frame.note = fill(data.frame.noteWaitRight, { a, m: k - 2 });
    snap('backLeft', { m: k - 1, value: a, n: k, r: k - 2 });
    frame.state = 'wait';
    const b = fib(k - 2, fill(data.frame.retRight, { line: stepById('test').line }), depth + 1);

    // 右槽也回来：两槽齐全，求和后弹栈
    frame.state = 'run';
    frame.note = fill(data.frame.noteBackRight, { b });
    snap('backRight', { m: k - 2, value: b, n: k });

    const sum = a + b;
    frame.state = 'done';
    frame.note = fill(data.frame.noteSum, { a, b, sum });
    snap('sum', { n: k, a, b, sum });
    stack.pop();
    return sum;
  }

  const result = fib(n, data.frame.retFirst, 1);
  // 收尾：栈空，回到 main
  out.push({
    line: stepById('done').line,
    text: fill(stepById('done').text, { n, sum: result, depth: maxDepth, calls }),
    stack: [],
  });
  return out;
}

/* ---------- 2. 每步渲染：解说条、行高亮、栈帧、计数（d1 独有） ---------- */

/**
 * 在已高亮的行内圈出「即将执行的调用」——难点 1 的二次突出，d1 专有。
 * 公共的代码面板只负责整行高亮，行内怎么标由本页决定。
 * @param {HTMLElement|null} li   当前行元素（codePanel.paint 的返回值）
 * @param {string} [call]         即将执行的调用表达式，如 "fib(n - 1)"；没有就不画框
 */
function markCall(li, call) {
  if (!li || !call) return;

  const body = li.firstElementChild;
  const text = li.dataset.text;
  // 用 indexOf 定位而不是写死列号：JSON 里改了写法，框会自动退化成普通文本
  const at = text.indexOf(call);
  if (at < 0) return;

  body.replaceChildren(
    document.createTextNode(text.slice(0, at)),
    make('span', 'call', call),                      // 虚线框
    document.createTextNode(text.slice(at + call.length)),
  );
}

/** 按第 i 步重画一次画面（不做压栈/弹栈计算，只画快照） */
function renderStep(i) {
  const step = steps[i];
  if (!step) return;

  el.narration.textContent = step.text;
  el.counter.textContent = `第 ${i + 1} / ${steps.length} 步`;

  // 代码区：公共面板做整行高亮，再叠一层 d1 的调用框
  markCall(codePanel.paint(step.line), step.call);

  // 栈帧：stack 按「栈底 → 栈顶」存放，CSS 用 column-reverse 让栈顶显示在上方
  el.stack.replaceChildren();
  step.stack.forEach((frame, depth) => {
    const li = make('li', `frame state-${frame.state}`);
    if (depth === step.stack.length - 1) li.classList.add('top'); // 栈顶加标记
    li.style.setProperty('--h', 210 + depth * 8); // 越深色相越冷（蓝 → 靛）
    li.style.setProperty('--l', 97 - depth * 2);  // 越深底色越实，层次一眼可分

    const head = make('div', 'frame-head');
    head.append(
      make('b', '', `fib(n=${frame.n})`),                            // 每帧自己那份 n
      make('span', 'badge', labels[frame.state] || frame.state),     // 状态徽章
    );
    li.append(
      head,
      make('p', 'frame-note', frame.note),       // 局部状态
      make('p', 'frame-ret', `↩ ${frame.ret}`),  // 返回地址
    );
    el.stack.append(li);
  });

  el.depth.textContent = `栈深 ${step.stack.length}`;
  el.prevBtn.disabled = i === 0;
  el.nextBtn.disabled = i === steps.length - 1;
}

/* ---------- 3. 图例：难点 1 画面右下角的三色说明（d1 独有） ---------- */

/**
 * 渲染图例：状态色块 + 中文名。
 * 开题说明里只有难点 1 的画面含图例，所以它不属于公共组件。
 * @returns {object} 「状态 → 中文名」映射，帧上的徽章直接复用，不再写第二份中文
 */
function renderLegend(items) {
  el.legend.replaceChildren();
  const map = {};
  items.forEach(({ state, label }) => {
    map[state] = label;
    el.legend.append(make('span', `chip state-${state}`, label));
  });
  return map;
}

/* ---------- 4. 播放器：状态机在 common.js，这里只把画面接上 ---------- */

const player = createPlayer({
  interval: PLAY_INTERVAL,
  onStep: renderStep,
  onPlayState: (playing) => { el.playBtn.textContent = playing ? '暂停' : '播放'; },
});

/** 换 n：整条序列重新生成，并从第 1 步开始（开题说明：改 n 后重新生成调用序列） */
function rebuild(n) {
  currentN = n;
  el.paramInput.value = n;    // 输入框与当前序列保持同步
  steps = buildTrace(n);
  player.load(steps.length);  // 内部会停播并回到第 1 步
}

/* ---------- 5. 绑定事件（d1 的控件语义） ---------- */

function bindEvents() {
  $$('[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      if (act === 'play') return player.toggle();
      player.pause(); // 其它操作先停下自动播放
      if (act === 'prev') player.prev();
      if (act === 'next') player.next();
      if (act === 'reset') { player.goTo(0); el.status.textContent = ''; }
    });
  });

  // 改 n：合法就重算序列，非法就退回上一次的值
  el.paramInput.addEventListener('change', () => {
    const n = Number(el.paramInput.value);
    const { min, max } = data.param;
    if (!Number.isInteger(n) || n < min || n > max) {
      el.paramInput.value = currentN;
      el.status.textContent = `n 请填 ${min}–${max} 之间的整数。`;
      return;
    }
    el.status.textContent = '';
    rebuild(n);
  });
}

/* ---------- 6. 启动 ---------- */

async function init() {
  try {
    data = await loadData(DATA_URL); // await 之后 data 才可用，下面的代码不会早于它执行
  } catch (err) {
    // 数据没到位时给一条按顺序自查的提示，避免白屏找不到原因
    el.status.classList.add('error');
    el.status.textContent =
      `数据没加载成功（${err.message}）。按顺序查：控制台报错 → 地址栏是不是 http:// 打开 → 路径与文件名是否为 data/d1.json。`;
    return;
  }

  el.title.textContent = data.title;
  el.summary.textContent = data.summary;

  codePanel.render(data.code);
  // 代码区右上角那行小字也来自数据，顺便说明虚线框的含义
  const hint = $('.muted', el.code.closest('.panel'));
  hint.classList.add('code-hint');
  hint.textContent = data.codeHint;
  hint.title = data.codeHint; // 窄屏被省略时可悬停看全

  labels = renderLegend(data.legend); // 图例文字来自 JSON，同时得到徽章用的中文名
  renderParam({ label: el.paramLabel, input: el.paramInput, hint: el.hint }, data.param);
  bindEvents();
  rebuild(data.param.default); // 按 JSON 里的默认 n 生成第一条序列
}

init();
