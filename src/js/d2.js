const DATA_FILE = 'data/d2.json';
const DATA_URL = `../${DATA_FILE}`; // d2.html 在 src/，数据在 data/，故回退一层
const SVG_NS = 'http://www.w3.org/2000/svg';
// 程序自己往下跑时每步停留。620ms 时一屏还没看完就跳走了，改成 1.1 秒：
// 一个字看代码、一个字看栈，正好够。到 return 点仍然会停下等人作答。
const AUTO_MS = 1100;
const PACE_SEC = (AUTO_MS / 1000).toFixed(1);
// 两处调用点都在第 3 行：行内下划线与返回地址连线都指着这一行
const CALL_LINE = 3;

/** 一次性抓取页面要用到的元素 */
const el = {
  title: $('#title'),
  summary: $('#summary'),
  narration: $('#narration'),
  code: $('#code'),
  codeHint: $('#code-hint'),
  stack: $('#stack'),
  depth: $('#depth'),
  asm: $('#assembly'),
  asmHint: $('#asm-hint'),
  lines: $('#back-lines'),
  stage: $('#stage'),
  counter: $('#counter'),
  runFlag: $('#run-flag'),
  status: $('#status'),
  hint: $('#hint'),
  streak: $('#streak'),
  wrong: $('#wrong'),
  quiz: $('#quiz'),
  quizTopic: $('#quiz-topic'),
  quizCopy: $('#quiz-copy'),
  options: $('#options'),
  confirm: $('#confirm'),
  feedback: $('#quiz-feedback'),
  paramLabel: $('#param-label'),
  paramInput: $('#param-input'),
  hintToggle: $('#hint-toggle'),
  hintLabel: $('#hint-label'),
  startBtn: $('#start-btn'),
  restartBtn: $('#restart-btn'),
  backBtn: $('#back-btn'),
  replayBtn: $('#replay-btn'),
  replayPanel: $('#replay-panel'),
  replayBody: $('#replay-body'),
  replayHint: $('#replay-hint'),
  flyLayer: $('#fly-layer'),
};

let data = null;         // 整份 JSON
let steps = [];          // 当前 n 的步骤序列（含判定题步骤）
let returns = [];        // 每次「子帧 → 父帧」的返回事件，回溯路径回放用
let currentN = 3;
let streak = 0;          // 连对次数
let wrongCount = 0;      // 本题已错次数
let showHint = true;     // 是否显示返回地址（帧上的「↩」与指向代码的连线）
let quiz = null;         // 当前判定题状态：{ ask, answered, selected, tryCount }
let ceTimer = null;      // 反例的自动关闭定时器
let autoTimer = null;    // 「程序自己往下跑」的定时器
let started = false;     // 是否已按下「开始演示」：没按就一直停在第一步
let askTotal = 0;        // 当前 n 下共有多少次返回判定

const stepById = (id) => data.steps.find((s) => s.id === id);
const codePanel = createCodePanel(el.code);

/* ---------- 1. 生成整条「执行 + 判定」序列（d2 独有） ---------- */

/**
 * 模拟 fib(n)，把每次入栈、等待、返回都记成一条步骤；
 * 每次「子调用把值交回父层」之前额外插一条判定题步骤。
 *
 * 与 d1 的关键差别：d2 的每一步除了栈快照，还要带上「组装台此刻画哪一条式子」，
 * 因为这一页只画一条正在组装的式子，而不是把整座栈再列一遍。
 *
 * @param {number} n 递归参数
 * @returns {{steps: Array, returns: Array, calls: number}}
 */
function buildTrace(n) {
  const out = [];
  const stack = [];
  const events = [];
  let askIndex = 0;
  let calls = 0;

  const copyStack = () => stack.map((f) => ({ ...f }));

  /**
   * 组装台画哪一帧：
   * 栈顶就是这一屏的主角；但如果栈顶刚算完一个基线值（a/b 都还是空），
   * 真正该看的是等它的父帧——那个值正要落进父帧的槽里。
   */
  const focusFrame = () => {
    const top = stack[stack.length - 1];
    if (!top) return null;
    if (top.state === 'done' && top.a == null && stack.length > 1) return stack[stack.length - 2];
    return top;
  };

  /**
   * 把焦点帧拼成一条式子。
   * 这里不标「哪个槽要填」——那是答案；等用户指对了，由 confirmAnswer 点亮再投递。
   */
  const assemblyOf = (force = null) => {
    const f = force || focusFrame();
    if (!f) return null;

    return {
      n: f.n,
      depth: f.depth,
      a: f.a,
      b: f.b,
      state: f.state,
      value: f.value,
      note: f.note, // 这一帧自己的状态说明，卡片上和组装台上说的是同一件事
      more: stack.indexOf(f), // 比它更浅、还在等的层数
    };
  };

  const push = (id, vars, { ask = null } = {}) => {
    const tpl = stepById(id);
    out.push({
      line: tpl.line,
      site: tpl.site ?? null,      // 当前正在执行哪一处调用点，用来在代码行里划下划线
      text: fill(tpl.text, vars),
      stack: copyStack(),
      // 出题时子帧还挂在栈顶，但题目问的是父帧的槽，所以焦点要显式指定
      assembly: assemblyOf(ask ? stack[stack.length - 2] : null),
      ask,
    });
  };

  /** 插一道判定题：子帧刚算出 value，问它该回到代码的哪一处 */
  function ask(k, depth, value, slot, childN) {
    askIndex += 1;

    // 子帧先标成已返回，卡片上显示 return value，但留在栈里等判定
    const child = stack[stack.length - 1];
    child.state = 'done';
    child.value = value;

    const side = slot === 'left' ? '加号左侧' : '加号右侧';
    const slotName = slot === 'left' ? data.assembly.aLabel : data.assembly.bLabel;
    const vars = { k, value, child: childN, line: CALL_LINE, side, slotName };

    // 选项顺序按题号轮换：正确项的位置会变，避免记位置蒙对
    const ids = data.options.map((o) => o.id);
    const shift = (askIndex - 1) % ids.length;
    const options = ids.slice(shift).concat(ids.slice(0, shift)).map((id) => {
      const option = data.options.find((item) => item.id === id);
      return {
        id,
        where: fill(data.optionWhere, { line: option.line, label: option.label }),
        code: option.code,
      };
    });

    push('ask', { child: childN, value }, {
      ask: {
        index: askIndex, k, value, childN, slot, side, slotName, line: CALL_LINE,
        childDepth: depth + 1,
        parentDepth: depth,
        options,
        feedback: {
          correct: fill(data.ask.feedback.correct, vars),
          restart: fill(data.ask.feedback.restart, vars),
          leftWrong: fill(data.ask.feedback.leftWrong, vars),
          rightWrong: fill(data.ask.feedback.rightWrong, vars),
        },
      },
    });

    events.push({ fromN: childN, toN: k, value, slot, side, sideShort: slot === 'left' ? '左' : '右', line: CALL_LINE, depth: depth + 1 });
  }

  // 真递归：与代码逐行对应；弹栈动作交给调用方（判完、填槽之后再弹）
  function fib(k, ret, depth) {
    calls += 1;

    const frame = {
      n: k, depth, a: null, b: null, value: null, state: 'run', ret, pending: null,
      note: fill(data.frame.noteEnter, {}),
    };
    stack.push(frame);
    push(depth === 1 ? 'enter' : 'push', { n: k, depth, ret });

    // 基线
    if (k <= 1) {
      frame.state = 'done';
      frame.value = k;
      frame.note = fill(data.frame.noteBase, { value: k });
      push('base', { n: k, value: k });
      return k;
    }

    // 左槽 fib(k-1)
    frame.state = 'wait';
    frame.pending = k - 1;
    frame.note = fill(data.frame.noteWaitLeft, { m: k - 1 });
    push('callLeft', { n: k, m: k - 1 });

    const a = fib(k - 1, data.frame.retLeft, depth + 1);
    ask(k, depth, a, 'left', k - 1);
    frame.a = a;
    stack.pop(); // 判定完成，子帧出栈
    frame.state = 'run';
    frame.pending = null;
    frame.note = fill(data.frame.noteFillLeft, { a, m: k - 2 });
    push('fillLeft', { n: k, m: k - 1, m2: k - 2, value: a });

    // 右槽 fib(k-2)
    frame.state = 'wait';
    frame.pending = k - 2;
    frame.note = fill(data.frame.noteWaitRight, { a, m: k - 2 });
    push('callRight', { n: k, m: k - 2, a });

    const b = fib(k - 2, data.frame.retRight, depth + 1);
    ask(k, depth, b, 'right', k - 2);
    frame.b = b;
    stack.pop();
    frame.state = 'run';
    frame.pending = null;
    frame.note = fill(data.frame.noteFillRight, { a, b });
    push('fillRight', { n: k, a, b });

    const sum = a + b;
    frame.state = 'done';
    frame.value = sum;
    frame.note = fill(data.frame.noteSum, { a, b, sum });
    push('sum', { n: k, a, b, sum });
    return sum;
  }

  const result = fib(n, data.frame.retMain, 1);
  stack.pop(); // 根帧也出栈

  const doneTpl = stepById('done');
  out.push({
    line: doneTpl.line,
    site: null,
    text: fill(doneTpl.text, { n, value: result, calls, asks: askIndex }),
    stack: [],
    assembly: null,
    ask: null,
  });
  events.push({ fromN: n, toN: null, value: result, slot: 'main', side: '', sideShort: '', line: CALL_LINE, depth: 1 });

  return { steps: out, returns: events, calls, maxDepth: n };
}

/* ---------- 2. 代码区：两处调用点常驻包在 span 里，好让连线有落点 ---------- */

const CALL_SITES = [
  { site: 'left', text: 'fib(n - 1)' },
  { site: 'right', text: 'fib(n - 2)' },
];

/**
 * 重画代码区：整行高亮交给公共面板，本页只在其上叠「调用点」。
 * 两处调用点永远包着 span（返回地址的连线以它们为锚），
 * 正在执行的那一处再加 .now——这是 d2 自己的装饰，d1 用的是虚线框。
 */
function paintCode(line, activeSite) {
  const row = codePanel.paint(line); // 顺带把上一页留下的行内标记复位

  if (!row || line !== CALL_LINE) return;

  const body = row.firstElementChild;
  const raw = row.dataset.text;
  const parts = [];
  let cursor = 0;
  CALL_SITES.forEach(({ site, text }) => {
    const at = raw.indexOf(text, cursor);
    if (at < 0) return;
    if (at > cursor) parts.push(document.createTextNode(raw.slice(cursor, at)));
    const span = make('span', site === activeSite ? 'site now' : 'site', text);
    span.dataset.site = site;
    parts.push(span);
    cursor = at + text.length;
  });
  if (cursor < raw.length) parts.push(document.createTextNode(raw.slice(cursor)));
  body.replaceChildren(...parts);
}

/* ---------- 3. 画面：栈帧、组装台、返回地址连线 ---------- */

const stateLabel = (state) => data.states[state] || state;

/** 栈帧：每张卡上单列一行返回地址，被问的那一层额外标一下 */
function renderStack(frames, ask) {
  el.stack.classList.toggle('no-hint', !showHint);
  el.stack.replaceChildren();

  frames.forEach((frame, idx) => {
    const li = make('li', `frame state-${frame.state}`);
    li.dataset.depth = frame.depth; // 飞行动画与连线都按深度定位
    li.dataset.state = frame.state;
    if (idx === frames.length - 1) li.classList.add('top');
    if (ask && frame.depth === ask.parentDepth) li.classList.add('is-asked');
    li.style.setProperty('--h', 210 + idx * 8);
    li.style.setProperty('--l', 97 - idx * 2);

    const head = make('div', 'frame-head');
    head.append(
      make('b', '', `fib(n=${frame.n})`),
      make('span', 'badge', stateLabel(frame.state)),
    );
    li.append(head, make('p', 'frame-note', frame.note), make('p', 'frame-ret', `↩ ${frame.ret}`));
    if (frame.state === 'done' && frame.value != null) {
      li.append(make('p', 'frame-value', `return ${frame.value}`));
    }
    el.stack.append(li);
  });
}

/** 一个槽位小方块：有值填数字，没值写「待填」；side 用来在投递时点亮目标槽 */
function slotChip(side, label, value) {
  const chip = make('span', 'slot');
  if (value == null) chip.classList.add('wait');
  else chip.classList.add('filled');
  chip.dataset.side = side;
  chip.append(make('i', '', label), make('b', '', value == null ? data.assembly.waiting : String(value)));
  return chip;
}

/** 组装台：只有一条式子，槽位就摆在眼前，返回值直接飞进空着的那一格 */
function renderAssembly(a) {
  el.asm.replaceChildren();
  if (!a) {
    el.asm.append(make('p', 'asm-idle', data.assembly.idle));
    return;
  }

  const head = make('div', 'asm-head');
  head.append(
    make('b', '', `fib(n=${a.n})`),
    make('span', 'asm-depth', fill(data.assembly.depth, { depth: a.depth })),
  );

  const eq = make('div', 'asm-eq');
  eq.append(
    make('span', 'asm-lhs', `fib(${a.n})`),
    make('span', 'asm-eq-sign', '='),
    slotChip('left', data.assembly.aLabel, a.a),
    make('span', 'asm-plus', '+'),
    slotChip('right', data.assembly.bLabel, a.b),
  );
  // 两槽填满、本层算完：式子的结尾补上结果，组装台就真的「组装完成」了
  if (a.state === 'done' && a.value != null) {
    eq.append(make('span', 'asm-eq-sign', '='), make('span', 'asm-result', String(a.value)));
  }

  el.asm.append(head, eq, make('p', 'asm-note', a.note));
  if (a.more > 0) el.asm.append(make('p', 'asm-more', fill(data.assembly.more, { n: a.more })));
}

/**
 * 返回地址连线：把「被问的那一层」卡上的「↩」牵到代码的对应行。
 *
 * 只画这一条——每层都画会在窄缝里挤成一根粗线，反而看不清。
 * 出题时才出现，正好回答「它回到哪一行」。
 * 根帧的返回地址在 main 里（这一页没有 main 的代码行），所以不牵线。
 */
function drawBackLines() {
  const box = el.stage.getBoundingClientRect();
  el.lines.setAttribute('width', Math.round(box.width));
  el.lines.setAttribute('height', Math.round(box.height));
  el.lines.setAttribute('viewBox', `0 0 ${box.width} ${box.height}`);
  el.lines.replaceChildren();

  // 窄屏三栏塌成一栏，横跨半页的线只会添乱：这时靠帧上的「↩」文字
  if (!showHint || window.innerWidth <= 1000) return;

  const frame = el.stack.querySelector('.frame.is-asked');
  const panel = el.code.closest('.panel');
  const row = el.code.children[CALL_LINE - 1];
  if (!frame || !panel || !row) return;
  if (Number(frame.dataset.depth) <= 1) return; // 根帧返回的是 main，不是这一页里的某行

  const ret = frame.querySelector('.frame-ret'); // 连线的起点就是卡上那行「↩ 第3行 …」
  if (!ret) return;

  const retBox = ret.getBoundingClientRect();
  const rowBox = row.getBoundingClientRect();
  const panelBox = panel.getBoundingClientRect();

  const x0 = retBox.left - box.left - 4;
  const y0 = retBox.top - box.top + retBox.height / 2;
  const endX = panelBox.right - box.left - 5;
  const y1 = rowBox.top - box.top + rowBox.height / 2;
  const bend = Math.max(18, (x0 - endX) * 0.6);

  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', `M ${x0} ${y0} C ${x0 - bend} ${y0}, ${endX + bend} ${y1}, ${endX} ${y1}`);
  path.setAttribute('class', 'back-line');
  el.lines.append(path);

  const dot = document.createElementNS(SVG_NS, 'circle');
  dot.setAttribute('cx', endX);
  dot.setAttribute('cy', y1);
  dot.setAttribute('r', 4.5);
  dot.setAttribute('class', 'back-dot');
  el.lines.append(dot);
}

function updateScore() {
  el.streak.textContent = fill(data.score.streak, { n: streak });
  el.wrong.textContent = fill(data.score.wrong, { n: wrongCount });
}

/** 进度按「第几次返回判定」算，不按步骤算——这一页的单位是判定，不是步 */
function updateProgress() {
  const before = steps.filter((s, i) => s.ask && i < player.index).length;
  const onAsk = steps[player.index] && steps[player.index].ask ? 1 : 0;
  el.counter.textContent = fill(data.score.progress, { done: before + onAsk, total: askTotal });
}

/* ---------- 4. 判定区：出题、指认位置、对错反馈 ---------- */

/** 选项渲染成「代码位置」而不是一句中文：学生读的是代码，不是描述 */
function renderOptions(options) {
  el.options.replaceChildren();
  options.forEach((option) => {
    const btn = make('button', 'option');
    btn.type = 'button';
    btn.dataset.option = option.id;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-checked', 'false');

    const where = make('span', 'opt-where', option.where);
    const code = make('code', 'opt-code');

    // 数据里用 [[...]] 圈出「回到这里」的那一段，这里拆成标记
    option.code.split(/\[\[|\]\]/).forEach((piece, i) => {
      if (!piece) return;
      code.append(i % 2 ? make('em', '', piece) : document.createTextNode(piece));
    });

    btn.append(where, code);
    btn.addEventListener('click', () => selectOption(btn, option.id));
    el.options.append(btn);
  });
}

function renderQuiz(ask) {
  hideCounterExample(); // 换题时把上一题的反例撤掉
  quiz = { ask, answered: false, selected: null, tryCount: 0 };
  el.quiz.hidden = false;
  el.quizTopic.textContent = fill(data.ask.topic, { index: ask.index });
  el.quizCopy.textContent = fill(data.ask.copy, { child: ask.childN, value: ask.value });
  renderOptions(ask.options);

  el.confirm.disabled = false;
  el.feedback.textContent = '';
  el.feedback.className = 'feedback';
  el.status.textContent = data.ask.needAnswer;
}

function hideQuiz() {
  hideCounterExample();
  el.quiz.hidden = true;
  quiz = null;
  if (el.status.textContent === data.ask.needAnswer) el.status.textContent = '';
}

function selectOption(btn, id) {
  if (!quiz || quiz.answered) return;
  $$('.option', el.options).forEach((node) => {
    node.classList.toggle('selected', node === btn);
    node.setAttribute('aria-checked', String(node === btn));
    if (node !== btn) node.classList.remove('wrong'); // 上次选错的标记清掉，只留这一次的选择
  });
  quiz.selected = id;
}

/** 确认作答：对了放飞行，错了给一句解释；同一个知识误区连错两次就把正确答案标出来 */
function confirmAnswer() {
  if (!quiz || quiz.answered) return;

  const ask = quiz.ask;
  if (!quiz.selected) {
    el.feedback.textContent = data.ask.retry;
    el.feedback.className = 'feedback bad';
    return;
  }

  quiz.tryCount += 1;

  if (quiz.selected === ask.slot) {
    quiz.answered = true;
    hideCounterExample(); // 答对了，反例就该退场，别留在下面误导
    streak += 1;
    updateScore();
    el.confirm.disabled = true;
    el.feedback.textContent = ask.feedback.correct;
    el.feedback.className = 'feedback good';
    el.status.textContent = '';
    // 答对了才点亮目标槽——作答之前不标，才不会把答案圈给学生
    const slot = el.asm.querySelector(`.slot[data-side="${ask.slot}"]`);
    if (slot) slot.classList.add('target');
    // 飞行结束后由 fly() 把画面推到「槽位已填」那一步
    setTimeout(() => fly(ask), 420);
    return;
  }

  streak = 0;
  wrongCount += 1;
  updateScore();

  const wrongKey = quiz.selected === 'restart' ? 'restart' : quiz.selected === 'left' ? 'leftWrong' : 'rightWrong';
  el.feedback.textContent = ask.feedback[wrongKey];
  el.feedback.className = 'feedback bad';
  $(`[data-option="${quiz.selected}"]`, el.options).classList.add('wrong');

  if (quiz.selected === 'restart') {
    shakeFrame(ask);
    showCounterExample(ask);
  }
  if (quiz.tryCount >= 2) {
    // 连错两次就别再耗着了：把正确项标出来，但仍要用户自己点它、再确认
    $(`[data-option="${ask.slot}"]`, el.options).classList.add('reveal');
    el.feedback.textContent += ' ' + data.ask.reveal;
  }
  quiz.selected = null;
}

function shakeFrame(ask) {
  const node = el.stack.querySelector(`[data-depth="${ask.childDepth}"]`);
  if (!node) return;
  node.classList.add('shake');
  setTimeout(() => node.classList.remove('shake'), 720);
}

/* ---------- 5. 「回到函数开头」的反例演示 ---------- */

function hideCounterExample() {
  clearTimeout(ceTimer);
  const old = $('.counter-example', el.quiz);
  if (old) old.remove();
}

/**
 * 反例：返回函数开头会发生什么。
 * 贴在判定区里（不做浮层），这样不会盖住正在讲解的栈帧和组装台；
 * 四行依次淡入，表现「重算 → 又回到开头」。
 */
function showCounterExample(ask) {
  hideCounterExample();
  const box = make('div', 'counter-example');
  box.append(make('span', 'badge ce-badge', data.counterExample.badge), make('h3', 'ce-title', data.counterExample.title));

  const list = make('ol', 'ce-lines');
  data.counterExample.lines.forEach((line, i) => {
    const item = make('li', '', fill(line, { k: ask.k }));
    item.style.animationDelay = `${i * 0.16}s`;
    list.append(item);
  });
  box.append(list);

  const close = make('button', 'ghost', '知道了');
  close.type = 'button';
  close.addEventListener('click', hideCounterExample);
  box.append(close);

  el.quiz.append(box); // 接在「确认」之后：确认按钮不上移，视线不用回头找
  ceTimer = setTimeout(hideCounterExample, 9000);
}

/* ---------- 6. 返回值飞行动画（从子帧飞进组装台空着的那一格） ---------- */

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function fly(ask) {
  const from = el.stack.querySelector(`[data-depth="${ask.childDepth}"]`);
  const to = el.asm.querySelector('.slot.target');

  // 找不到落点（例如用户已经点走了）或系统要求减少动效：直接进下一步，不卡流程
  if (!from || !to || prefersReducedMotion() || !from.animate) {
    player.next();
    return;
  }

  const a = from.getBoundingClientRect();
  const b = to.getBoundingClientRect();
  const bubble = make('div', 'fly-bubble', String(ask.value));
  el.flyLayer.append(bubble);

  const w = bubble.offsetWidth;
  const h = bubble.offsetHeight;
  const x0 = a.left + a.width / 2 - w / 2;
  const y0 = a.top + a.height / 2 - h / 2;
  const x1 = b.left + b.width / 2 - w / 2;
  const y1 = b.top + b.height / 2 - h / 2;

  bubble.style.transform = `translate(${x0}px, ${y0}px)`;
  const anim = bubble.animate(
    [
      { transform: `translate(${x0}px, ${y0}px) scale(.8)`, opacity: 0 },
      { transform: `translate(${(x0 + x1) / 2}px, ${Math.min(y0, y1) - 34}px) scale(1.15)`, opacity: 1, offset: 0.45 },
      { transform: `translate(${x1}px, ${y1}px) scale(.92)`, opacity: 1 },
    ],
    { duration: 640, easing: 'cubic-bezier(.4,.05,.2,1)' },
  );

  anim.onfinish = () => {
    bubble.remove();
    player.next(); // 进入「槽位已填」的那一步
  };
}

/* ---------- 7. 回溯路径回放（SVG 折线，从最深帧依次回到 main） ---------- */

function svgNode(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  Object.entries(attrs).forEach(([key, value]) => node.setAttribute(key, value));
  return node;
}

/**
 * 画回溯路径：横轴是返回的先后顺序，纵轴是栈深。
 * 折线从最深的一层开始，每返回一次就向上抬一层，最后落到 main。
 */
function drawReplay() {
  el.replayBody.replaceChildren();
  if (!returns.length) return;

  const colW = 128;
  const rowH = 54;
  const padX = 92;
  const padTop = 36;
  const maxDepth = Math.max(...returns.map((e) => e.depth));
  const width = Math.max(720, padX * 2 + returns.length * colW);
  const height = padTop + maxDepth * rowH + 64;

  const x = (i) => padX + i * colW;
  const y = (depth) => padTop + depth * rowH;

  const svg = svgNode('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    class: 'replay-svg',
    role: 'img',
    'aria-label': data.replay.head,
  });

  // 层刻度：main 在最上，第 maxDepth 层在最下
  for (let d = 1; d <= maxDepth; d += 1) {
    svg.append(svgNode('line', { x1: padX - 14, y1: y(d), x2: width - 22, y2: y(d), class: 'replay-grid' }));
    const label = svgNode('text', { x: 8, y: y(d) + 4, class: 'replay-axis' });
    label.textContent = fill(data.replay.depthLabel, { depth: d });
    svg.append(label);
  }
  const mainLabel = svgNode('text', { x: 8, y: y(0) + 4, class: 'replay-axis replay-axis-main' });
  mainLabel.textContent = data.replay.main;
  svg.append(mainLabel);

  // 折线顶点：每个返回事件的起点；最后补一个 main 的落点
  const points = returns.map((e, i) => [x(i), y(e.depth)]);
  points.push([x(returns.length - 1), y(0)]);

  const line = svgNode('polyline', {
    points: points.map((p) => p.join(',')).join(' '),
    class: 'replay-line',
    fill: 'none',
  });
  svg.append(line);

  // 每个顶点：一个圆点 + 「谁返回了什么」，以及到下一层的段标签
  returns.forEach((e, i) => {
    const [px, py] = points[i];
    const dot = svgNode('circle', { cx: px, cy: py, r: 5.5, class: `replay-dot state-${e.slot}` });
    dot.style.animationDelay = `${i * 0.12}s`;
    svg.append(dot);

    const node = svgNode('text', { x: px, y: py - 12, class: 'replay-node' });
    node.textContent = fill(data.replay.node, { n: e.fromN, value: e.value });
    node.style.animationDelay = `${i * 0.12}s`;
    svg.append(node);

    const [nx, ny] = points[i + 1];
    const vertical = Math.abs(nx - px) < 24;
    const seg = svgNode('text', {
      x: vertical ? px + 12 : (px + nx) / 2,
      y: vertical ? (py + ny) / 2 + 4 : (py + ny) / 2 + 17,
      class: 'replay-seg',
      'text-anchor': vertical ? 'start' : 'middle',
    });
    seg.textContent = e.slot === 'main'
      ? data.replay.segmentMain
      : fill(data.replay.segment, { line: e.line, side: e.sideShort });
    seg.style.animationDelay = `${i * 0.12 + 0.08}s`;
    svg.append(seg);
  });

  el.replayBody.append(svg);

  // 折线用 dash 动画「走」一遍：长度要等插入文档后才量得到
  const total = line.getTotalLength();
  line.style.strokeDasharray = total;
  line.style.strokeDashoffset = total;
  requestAnimationFrame(() => {
    line.style.transition = 'stroke-dashoffset 1.6s ease-in-out';
    line.style.strokeDashoffset = 0;
  });
}

/* ---------- 8. 每步渲染：程序自己往下跑，到 return 点停住 ---------- */

/** 停掉自动推进，并把「运行中」标记熄掉 */
function stopAuto() {
  clearTimeout(autoTimer);
  autoTimer = null;
  el.runFlag.hidden = true;
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    autoTimer = null;
    el.runFlag.hidden = true;
    if (player.index >= steps.length - 1) return;
    player.next();
  }, AUTO_MS);
  el.runFlag.hidden = false; // 有定时器在跑 = 程序正在自己往下走
}

function renderStep(i) {
  const step = steps[i];
  if (!step) return;
  const atEnd = i === steps.length - 1;

  el.narration.textContent = step.text;
  paintCode(step.line, step.site);
  renderStack(step.stack, step.ask);
  renderAssembly(step.assembly);
  el.depth.textContent = `栈深 ${step.stack.length}`;
  updateProgress();

  // 「回到上一题」：本题之前还有判定就可用
  el.backBtn.disabled = !steps.slice(0, i).some((s) => s.ask);

  if (step.ask) {
    stopAuto();                // 到 return 点：停下来，等人作答
    renderQuiz(step.ask);
  } else {
    hideQuiz();
    // 没按「开始」就停在第 1 步；按过之后，没到卡点就继续往下跑
    if (atEnd || !started) stopAuto();
    else scheduleAuto();
  }

  // 连线要等布局落定才量得到坐标
  requestAnimationFrame(drawBackLines);
}

/* ---------- 9. 播放器、换 n、回到上一题 ---------- */

const player = createPlayer({ onStep: renderStep });

/**
 * 回到「还没开始」：停在第一步，把「开始演示」按钮亮出来。
 * 「重新开始」与换 n 都会回到这个状态——否则改个参数就悄悄跑起来，人会漏掉开头。
 */
function armStart(hint) {
  started = false;
  stopAuto();
  el.startBtn.hidden = false;
  el.startBtn.disabled = false;
  if (hint) el.status.textContent = hint; // 按钮换位置后，得有一句话说明下一步该按它
}

function startDemo() {
  if (started) return;
  started = true;
  el.startBtn.hidden = true;    // 已经开演，按钮让位给其它控件
  const step = steps[player.index];
  if (step && !step.ask && player.index < steps.length - 1) scheduleAuto();
}

function rebuild(n, { hint = false } = {}) {
  currentN = n;
  el.paramInput.value = n;
  const trace = buildTrace(n);
  steps = trace.steps;
  returns = trace.returns;
  askTotal = steps.filter((s) => s.ask).length;
  streak = 0;
  wrongCount = 0;
  updateScore();
  hideCounterExample();
  el.status.textContent = '';
  started = false;             // 先落闸再 load，免得 load 触发的那次渲染顺势排上自动推进
  player.load(steps.length);   // 回到第 1 步
  armStart(hint ? data.start.again : '');
  if (!el.replayPanel.hidden) drawReplay(); // 面板开着就跟着重画
}

/** 回到上一次判定：这一页的「回退」单位是一道题，不是一步 */
function goPrevAsk() {
  for (let i = player.index - 1; i >= 0; i -= 1) {
    if (steps[i].ask) { player.goTo(i); return; }
  }
}

/* ---------- 10. 事件 ---------- */

function bindEvents() {
  el.startBtn.addEventListener('click', startDemo);
  el.restartBtn.addEventListener('click', () => rebuild(currentN, { hint: true }));
  el.backBtn.addEventListener('click', goPrevAsk);
  el.confirm.addEventListener('click', confirmAnswer);

  // 换 n：重新生成整条序列，计分归零
  el.paramInput.addEventListener('change', () => {
    const n = Number(el.paramInput.value);
    const { min, max } = data.param;
    if (!Number.isInteger(n) || n < min || n > max) {
      el.paramInput.value = currentN;
      el.status.textContent = `n 请填 ${min}–${max} 之间的整数。`;
      return;
    }
    rebuild(n, { hint: true });
  });

  // 提示开关：连线与帧上的「↩」一起收起，难度立刻上来
  el.hintToggle.addEventListener('change', () => {
    showHint = el.hintToggle.checked;
    renderStack(steps[player.index] ? steps[player.index].stack : [], steps[player.index] ? steps[player.index].ask : null);
    drawBackLines();
    el.status.textContent = showHint ? '' : data.hintToggle.off;
  });

  // 回溯路径：第一次点开时画，之后每次点都重放动画
  el.replayBtn.addEventListener('click', () => {
    hideCounterExample();
    el.replayPanel.hidden = false;
    drawReplay();
    el.replayPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    el.replayBtn.textContent = data.replay.again;
  });

  // 窗口尺寸变了，连线的落点也跟着变
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(drawBackLines, 120);
  });
}

/* ---------- 11. 启动 ---------- */

async function init() {
  try {
    data = await loadData(DATA_URL);
  } catch (err) {
    showLoadError(el.status, err, DATA_FILE);
    return;
  }

  el.title.textContent = data.title;
  el.summary.textContent = data.summary;
  el.codeHint.textContent = data.codeHint;
  el.asmHint.textContent = data.assembly.hint;
  el.replayHint.textContent = data.replay.hint;
  el.replayBtn.textContent = data.replay.button;
  el.hintLabel.textContent = data.hintToggle.label;
  el.startBtn.textContent = data.start.button;
  el.startBtn.title = fill(data.start.hint, { pace: PACE_SEC }); // 节奏说明收进 title，不占版面
  el.runFlag.textContent = data.start.running;
  el.runFlag.title = data.start.runningTitle; // 小标签只留「运行中」，细节放 title 里

  codePanel.render(data.code);
  renderParam({ label: el.paramLabel, input: el.paramInput, hint: el.hint }, data.param);
  updateScore();
  bindEvents();
  rebuild(data.param.default);

  // 字体换过之后代码行高会变，连线要按最终布局再量一次
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(drawBackLines);
}

init();